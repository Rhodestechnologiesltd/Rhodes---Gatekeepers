import crypto from 'node:crypto';
import { z } from 'zod';
import type { Knex } from 'knex';
import type { AppContext } from '../context.js';
import type { AuditActor } from './audit.js';
import { toBool, toIso } from '../db/knex.js';
import { VISIT_TYPES, type VisitDto } from '../domain/types.js';
import { maskIdNumber, normalizeIdNumber } from '../security/crypto.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { groupFolder } from '../files/naming.js';
import { normalizePlate } from '../scanning/ocr.js';
import { queueGroupCheckInNotification, queueVisitNotifications } from './notifications.js';
import { getVisit, isUniqueViolation, listAllVisitsInRange, nextReferenceNo, required, trimmed } from './visits.js';

// ------------------------------------------------------------------ validation
const idSchema = z.object({
  documentType: z.enum(['emirates_id', 'passport', 'other', 'none']),
  status: z.enum(['scanned', 'manual', 'not_provided']),
  method: z.enum(['camera_ocr', 'camera_barcode', 'hardware_reader', 'manual']).optional().nullable(),
  number: trimmed(40),
  expiryDate: trimmed(10).refine((v) => !v || /^\d{4}-\d{2}-\d{2}$/.test(v), 'Expiry must be YYYY-MM-DD'),
});

const memberSchema = z.object({
  role: z.enum(['visitor', 'driver', 'helper']).optional(),
  fullName: required(160, 'Visitor name'),
  company: trimmed(160),
  phone: trimmed(40).refine((v) => !v || /^[+0-9 ()-]{5,40}$/.test(v), 'Phone number format is invalid'),
  nationality: trimmed(3).refine((v) => !v || /^[A-Za-z]{2,3}$/.test(v), 'Nationality must be a 2–3 letter code'),
  id: idSchema,
  badgeNumber: trimmed(40),
});

export const groupCheckInSchema = z
  .object({
    idempotencyKey: z.string().uuid('idempotencyKey must be a UUID'),
    visitType: z.enum(VISIT_TYPES),
    direction: z.enum(['delivery', 'collection']).optional().nullable(),
    visitors: z.array(memberSchema).min(1, 'Add at least one visitor').max(100),
    hostEmployeeId: trimmed(36),
    hostName: trimmed(160),
    departmentId: trimmed(36),
    purpose: trimmed(500),
    deliveryCompany: trimmed(160),
    salesReference: trimmed(80),
    vehiclePlate: trimmed(40),
    poNumber: trimmed(80),
    invoiceNumber: trimmed(80),
    notes: trimmed(1000),
    privacyNoticeAck: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    const add = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
    const hasHost = !!(v.hostEmployeeId || v.hostName);
    switch (v.visitType) {
      case 'meeting':
        if (!hasHost) add(['hostEmployeeId'], 'Select or enter the employee being visited');
        if (!v.purpose) add(['purpose'], 'Purpose of the meeting is required');
        break;
      case 'delivery':
        if (!v.deliveryCompany) add(['deliveryCompany'], 'Delivery company is required');
        if (!v.purpose) add(['purpose'], 'Delivery purpose is required');
        if (!hasHost && !v.departmentId) add(['departmentId'], 'Select the receiving employee or department');
        if (!v.vehiclePlate) add(['vehiclePlate'], 'Vehicle number plate is required');
        break;
      case 'other':
        if (!v.purpose) add(['purpose'], 'Please describe the reason for the visit');
        break;
    }
    const seen = new Map<string, number>();
    v.visitors.forEach((m, i) => {
      if (m.id.status !== 'not_provided') {
        if (m.id.documentType === 'none') add(['visitors', i, 'id', 'documentType'], 'Select the document type');
        if (!m.id.number) add(['visitors', i, 'id', 'number'], 'ID number is required when an ID is scanned or entered');
      }
      if (m.id.number && m.id.documentType === 'emirates_id' && !/^784\d{12}$/.test(normalizeIdNumber(m.id.number))) {
        add(['visitors', i, 'id', 'number'], 'Emirates ID number must be 15 digits starting with 784');
      }
      if (m.id.number && m.id.status !== 'not_provided') {
        const k = `${m.id.documentType}:${normalizeIdNumber(m.id.number)}`;
        if (seen.has(k)) add(['visitors', i, 'id', 'number'], `Same ID as visitor ${seen.get(k)! + 1} in this group`);
        else seen.set(k, i);
      }
    });
  });
