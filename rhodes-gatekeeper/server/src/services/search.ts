import type { AppContext } from '../context.js';
import type { AuditActor } from './audit.js';
import { toIso } from '../db/knex.js';
import { normalizeIdNumber } from '../security/crypto.js';
import { ID_KINDS } from '../files/naming.js';
import { likeEscaped, listFolders } from './files.js';

/**
 * One search box for the web app. Matches:
 *  - visitor name, company, delivery company, badge
 *  - Visitor ID (V1234 / 1234) and Group ID (G1001)
 *  - full Emirates ID / document number (matched by keyed hash — numbers are not stored in clear)
 *  - vehicle plate (ignoring spaces/dashes), PO and invoice numbers
 *  - folder names, file names and the OCR text of PO/invoice documents
 */
export async function search(ctx: AppContext, actor: AuditActor, raw: string) {
  const q = raw.trim().slice(0, 80);
  if (q.length < 2) return { query: q, visits: [], folders: [], files: [] };
  const like = likeEscaped(q);
  const L = "like ? escape '\\'";
  const compact = q.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const idDigits = normalizeIdNumber(q);
  const isIdNumber = /^784\d{12}$/.test(idDigits) || /^[A-Z]?\d{6,12}$/.test(idDigits);
  const visitRef = q.match(/^V-?(\d{1,9})$/i)?.[1] ?? (/^\d{1,9}$/.test(q) ? q : null);
  const groupRef = q.match(/^G-?(\d{1,9})$/i)?.[1];

  // Visits
  const vq = ctx.db('visits as v')
    .join('visitors as p', 'p.id', 'v.visitor_id')
    .leftJoin('employees as e', 'e.id', 'v.host_employee_id')
    .leftJoin('visit_groups as g', 'g.id', 'v.group_id')
    .select('v.id', 'v.reference_no', 'v.visit_type', 'v.status', 'v.checked_in_at', 'v.checked_out_at', 'v.badge_number', 'v.group_role',
      'p.full_name', 'p.company', 'p.id_number_masked', 'e.full_name as host', 'v.host_name_text', 'g.id as group_id', 'g.group_no', 'g.vehicle_plate', 'g.folder_name')
    .where((w) => {
      w.whereRaw(`lower(p.full_name) ${L}`, [like])
        .orWhereRaw(`lower(coalesce(p.company, '')) ${L}`, [like])
        .orWhereRaw(`lower(coalesce(v.delivery_company, '')) ${L}`, [like])
        .orWhereRaw(`lower(coalesce(v.badge_number, '')) ${L}`, [like]);
      if (visitRef) w.orWhere('v.reference_no', Number(visitRef));
      if (groupRef) w.orWhere('g.group_no', Number(groupRef));
      if (isIdNumber) w.orWhere('p.id_number_hash', ctx.ids.hash(q));
      if (compact.length >= 3) {
        w.orWhere('g.vehicle_plate_norm', 'like', `%${compact}%`)
          .orWhereRaw("upper(coalesce(g.po_number, '')) like ?", [`%${q.toUpperCase()}%`])
          .orWhereRaw("upper(coalesce(g.invoice_number, '')) like ?", [`%${q.toUpperCase()}%`]);
      }
    })
    .orderBy('v.checked_in_at', 'desc')
    .limit(50);
  const visits = (await vq).map((r: Record<string, any>) => ({
    id: r.id, referenceNo: Number(r.reference_no), visitType: r.visit_type, status: r.status,
    visitorName: r.full_name, company: r.company, idNumberMasked: r.id_number_masked, hostName: r.host ?? r.host_name_text ?? null,
    badgeNumber: r.badge_number, role: r.group_role, checkedInAt: toIso(r.checked_in_at), checkedOutAt: toIso(r.checked_out_at),
    groupId: r.group_id, groupNo: r.group_no ? Number(r.group_no) : null, vehiclePlate: r.vehicle_plate, folderName: r.folder_name,
  }));

  // Folders: direct Group ID hit first, then text matches, then the folders of any matched visits.
  const folders = [];
  if (groupRef) {
    const g = await ctx.db('visit_groups').where({ group_no: Number(groupRef) }).first();
    if (g) folders.push(...(await listFolders(ctx, { ids: [g.id], limit: 1 })).items);
  }
  folders.push(...(await listFolders(ctx, { q, limit: 30 })).items);
  const known = new Set(folders.map((f) => f.id));
  const extra = [...new Set(visits.map((v) => v.groupId).filter((id): id is string => !!id && !known.has(id)))].slice(0, 30);
  if (extra.length) folders.push(...(await listFolders(ctx, { ids: extra, limit: 30 })).items);

  // Files
  const fq = ctx.db('files as f')
    .join('visit_groups as g', 'g.id', 'f.group_id')
    .whereNull('f.deleted_at')
    .where((w) => {
      w.whereRaw(`lower(f.file_name) ${L}`, [like])
        .orWhereRaw(`lower(coalesce(f.doc_number, '')) ${L}`, [like])
        .orWhereRaw(`lower(coalesce(f.ocr_text, '')) ${L}`, [like]);
      if (compact.length >= 3) w.orWhere('g.vehicle_plate_norm', 'like', `%${compact}%`);
    })
    .select('f.id', 'f.group_id', 'f.visit_id', 'f.kind', 'f.file_name', 'f.mime', 'f.doc_number', 'f.created_at', 'g.folder_name', 'g.folder_path')
    .orderBy('f.created_at', 'desc')
    .limit(40);
  const files = (await fq).map((r: Record<string, any>) => ({
    id: r.id, groupId: r.group_id, visitId: r.visit_id, kind: r.kind, isIdImage: ID_KINDS.has(r.kind), fileName: r.file_name,
    mime: r.mime, docNumber: r.doc_number, createdAt: toIso(r.created_at), folderName: r.folder_name, folderPath: r.folder_path,
  }));

  // Searching by a full ID number is a lookup of sensitive data — record it (without the number).
  if (isIdNumber) await ctx.audit.log(actor, 'search.id_number', { type: 'search' }, { results: visits.length });
  return { query: q, visits, folders: dedupe(folders), files };
}

function dedupe<T extends { id: string }>(xs: T[]): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
}
