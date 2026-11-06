import crypto from 'node:crypto';
import { z } from 'zod';
import type { Knex } from 'knex';
import type { AppContext } from '../context.js';
import type { AuditActor } from './audit.js';
import { nowIso, toBool, toIso } from '../db/knex.js';
import { visitDurationMinutes } from '../domain/duration.js';
import { VISIT_TYPES, type VisitDto, type VisitType } from '../domain/types.js';
import { maskIdNumber, normalizeIdNumber } from '../security/crypto.js';
import { AppError, badRequest, conflict, notFound } from '../errors.js';
import { queueVisitNotifications } from './notifications.js';

// ------------------------------------------------------------------ validation
export const trimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? undefined : v))
    .optional()
    .nullable();
export const required = (max: number, label: string) =>
  z.string({ error: `${label} is required` }).trim().min(1, `${label} is required`).max(max);

export const updateVisitSchema = z
  .object({
    visitor: z
      .object({
        fullName: required(160, 'Visitor name').optional(),
        company: trimmed(160),
        phone: trimmed(40),
      })
      .partial()
      .optional(),
    hostEmployeeId: trimmed(36),
    hostName: trimmed(160),
    departmentId: trimmed(36),
    purpose: trimmed(500),
    deliveryCompany: trimmed(160),
    salesReference: trimmed(80),
    vehiclePlate: trimmed(40),
    badgeNumber: trimmed(40),
    notes: trimmed(1000),
  })
  .strict();

export const manualCheckoutSchema = z.object({
  checkedOutAt: z.string().datetime({ offset: true }),
  reason: required(500, 'Reason'),
});

// ------------------------------------------------------------------ mapping
export function baseQuery(db: Knex) {
  return db('visits as v')
    .join('visitors as p', 'p.id', 'v.visitor_id')
    .leftJoin('employees as e', 'e.id', 'v.host_employee_id')
    .leftJoin('departments as d', 'd.id', 'v.department_id')
    .leftJoin('departments as ed', 'ed.id', 'e.department_id')
    .leftJoin('users as ui', 'ui.id', 'v.checked_in_by')
    .leftJoin('users as uo', 'uo.id', 'v.checked_out_by')
    .leftJoin('visit_groups as g', 'g.id', 'v.group_id')
    .select(
      'v.*',
      'p.full_name as p_full_name', 'p.company as p_company', 'p.phone as p_phone', 'p.nationality as p_nationality',
      'p.id_document_type as p_doc_type', 'p.id_number_masked as p_masked', 'p.id_expiry_date as p_expiry',
      'p.id_number_encrypted as p_enc', 'p.purged as p_purged',
      'e.full_name as e_name', 'e.email as e_email',
      'd.name as d_name', 'ed.id as ed_id', 'ed.name as ed_name',
      'ui.display_name as ui_name', 'uo.display_name as uo_name',
      'g.group_no as g_no', 'g.vehicle_plate as g_plate', 'g.folder_name as g_folder', 'g.direction as g_direction',
      'g.po_number as g_po', 'g.invoice_number as g_invoice',
    );
}