export type GroupCheckInInput = z.infer<typeof groupCheckInSchema>;

// ------------------------------------------------------------------ DTO
export interface GroupDto {
  id: string;
  groupNo: number;
  visitType: string;
  direction: string | null;
  host: { employeeId: string | null; name: string | null } | null;
  department: { id: string; name: string } | null;
  purpose: string | null;
  deliveryCompany: string | null;
  salesReference: string | null;
  vehiclePlate: string | null;
  poNumber: string | null;
  invoiceNumber: string | null;
  notes: string | null;
  folderName: string;
  folderPath: string;
  purged: boolean;
  checkedInAt: string;
  checkedInBy: string | null;
  visitorCount: number;
  onSiteCount: number;
  fileCounts: Record<string, number>;
  leadName: string | null;
}

export async function getGroup(ctx: AppContext, id: string, db: Knex = ctx.db): Promise<GroupDto> {
  const r = await db('visit_groups as g')
    .leftJoin('employees as e', 'e.id', 'g.host_employee_id')
    .leftJoin('departments as d', 'd.id', 'g.department_id')
    .leftJoin('users as u', 'u.id', 'g.checked_in_by')
    .where('g.id', id)
    .select('g.*', 'e.full_name as e_name', 'd.name as d_name', 'u.display_name as u_name')
    .first();
  if (!r) throw notFound('Visit group');
  const counts = await db('visits').where({ group_id: id }).select(db.raw('count(*) as n'), db.raw("sum(case when status = 'on_site' then 1 else 0 end) as onsite")).first();
  const lead = await db('visits as v').join('visitors as p', 'p.id', 'v.visitor_id').where('v.group_id', id).orderBy('v.group_position').select('p.full_name').first();
  const fileRows = await db('files').where({ group_id: id }).whereNull('deleted_at').select('kind').count({ n: '*' }).groupBy('kind');
  return groupDto(r, { n: Number(counts?.n ?? 0), onsite: Number(counts?.onsite ?? 0), lead: lead?.full_name ?? null, files: fileRows as unknown as { kind: string; n: number }[] });
}

export function groupDto(r: Record<string, any>, extra: { n: number; onsite: number; lead: string | null; files: { kind: string; n: number | string }[] }): GroupDto {
  const hostName = r.e_name ?? r.host_name_text ?? null;
  return {
    id: r.id,
    groupNo: Number(r.group_no),
    visitType: r.visit_type,
    direction: r.direction ?? null,
    host: hostName || r.host_employee_id ? { employeeId: r.host_employee_id ?? null, name: hostName } : null,
    department: r.department_id ? { id: r.department_id, name: r.d_name } : null,
    purpose: r.purpose,
    deliveryCompany: r.delivery_company,
    salesReference: r.sales_reference,
    vehiclePlate: r.vehicle_plate,
    poNumber: r.po_number,
    invoiceNumber: r.invoice_number,
    notes: r.notes,
    folderName: r.folder_name,
    folderPath: r.folder_path,
    purged: toBool(r.purged),
    checkedInAt: toIso(r.checked_in_at)!,
    checkedInBy: r.u_name ?? null,
    visitorCount: extra.n,
    onSiteCount: extra.onsite,
    fileCounts: Object.fromEntries(extra.files.map((f) => [f.kind, Number(f.n)])),
    leadName: extra.lead,
  };
}

async function nextGroupNo(trx: Knex): Promise<number> {
  const r = await trx('visit_groups').max({ m: 'group_no' }).first();
  return Number(r?.m ?? 1000) + 1;
}

