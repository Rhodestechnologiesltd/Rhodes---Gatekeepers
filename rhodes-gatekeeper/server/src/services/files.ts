import crypto from 'node:crypto';
import { z } from 'zod';
import type { Response } from 'express';
import { ZipArchive } from 'archiver';
import type { AppContext } from '../context.js';
import type { AuditActor } from './audit.js';
import { toBool, toIso } from '../db/knex.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { EXT, sniffMime } from '../files/store.js';
import { fileBaseName, ID_KINDS, type FileKind } from '../files/naming.js';
import { can, type Role } from '../domain/permissions.js';
import { getGroup, groupDto, type GroupDto } from './groups.js';

export const FILE_KINDS = ['id_front', 'id_back', 'plate', 'po', 'invoice', 'document'] as const;
const MAX_BYTES = 12 * 1024 * 1024;
/** Guards may add files to a group only shortly after check-in (resuming interrupted uploads). */
const UPLOAD_WINDOW_HOURS = 24;

export const uploadSchema = z.object({
  kind: z.enum(FILE_KINDS),
  visitId: z.string().max(36).optional().nullable(),
  dataBase64: z.string().min(16).max(Math.ceil((MAX_BYTES * 4) / 3) + 16),
  docNumber: z.string().trim().max(80).optional().nullable(),
  ocrText: z.string().max(20000).optional().nullable(),
});

export interface FileDto {
  id: string;
  groupId: string;
  visitId: string | null;
  kind: FileKind;
  isIdImage: boolean;
  fileName: string;
  folderName: string;
  folderPath: string;
  mime: string;
  sizeBytes: number;
  docNumber: string | null;
  sharepoint: string;
  uploadedBy: string | null;
  createdAt: string;
  visitorName?: string | null;
  visitorRef?: number | null;
}

function fileDto(r: Record<string, any>): FileDto {
  return {
    id: r.id,
    groupId: r.group_id,
    visitId: r.visit_id,
    kind: r.kind,
    isIdImage: ID_KINDS.has(r.kind),
    fileName: r.file_name,
    folderName: r.g_folder ?? r.folder_name,
    folderPath: r.g_path ?? r.folder_path,
    mime: r.mime,
    sizeBytes: Number(r.size_bytes),
    docNumber: r.doc_number,
    sharepoint: r.sp_status,
    uploadedBy: r.u_name ?? null,
    createdAt: toIso(r.created_at)!,
    visitorName: r.p_name ?? null,
    visitorRef: r.v_ref ? Number(r.v_ref) : null,
  };
}

function filesQuery(ctx: AppContext) {
  return ctx.db('files as f')
    .join('visit_groups as g', 'g.id', 'f.group_id')
    .leftJoin('visits as v', 'v.id', 'f.visit_id')
    .leftJoin('visitors as p', 'p.id', 'v.visitor_id')
    .leftJoin('users as u', 'u.id', 'f.uploaded_by')
    .whereNull('f.deleted_at')
    .select('f.*', 'g.folder_name as g_folder', 'g.folder_path as g_path', 'p.full_name as p_name', 'v.reference_no as v_ref', 'u.display_name as u_name');
}