type Row = Record<string, any>;
export function toDto(r: Row, opts: { includeHostEmail?: boolean } = {}): VisitDto {
  const checkedInAt = toIso(r.checked_in_at)!;
  const checkedOutAt = toIso(r.checked_out_at);
  const hostName = r.e_name ?? r.host_name_text ?? null;
  // Department: explicit on the visit, otherwise the host employee's department.
  const department = r.department_id
    ? { id: r.department_id, name: r.d_name }
    : r.ed_id
      ? { id: r.ed_id, name: r.ed_name }
      : null;
  return {
    id: r.id,
    referenceNo: Number(r.reference_no),
    visitType: r.visit_type,
    status: r.status,
    visitor: {
      id: r.visitor_id,
      fullName: r.p_full_name,
      company: r.p_company,
      phone: r.p_phone,
      nationality: r.p_nationality,
      idDocumentType: r.p_doc_type,
      idNumberMasked: r.p_masked,
      idExpiryDate: r.p_expiry,
      hasStoredFullId: !!r.p_enc,
      purged: toBool(r.p_purged),
    },
    host: hostName || r.host_employee_id
      ? { employeeId: r.host_employee_id ?? null, name: hostName, ...(opts.includeHostEmail ? { email: r.e_email } : {}) }
      : null,
    department,
    purpose: r.purpose,
    deliveryCompany: r.delivery_company,
    salesReference: r.sales_reference,
    vehiclePlate: r.vehicle_plate ?? r.g_plate ?? null,
    badgeNumber: r.badge_number,
    notes: r.notes,
    idStatus: r.id_status,
    idScanMethod: r.id_scan_method,
    privacyNoticeAck: toBool(r.privacy_notice_ack),
    checkedInAt,
    checkedInBy: r.ui_name ?? null,
    checkedOutAt,
    checkedOutBy: r.uo_name ?? null,
    checkoutMethod: r.checkout_method,
    checkoutNote: r.checkout_note,
    durationMinutes: visitDurationMinutes(checkedInAt, checkedOutAt),
    group: r.group_id
      ? {
          id: r.group_id, groupNo: Number(r.g_no), role: r.group_role ?? 'visitor', position: Number(r.group_position ?? 1),
          folderName: r.g_folder, direction: r.g_direction ?? null, poNumber: r.g_po ?? null, invoiceNumber: r.g_invoice ?? null,
        }
      : null,
  };
}

// ------------------------------------------------------------------ queries
export async function getVisit(ctx: AppContext, id: string, db: Knex = ctx.db): Promise<VisitDto> {
  const row = await baseQuery(db).where('v.id', id).first();
  if (!row) throw notFound('Visit');
  return toDto(row);
}

export async function getVisitForEmail(ctx: AppContext, id: string, db: Knex = ctx.db) {
  const row = await baseQuery(db).where('v.id', id).first();
  if (!row) throw notFound('Visit');
  return { dto: toDto(row, { includeHostEmail: true }), departmentId: row.department_id ?? row.ed_id ?? null };
}

export interface VisitFilters {
  status?: 'on_site' | 'checked_out';
  from?: string; // ISO, inclusive (check-in time)
  to?: string; // ISO, exclusive
  visitType?: VisitType;
  hostEmployeeId?: string;
  departmentId?: string;
  q?: string;
  groupId?: string;
  limit?: number;
  offset?: number;
}