// ------------------------------------------------------------------ check-in
export interface GroupCheckInResult {
  group: GroupDto;
  visits: VisitDto[];
  replayed: boolean;
  warnings: string[];
  required: { visitId: string; kinds: string[] }[] | null;
}

export async function checkInGroup(ctx: AppContext, actor: AuditActor & { deviceId?: string | null }, raw: unknown): Promise<GroupCheckInResult> {
  const parsed = groupCheckInSchema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest('Please correct the highlighted fields', {
      fields: Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])),
    });
  }
  const input = parsed.data;
  const settings = await ctx.settings.get();
  const warnings: string[] = [];

  const replay = async (groupId: string): Promise<GroupCheckInResult> => ({
    group: await getGroup(ctx, groupId),
    visits: await listAllVisitsInRange(ctx, { groupId }).then((vs) => vs.sort((a, b) => (a.group?.position ?? 0) - (b.group?.position ?? 0))),
    replayed: true,
    warnings,
    required: null,
  });
  const existing = await ctx.db('visit_groups').where({ idempotency_key: input.idempotencyKey }).first();
  if (existing) return replay(existing.id);

  if (input.visitors.length > settings.capture.maxGroupSize) {
    throw badRequest(`A group can have at most ${settings.capture.maxGroupSize} people`, { fields: { visitors: 'Too many people' } });
  }
  input.visitors.forEach((m, i) => {
    if (settings.requireIdDocument && m.id.status === 'not_provided') {
      throw badRequest('An identity document is required by site policy', { fields: { [`visitors.${i}.id.status`]: 'Scan or enter an ID' } });
    }
  });
  if (settings.privacyNotice.enabled && settings.privacyNotice.requireAcknowledgement && !input.privacyNoticeAck) {
    throw badRequest('The visitor must acknowledge the privacy notice', { fields: { privacyNoticeAck: 'Required' } });
  }
  if (input.hostEmployeeId && !(await ctx.db('employees').where({ id: input.hostEmployeeId, active: true }).first())) {
    throw badRequest('Selected employee was not found', { fields: { hostEmployeeId: 'Not found' } });
  }
  if (input.departmentId && !(await ctx.db('departments').where({ id: input.departmentId, active: true }).first())) {
    throw badRequest('Selected department was not found', { fields: { departmentId: 'Not found' } });
  }

  // Nobody in the group may already be on site.
  const members = input.visitors.map((m, i) => {
    const idNumber = m.id.status === 'not_provided' ? undefined : m.id.number ?? undefined;
    const role = input.visitType === 'delivery' ? (i === 0 ? 'driver' : m.role === 'driver' ? 'driver' : 'helper') : 'visitor';
    return { m, i, idNumber, hash: idNumber ? ctx.ids.hash(idNumber) : null, role };
  });
  const hashes = members.map((x) => x.hash).filter(Boolean) as string[];
  if (hashes.length) {
    const open = await ctx.db('visits as v').join('visitors as p', 'p.id', 'v.visitor_id').whereIn('p.id_number_hash', hashes).where('v.status', 'on_site').select('v.id', 'v.reference_no', 'p.id_number_hash as h', 'p.full_name');
    if (open.length) {
      const first = open[0];
      const who = members.find((x) => x.hash === first.h)!;
      throw conflict('ALREADY_ON_SITE', `${input.visitors[who.i].fullName} is already checked in and has not checked out`, {
        visitId: first.id,
        referenceNo: Number(first.reference_no),
        visitorIndex: who.i,
        all: open.map((o) => ({ visitId: o.id, referenceNo: Number(o.reference_no), visitorIndex: members.find((x) => x.hash === o.h)!.i })),
      });
    }
  }

  const storeFull = ctx.ids.fullStorageAllowedByEnv && settings.storeFullIdNumber;
  const today = ctx.now().toISOString().slice(0, 10);
  members.forEach(({ m }) => {
    if (m.id.expiryDate && m.id.expiryDate < today) warnings.push(`${m.fullName}: identity document expiry date has passed.`);
  });

  const now = ctx.now().toISOString();
  const groupId = crypto.randomUUID();
  const plate = input.vehiclePlate ? input.vehiclePlate.toUpperCase().replace(/\s+/g, ' ').trim() : null;
  const folder = groupFolder({ visitType: input.visitType, plate, leadName: input.visitors[0].fullName, checkedInAt: now, zone: settings.timezone });
  const visitIds: string[] = [];

  for (let attempt = 0; attempt < 5; attempt++) {
    visitIds.length = 0;
    try {
      await ctx.db.transaction(async (trx) => {
        // Unique folder: add _2, _3 … if two groups arrive in the same minute with the same name/plate.
        let folderName = folder.name;
        let folderPath = folder.relDir();
        for (let n = 2; await trx('visit_groups').where({ folder_path: folderPath }).first(); n++) {
          folderName = `${folder.name}_${n}`;
          folderPath = folder.relDir(`_${n}`);
        }
        await trx('visit_groups').insert({
          id: groupId,
          group_no: await nextGroupNo(trx),
          visit_type: input.visitType,
          direction: input.visitType === 'delivery' ? input.direction ?? 'delivery' : null,
          host_employee_id: input.hostEmployeeId ?? null,
          host_name_text: input.hostEmployeeId ? null : input.hostName ?? null,
          department_id: input.departmentId ?? null,
          purpose: input.purpose ?? null,
          delivery_company: input.visitType === 'delivery' ? input.deliveryCompany ?? null : null,
          sales_reference: input.salesReference ?? null,
          vehicle_plate: plate,
          vehicle_plate_norm: plate ? normalizePlate(plate) : null,
          po_number: input.poNumber?.toUpperCase() ?? null,
          invoice_number: input.invoiceNumber?.toUpperCase() ?? null,
          notes: input.notes ?? null,
          folder_name: folderName,
          folder_path: folderPath,
          purged: false,
          checked_in_at: now,
          checked_in_by: actor.id,
          device_id: actor.deviceId ?? null,
          idempotency_key: input.idempotencyKey,
          created_at: now,
          updated_at: now,
        });
        let ref = await nextReferenceNo(trx);
        for (const { m, i, idNumber, hash, role } of members) {
          const visitorId = crypto.randomUUID();
          const visitId = crypto.randomUUID();
          visitIds.push(visitId);
          await trx('visitors').insert({
            id: visitorId,
            full_name: m.fullName,
            nationality: m.nationality?.toUpperCase() ?? null,
            company: m.company ?? (input.visitType === 'delivery' ? input.deliveryCompany ?? null : null),
            phone: m.phone ?? null,
            id_document_type: idNumber ? m.id.documentType : 'none',
            id_number_masked: maskIdNumber(idNumber),
            id_number_hash: hash,
            id_number_encrypted: storeFull && idNumber ? ctx.ids.encrypt(normalizeIdNumber(idNumber)) : null,
            id_expiry_date: settings.storeIdExpiryDate ? m.id.expiryDate ?? null : null,
            purged: false,
            created_at: now,
            updated_at: now,
          });
          await trx('visits').insert({
            id: visitId,
            reference_no: ref++,
            visitor_id: visitorId,
            visit_type: input.visitType,
            status: 'on_site',
            host_employee_id: input.hostEmployeeId ?? null,
            host_name_text: input.hostEmployeeId ? null : input.hostName ?? null,
            department_id: input.departmentId ?? null,
            purpose: input.purpose ?? null,
            delivery_company: input.visitType === 'delivery' ? input.deliveryCompany ?? null : null,
            sales_reference: input.salesReference ?? null,
            vehicle_plate: plate,
            badge_number: m.badgeNumber ?? null,
            notes: input.notes ?? null,
            id_status: m.id.status,
            id_scan_method: idNumber ? m.id.method ?? (m.id.status === 'manual' ? 'manual' : null) : null,
            id_verification_ref: null,
            privacy_notice_ack: input.privacyNoticeAck,
            checked_in_at: now,
            checked_in_by: actor.id,
            idempotency_key: `${input.idempotencyKey}#${i}`,
            group_id: groupId,
            group_role: role,
            group_position: i + 1,
            created_at: now,
            updated_at: now,
          });
        }
        await ctx.audit.log(actor, 'visit_group.check_in', { type: 'visit_group', id: groupId }, {
          visitType: input.visitType,
          people: members.length,
          hasVehicle: !!plate,
          idStatuses: members.map(({ m }) => m.id.status),
          fullIdStored: storeFull,
        }, trx);
        await queueGroupCheckInNotification(ctx, groupId, trx);
      });
      break;
    } catch (e) {
      if (isUniqueViolation(e, 'idempotency_key')) {
        const dup = await ctx.db('visit_groups').where({ idempotency_key: input.idempotencyKey }).first();
        if (dup) return replay(dup.id);
      }
      if ((isUniqueViolation(e, 'reference_no') || isUniqueViolation(e, 'group_no') || isUniqueViolation(e, 'folder')) && attempt < 4) continue;
      throw e;
    }
  }

  for (const id of visitIds) ctx.events.publish({ type: 'visit.checked_in', visitId: id, at: now });
  const visits = await Promise.all(visitIds.map((id) => getVisit(ctx, id)));

  // What the tablet should upload next (so a returning tablet can resume an interrupted upload).
  const req: { visitId: string; kinds: string[] }[] = [];
  if (settings.capture.storeIdImages && settings.capture.requireIdImages) {
    members.forEach(({ idNumber }, i) => { if (idNumber) req.push({ visitId: visitIds[i], kinds: ['id_front', 'id_back'] }); });
  }
  return { group: await getGroup(ctx, groupId), visits, replayed: false, warnings, required: req };
}