// ------------------------------------------------------------------ upload (gate tablet)
export async function uploadFile(ctx: AppContext, actor: AuditActor, groupId: string, raw: unknown): Promise<{ file: FileDto; replayed: boolean }> {
  const input = uploadSchema.parse(raw);
  const settings = await ctx.settings.get();
  const g = await ctx.db('visit_groups').where({ id: groupId }).first();
  if (!g) throw notFound('Visit group');
  if (toBool(g.purged)) throw conflict('PURGED', 'This visit has been removed under the retention policy');
  if (ctx.now().getTime() - Date.parse(toIso(g.checked_in_at)!) > UPLOAD_WINDOW_HOURS * 3600_000) {
    throw conflict('UPLOAD_WINDOW_CLOSED', 'Files can only be added at the gate within 24 hours of check-in');
  }
  const isId = ID_KINDS.has(input.kind);
  if (isId && !settings.capture.storeIdImages) throw conflict('ID_IMAGES_DISABLED', 'Storing ID card images is switched off in Settings');

  let visit: Record<string, any> | null = null;
  if (input.visitId) {
    visit = (await ctx.db('visits as v').join('visitors as p', 'p.id', 'v.visitor_id').where({ 'v.id': input.visitId, 'v.group_id': groupId })
      .select('v.id', 'v.reference_no', 'v.group_role', 'p.full_name', 'p.id_document_type').first()) ?? null;
    if (!visit) throw badRequest('That visitor is not part of this visit');
  } else if (isId) {
    throw badRequest('visitId is required for identity-card images');
  }

  const data = Buffer.from(input.dataBase64.replace(/^data:[^,]+,/, ''), 'base64');
  if (data.length > MAX_BYTES) throw new AppError(413, 'TOO_LARGE', 'File is larger than 12 MB');
  const mime = sniffMime(data);
  if (!mime) throw badRequest('Unsupported file type — use a JPEG, PNG or PDF');
  if ((isId || input.kind === 'plate') && mime === 'application/pdf') throw badRequest('Use a photo (JPEG/PNG) for ID cards and number plates');
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');

  // Retried upload of the same bytes for the same slot → return the existing file.
  const same = await ctx.db('files').where({ group_id: groupId, kind: input.kind, sha256 }).modify((q) => {
    if (input.visitId) q.where({ visit_id: input.visitId });
  }).whereNull('deleted_at').first();
  if (same) return { file: fileDto({ ...same, folder_name: g.folder_name, folder_path: g.folder_path }), replayed: true };

  const docNumber = input.docNumber?.toUpperCase() || null;
  const ext = EXT[mime];
  const countQ = ctx.db('files').where({ group_id: groupId, kind: input.kind });
  if (isId) countQ.where({ visit_id: input.visitId });
  let index = Number((await countQ.count({ n: '*' }).first())?.n ?? 0) + 1;
  let fileName = '';
  for (;; index++) {
    fileName = fileBaseName({
      kind: input.kind, ext, index,
      visitorRef: visit ? Number(visit.reference_no) : undefined,
      visitorName: visit?.full_name, role: visit?.group_role, docType: visit?.id_document_type,
      plate: g.vehicle_plate, docNumber,
    });
    if (!(await ctx.db('files').where({ group_id: groupId, file_name: fileName }).first())) break;
  }
  const storagePath = `${g.folder_path}/${fileName}`;
  await ctx.files.put(storagePath, data);

  const id = crypto.randomUUID();
  const now = ctx.now().toISOString();
  try {
    await ctx.db.transaction(async (trx) => {
      await trx('files').insert({
        id, group_id: groupId, visit_id: input.visitId ?? null, kind: input.kind, file_name: fileName, storage_path: storagePath,
        mime, size_bytes: data.length, sha256, doc_number: docNumber,
        // OCR text is kept only for business documents (to make them searchable) — never for ID cards.
        ocr_text: ['po', 'invoice', 'document'].includes(input.kind) ? input.ocrText?.slice(0, 20000) ?? null : null,
        sp_status: ctx.sharepoint.enabled ? 'pending' : 'disabled',
        sp_attempts: 0, sp_next_attempt_at: ctx.sharepoint.enabled ? now : null,
        uploaded_by: actor.id, created_at: now,
      });
      if (docNumber && input.kind === 'po' && !g.po_number) await trx('visit_groups').where({ id: groupId }).update({ po_number: docNumber, updated_at: now });
      if (docNumber && input.kind === 'invoice' && !g.invoice_number) await trx('visit_groups').where({ id: groupId }).update({ invoice_number: docNumber, updated_at: now });
      await ctx.audit.log(actor, 'file.upload', { type: 'file', id }, { kind: input.kind, groupId, sizeBytes: data.length }, trx);
    });
  } catch (e) {
    await ctx.files.remove(storagePath).catch(() => undefined);
    throw e;
  }
  const row = await filesQuery(ctx).where('f.id', id).first();
  return { file: fileDto(row), replayed: false };
}

// ------------------------------------------------------------------ browse (web)
export interface FolderFilters { from?: string; to?: string; q?: string; type?: 'visitors' | 'vehicles'; ids?: string[]; limit?: number; offset?: number }