export function applyVisitFilters(query: Knex.QueryBuilder, f: VisitFilters): Knex.QueryBuilder {
  if (f.status) query.where('v.status', f.status);
  if (f.from) query.where('v.checked_in_at', '>=', f.from);
  if (f.to) query.where('v.checked_in_at', '<', f.to);
  if (f.visitType) query.where('v.visit_type', f.visitType);
  if (f.groupId) query.where('v.group_id', f.groupId);
  if (f.hostEmployeeId) query.where('v.host_employee_id', f.hostEmployeeId);
  if (f.departmentId) {
    query.where((w) =>
      w.where('v.department_id', f.departmentId!).orWhere((w2) => w2.whereNull('v.department_id').andWhere('e.department_id', f.departmentId!)),
    );
  }
  if (f.q) {
    const term = `%${f.q.toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const asNumber = /^\d+$/.test(f.q) ? Number(f.q) : null;
    query.where((w) => {
      w.whereRaw("lower(p.full_name) like ? escape '\\'", [term])
        .orWhereRaw("lower(coalesce(p.company,'')) like ? escape '\\'", [term])
        .orWhereRaw("lower(coalesce(v.delivery_company,'')) like ? escape '\\'", [term])
        .orWhereRaw("lower(coalesce(v.badge_number,'')) like ? escape '\\'", [term]);
      if (asNumber !== null) w.orWhere('v.reference_no', asNumber);
    });
  }
  return query;
}

export async function listVisits(ctx: AppContext, f: VisitFilters): Promise<{ items: VisitDto[]; total: number }> {
  const countQ = applyVisitFilters(
    ctx.db('visits as v').join('visitors as p', 'p.id', 'v.visitor_id').leftJoin('employees as e', 'e.id', 'v.host_employee_id'),
    f,
  ).count({ n: '*' });
  const [{ n }] = (await countQ) as { n: number | string }[];
  const rows = await applyVisitFilters(baseQuery(ctx.db), f)
    .orderBy('v.checked_in_at', 'desc')
    .limit(Math.min(f.limit ?? 50, 1000))
    .offset(f.offset ?? 0);
  return { items: rows.map((r: Row) => toDto(r)), total: Number(n) };
}

export async function listAllVisitsInRange(ctx: AppContext, f: VisitFilters): Promise<VisitDto[]> {
  const rows = await applyVisitFilters(baseQuery(ctx.db), f).orderBy('v.checked_in_at', 'asc');
  return rows.map((r: Row) => toDto(r));
}

/** Repeat-visitor prefill: most recent details recorded for this ID number (matched by keyed hash). */
export async function lookupByIdNumber(ctx: AppContext, idNumber: string) {
  const hash = ctx.ids.hash(idNumber);
  const prev = await ctx.db('visitors').where({ id_number_hash: hash, purged: false }).orderBy('created_at', 'desc').first();
  const onSite = await ctx.db('visits as v')
    .join('visitors as p', 'p.id', 'v.visitor_id')
    .where({ 'p.id_number_hash': hash, 'v.status': 'on_site' })
    .select('v.id', 'v.reference_no', 'v.checked_in_at')
    .first();
  return {
    previousVisitor: prev ? { fullName: prev.full_name, company: prev.company, phone: prev.phone } : null,
    onSiteVisit: onSite ? { id: onSite.id, referenceNo: Number(onSite.reference_no), checkedInAt: toIso(onSite.checked_in_at) } : null,
  };
}

// ------------------------------------------------------------------ commands
export async function nextReferenceNo(trx: Knex): Promise<number> {
  const r = await trx('visits').max({ m: 'reference_no' }).first();
  return Number(r?.m ?? 1000) + 1;
}

export function isUniqueViolation(e: unknown, column?: string): boolean {
  const err = e as { code?: string; message?: string };
  const msg = String(err?.message ?? '');
  const hit = err?.code === '23505' || err?.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/i.test(msg);
  return hit && (!column || msg.includes(column) || err?.code === '23505');
}

export async function checkOut(ctx: AppContext, actor: AuditActor, visitId: string, note?: string): Promise<VisitDto> {
  const now = ctx.now().toISOString();
  const updated = await ctx.db.transaction(async (trx) => {
    const n = await trx('visits')
      .where({ id: visitId, status: 'on_site' })
      .update({
        status: 'checked_out',
        checked_out_at: now,
        checked_out_by: actor.id,
        checkout_method: 'gate',
        checkout_note: note?.slice(0, 500) || null,
        updated_at: now,
      });
    if (!n) return 0;
    await ctx.audit.log(actor, 'visit.check_out', { type: 'visit', id: visitId }, { method: 'gate' }, trx);
    await queueVisitNotifications(ctx, 'visit.checked_out', visitId, trx);
    return n;
  });
  if (!updated) {
    const v = await ctx.db('visits').where({ id: visitId }).first();
    if (!v) throw notFound('Visit');
    throw conflict('ALREADY_CHECKED_OUT', 'This visitor has already been checked out');
  }
  ctx.events.publish({ type: 'visit.checked_out', visitId, at: now });
  return getVisit(ctx, visitId);
}

/** Reception/admin correction for a visitor who left without checking out. Clearly flagged in reports. */
export async function manualCheckout(ctx: AppContext, actor: AuditActor, visitId: string, raw: unknown): Promise<VisitDto> {
  const input = manualCheckoutSchema.parse(raw);
  const visit = await ctx.db('visits').where({ id: visitId }).first();
  if (!visit) throw notFound('Visit');
  if (visit.status !== 'on_site') throw conflict('ALREADY_CHECKED_OUT', 'This visitor has already been checked out');
  const outAt = new Date(input.checkedOutAt).toISOString();
  if (outAt < toIso(visit.checked_in_at)!) throw badRequest('Check-out time cannot be before check-in time');
  if (outAt > ctx.now().toISOString()) throw badRequest('Check-out time cannot be in the future');
  const now = ctx.now().toISOString();
  await ctx.db.transaction(async (trx) => {
    await trx('visits').where({ id: visitId }).update({
      status: 'checked_out',
      checked_out_at: outAt,
      checked_out_by: actor.id,
      checkout_method: 'manual_correction',
      checkout_note: input.reason,
      updated_at: now,
    });
    await ctx.audit.log(actor, 'visit.manual_checkout', { type: 'visit', id: visitId }, { reason: input.reason }, trx);
  });
  ctx.events.publish({ type: 'visit.checked_out', visitId, at: now });
  return getVisit(ctx, visitId);
}

export async function updateVisit(ctx: AppContext, actor: AuditActor, visitId: string, raw: unknown): Promise<VisitDto> {
  const parsed = updateVisitSchema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest('Please correct the highlighted fields', {
      fields: Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])),
    });
  }
  const p = parsed.data;
  const visit = await ctx.db('visits').where({ id: visitId }).first();
  if (!visit) throw notFound('Visit');
  const visitor = await ctx.db('visitors').where({ id: visit.visitor_id }).first();
  if (toBool(visitor?.purged)) throw new AppError(409, 'PURGED', 'This visit has been anonymised under the retention policy');

  if (p.hostEmployeeId && !(await ctx.db('employees').where({ id: p.hostEmployeeId }).first())) {
    throw badRequest('Selected employee was not found');
  }
  if (p.departmentId && !(await ctx.db('departments').where({ id: p.departmentId }).first())) {
    throw badRequest('Selected department was not found');
  }

  const map: Record<string, string> = {
    hostEmployeeId: 'host_employee_id', hostName: 'host_name_text', departmentId: 'department_id', purpose: 'purpose',
    deliveryCompany: 'delivery_company', salesReference: 'sales_reference', vehiclePlate: 'vehicle_plate',
    badgeNumber: 'badge_number', notes: 'notes',
  };
  const visitPatch: Record<string, unknown> = {};
  const changed: string[] = [];
  for (const [k, col] of Object.entries(map)) {
    if (k in p) {
      const val = (p as Record<string, unknown>)[k] ?? null;
      if (val !== visit[col]) {
        visitPatch[col] = val;
        changed.push(k);
      }
    }
  }
  if ('hostEmployeeId' in p && p.hostEmployeeId) visitPatch.host_name_text = null;

  const visitorPatch: Record<string, unknown> = {};
  if (p.visitor) {
    for (const [k, col] of [['fullName', 'full_name'], ['company', 'company'], ['phone', 'phone']] as const) {
      if (k in p.visitor) {
        const val = (p.visitor as Record<string, unknown>)[k] ?? null;
        if (k === 'fullName' && !val) continue;
        if (val !== visitor[col]) {
          visitorPatch[col] = val;
          changed.push(`visitor.${k}`);
        }
      }
    }
  }
  if (!changed.length) return getVisit(ctx, visitId);

  const now = nowIso();
  await ctx.db.transaction(async (trx) => {
    if (Object.keys(visitPatch).length) await trx('visits').where({ id: visitId }).update({ ...visitPatch, updated_at: now });
    if (Object.keys(visitorPatch).length) await trx('visitors').where({ id: visit.visitor_id }).update({ ...visitorPatch, updated_at: now });
    // Field NAMES only — values are not copied into the audit log.
    await ctx.audit.log(actor, 'visit.update', { type: 'visit', id: visitId }, { changedFields: changed }, trx);
  });
  ctx.events.publish({ type: 'visit.updated', visitId, at: now });
  return getVisit(ctx, visitId);
}

/** Reveal a stored full ID number (only exists if full storage was enabled). Always audited. */
export async function revealIdNumber(ctx: AppContext, actor: AuditActor, visitId: string, reason: string) {
  if (!reason || reason.trim().length < 3) throw badRequest('A reason is required to view the full ID number');
  const row = await ctx.db('visits as v').join('visitors as p', 'p.id', 'v.visitor_id').where('v.id', visitId).select('p.id_number_encrypted as enc').first();
  if (!row) throw notFound('Visit');
  if (!row.enc) throw new AppError(404, 'NOT_STORED', 'The full ID number is not stored for this visit (only a masked form is kept)');
  await ctx.audit.log(actor, 'visitor.view_sensitive', { type: 'visit', id: visitId }, { field: 'full_id', reason: reason.slice(0, 200) });
  const plain = ctx.ids.decrypt(row.enc);
  return { idNumber: /^784\d{12}$/.test(plain) ? `${plain.slice(0, 3)}-${plain.slice(3, 7)}-${plain.slice(7, 14)}-${plain.slice(14)}` : plain };
}