/** Compatibility: a single-visitor check-in (POST /api/visits) is a group of one. */
export async function checkInSingle(ctx: AppContext, actor: AuditActor & { deviceId?: string | null }, raw: unknown) {
  const b = (raw ?? {}) as Record<string, any>;
  const { visitor, id, badgeNumber, ...rest } = b;
  try {
    const r = await checkInGroup(ctx, actor, { ...rest, visitors: [{ ...(visitor ?? {}), id, badgeNumber }] });
    return { visit: r.visits[0], group: r.group, replayed: r.replayed, warnings: r.warnings };
  } catch (e) {
    // Map group field paths back to the single-visitor shape.
    const err = e as { details?: { fields?: Record<string, string> } };
    if (err.details?.fields) {
      err.details.fields = Object.fromEntries(
        Object.entries(err.details.fields).map(([k, v]) => [k.replace(/^visitors\.0\.id\./, 'id.').replace(/^visitors\.0\./, 'visitor.'), v]),
      );
    }
    throw e;
  }
}

/** Check out everyone in the group who is still on site. */
export async function checkOutGroup(ctx: AppContext, actor: AuditActor, groupId: string, note?: string) {
  const g = await ctx.db('visit_groups').where({ id: groupId }).first();
  if (!g) throw notFound('Visit group');
  const now = ctx.now().toISOString();
  const open = await ctx.db('visits').where({ group_id: groupId, status: 'on_site' }).select('id');
  if (!open.length) throw conflict('ALREADY_CHECKED_OUT', 'Everyone in this group has already checked out');
  await ctx.db.transaction(async (trx) => {
    for (const { id } of open) {
      const n = await trx('visits').where({ id, status: 'on_site' }).update({
        status: 'checked_out', checked_out_at: now, checked_out_by: actor.id, checkout_method: 'gate', checkout_note: note?.slice(0, 500) || null, updated_at: now,
      });
      if (n) await queueVisitNotifications(ctx, 'visit.checked_out', id, trx);
    }
    await ctx.audit.log(actor, 'visit_group.check_out', { type: 'visit_group', id: groupId }, { people: open.length }, trx);
  });
  for (const { id } of open) ctx.events.publish({ type: 'visit.checked_out', visitId: id, at: now });
  return getGroup(ctx, groupId);
}