/** LIKE pattern with %, _ and \ escaped (use with "escape '\\'"). */
export const likeEscaped = (s: string) => `%${s.toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

export async function listFolders(ctx: AppContext, f: FolderFilters): Promise<{ items: GroupDto[]; total: number }> {
  const base = ctx.db('visit_groups as g');
  if (f.from) base.where('g.checked_in_at', '>=', f.from);
  if (f.to) base.where('g.checked_in_at', '<', f.to);
  if (f.type === 'vehicles') base.whereNotNull('g.vehicle_plate_norm').where('g.visit_type', 'delivery');
  if (f.type === 'visitors') base.where((w) => w.whereNot('g.visit_type', 'delivery').orWhereNull('g.vehicle_plate_norm'));
  if (f.ids) base.whereIn('g.id', f.ids);
  if (f.q) {
    const t = likeEscaped(f.q);
    const plate = f.q.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const L = "like ? escape '\\'";
    base.where((w) => {
      w.whereRaw(`lower(g.folder_name) ${L}`, [t])
        .orWhereRaw(`lower(coalesce(g.po_number, '')) ${L}`, [t])
        .orWhereRaw(`lower(coalesce(g.invoice_number, '')) ${L}`, [t])
        .orWhereRaw(`lower(coalesce(g.delivery_company, '')) ${L}`, [t])
        .orWhereExists(ctx.db('visits as v').join('visitors as p', 'p.id', 'v.visitor_id').whereRaw('v.group_id = g.id').whereRaw(`lower(p.full_name) ${L}`, [t]));
      if (plate.length >= 2) w.orWhere('g.vehicle_plate_norm', 'like', `%${plate}%`);
    });
  }
  const [{ n }] = (await base.clone().count({ n: '*' })) as { n: number | string }[];
  const rows = await base.clone()
    .leftJoin('employees as e', 'e.id', 'g.host_employee_id')
    .leftJoin('departments as d', 'd.id', 'g.department_id')
    .leftJoin('users as u', 'u.id', 'g.checked_in_by')
    .select('g.*', 'e.full_name as e_name', 'd.name as d_name', 'u.display_name as u_name')
    .orderBy('g.checked_in_at', 'desc')
    .limit(Math.min(f.limit ?? 50, 200))
    .offset(f.offset ?? 0);
  const ids = rows.map((r: Record<string, any>) => r.id);
  const counts = ids.length
    ? await ctx.db('visits').whereIn('group_id', ids).groupBy('group_id').select('group_id', ctx.db.raw('count(*) as n'), ctx.db.raw("sum(case when status = 'on_site' then 1 else 0 end) as onsite"))
    : [];
  const leads = ids.length
    ? await ctx.db('visits as v').join('visitors as p', 'p.id', 'v.visitor_id').whereIn('v.group_id', ids).where('v.group_position', 1).select('v.group_id', 'p.full_name')
    : [];
  const files = ids.length
    ? await ctx.db('files').whereIn('group_id', ids).whereNull('deleted_at').groupBy('group_id', 'kind').select('group_id', 'kind', ctx.db.raw('count(*) as n'))
    : [];
  return {
    total: Number(n),
    items: rows.map((r: Record<string, any>) => {
      const c = counts.find((x: Record<string, any>) => x.group_id === r.id);
      return groupDto(r, {
        n: Number(c?.n ?? 0), onsite: Number(c?.onsite ?? 0),
        lead: leads.find((x: Record<string, any>) => x.group_id === r.id)?.full_name ?? null,
        files: files.filter((x: Record<string, any>) => x.group_id === r.id) as { kind: string; n: number }[],
      });
    }),
  };
}

export async function getFolder(ctx: AppContext, groupId: string) {
  const group = await getGroup(ctx, groupId);
  const files = (await filesQuery(ctx).where('f.group_id', groupId).orderBy([{ column: 'f.kind' }, { column: 'f.file_name' }])).map(fileDto);
  return { group, files };
}

export async function getFileForUser(ctx: AppContext, actor: AuditActor & { role: Role }, fileId: string, purpose: 'view' | 'download') {
  const row = await filesQuery(ctx).where('f.id', fileId).first();
  if (!row) throw notFound('File');
  const isId = ID_KINDS.has(row.kind);
  if (isId ? !can(actor.role, 'files.view_id') : !can(actor.role, 'files.view')) {
    throw forbidden(isId ? 'Only managers and administrators can open identity-card images' : undefined);
  }
  if (isId) await ctx.audit.log(actor, 'file.view_id', { type: 'file', id: fileId }, { groupId: row.group_id, purpose });
  const data = await ctx.files.get(row.storage_path);
  return { data, file: fileDto(row) };
}

/** Stream a whole visit folder as a ZIP. ID images are included only for users allowed to see them. */
export async function streamFolderZip(ctx: AppContext, actor: AuditActor & { role: Role }, groupId: string, res: Response) {
  const { group, files } = await getFolder(ctx, groupId);
  const includeIds = can(actor.role, 'files.view_id');
  const chosen = files.filter((f) => includeIds || !f.isIdImage);
  await ctx.audit.log(actor, 'folder.download', { type: 'visit_group', id: groupId }, { files: chosen.length, includesIdImages: includeIds && chosen.some((f) => f.isIdImage) });
  res.set({
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${group.folderName}.zip"`,
    'Cache-Control': 'no-store',
  });
  const zip = new ZipArchive({ zlib: { level: 6 } });
  zip.on('error', (e: Error) => { ctx.log.error({ err: e.message }, 'zip error'); res.destroy(e); });
  zip.pipe(res);
  for (const f of chosen) {
    const row = await ctx.db('files').where({ id: f.id }).first();
    zip.append(await ctx.files.get(row.storage_path), { name: `${group.folderName}/${f.fileName}` });
  }
  await zip.finalize();
}

// ------------------------------------------------------------------ SharePoint sync (background)
const SP_MAX_ATTEMPTS = 10;
let syncing = false;

export async function processSharePointSync(ctx: AppContext, batch = 10): Promise<{ uploaded: number; deleted: number; failed: number }> {
  const out = { uploaded: 0, deleted: 0, failed: 0 };
  if (!ctx.sharepoint.enabled || syncing) return out;
  syncing = true;
  try {
    const now = ctx.now();
    const due = await ctx.db('files as f').join('visit_groups as g', 'g.id', 'f.group_id')
      .where('f.sp_status', 'pending').whereNull('f.deleted_at').where('f.sp_next_attempt_at', '<=', now.toISOString())
      .select('f.*', 'g.folder_path as g_path', 'g.sp_folder_item_id as g_sp').orderBy('f.created_at').limit(batch);
    for (const f of due) {
      const attempts = Number(f.sp_attempts) + 1;
      try {
        const data = await ctx.files.get(f.storage_path);
        const r = await ctx.sharepoint.upload(`${f.g_path}/${f.file_name}`, data, f.mime);
        await ctx.db('files').where({ id: f.id }).update({ sp_status: 'synced', sp_item_id: r.itemId, sp_attempts: attempts, sp_error: null, sp_synced_at: ctx.now().toISOString() });
        if (!f.g_sp && r.parentId) await ctx.db('visit_groups').where({ id: f.group_id }).update({ sp_folder_item_id: r.parentId });
        out.uploaded++;
      } catch (e) {
        const giveUp = attempts >= SP_MAX_ATTEMPTS;
        await ctx.db('files').where({ id: f.id }).update({
          sp_status: giveUp ? 'failed' : 'pending', sp_attempts: attempts, sp_error: String((e as Error).message).slice(0, 500),
          sp_next_attempt_at: giveUp ? null : new Date(now.getTime() + Math.min(2 ** attempts * 60_000, 6 * 3600_000)).toISOString(),
        });
        ctx.log.warn({ fileId: f.id, attempts }, 'SharePoint upload failed');
        out.failed++;
      }
    }
    const dels = await ctx.db('sp_deletions').where('next_attempt_at', '<=', now.toISOString()).limit(batch);
    for (const d of dels) {
      try {
        await ctx.sharepoint.deleteItem(d.item_id);
        await ctx.db('sp_deletions').where({ id: d.id }).del();
        out.deleted++;
      } catch (e) {
        const attempts = Number(d.attempts) + 1;
        await ctx.db('sp_deletions').where({ id: d.id }).update({
          attempts, last_error: String((e as Error).message).slice(0, 500),
          next_attempt_at: new Date(now.getTime() + Math.min(2 ** attempts * 60_000, 24 * 3600_000)).toISOString(),
        });
        out.failed++;
      }
    }
  } finally {
    syncing = false;
  }
  return out;
}

export async function syncStatus(ctx: AppContext) {
  const rows = await ctx.db('files').whereNull('deleted_at').groupBy('sp_status').select('sp_status', ctx.db.raw('count(*) as n'));
  const failed = (await filesQuery(ctx).where('f.sp_status', 'failed').orderBy('f.created_at', 'desc').limit(50)).map((r: Record<string, any>) => ({ ...fileDto(r), error: r.sp_error }));
  const pendingDeletes = Number((await ctx.db('sp_deletions').count({ n: '*' }).first())?.n ?? 0);
  return { enabled: ctx.sharepoint.enabled, counts: Object.fromEntries(rows.map((r: Record<string, any>) => [r.sp_status, Number(r.n)])), failed, pendingDeletes };
}

export async function retrySharePoint(ctx: AppContext) {
  return ctx.db('files').where({ sp_status: 'failed' }).whereNull('deleted_at').update({ sp_status: 'pending', sp_attempts: 0, sp_next_attempt_at: ctx.now().toISOString() });
}

/** Remove stored files (disk + queue SharePoint deletion). Used by retention. Names are scrubbed. */
export async function deleteFiles(ctx: AppContext, fileIds: string[], reason: string): Promise<number> {
  let n = 0;
  for (const id of fileIds) {
    const f = await ctx.db('files').where({ id }).whereNull('deleted_at').first();
    if (!f) continue;
    await ctx.files.remove(f.storage_path).catch(() => undefined);
    if (f.sp_item_id) await queueSpDeletion(ctx, f.sp_item_id);
    await ctx.db('files').where({ id }).update({
      deleted_at: ctx.now().toISOString(), file_name: `deleted-${id.slice(0, 8)}`, storage_path: '', ocr_text: null, doc_number: null,
      sp_status: 'deleted', sp_item_id: null, sp_error: reason.slice(0, 500),
    });
    n++;
  }
  return n;
}

export async function queueSpDeletion(ctx: AppContext, itemId: string) {
  await ctx.db('sp_deletions').insert({ id: crypto.randomUUID(), item_id: itemId, attempts: 0, next_attempt_at: ctx.now().toISOString(), created_at: ctx.now().toISOString() });
}
