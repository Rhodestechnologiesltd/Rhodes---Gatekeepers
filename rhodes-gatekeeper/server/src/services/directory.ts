import crypto from 'node:crypto';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { AuditActor } from './audit.js';
import { nowIso, toBool } from '../db/knex.js';
import { conflict, notFound } from '../errors.js';

const optText = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => (v ? v : null));

export const departmentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  notificationEmail: z.string().trim().email().max(254).nullable().optional().or(z.literal('').transform(() => null)),
  active: z.boolean().optional(),
});

export const employeeSchema = z.object({
  fullName: z.string().trim().min(1).max(160),
  email: z.string().trim().email().max(254).nullable().optional().or(z.literal('').transform(() => null)),
  phone: optText(40),
  jobTitle: optText(120),
  departmentId: z.string().max(36).nullable().optional().or(z.literal('').transform(() => null)),
  active: z.boolean().optional(),
});

const depDto = (r: Record<string, any>) => ({ id: r.id, name: r.name, notificationEmail: r.notification_email, active: toBool(r.active) });
const empDto = (r: Record<string, any>, includeContact: boolean) => ({
  id: r.id,
  fullName: r.full_name,
  jobTitle: r.job_title,
  departmentId: r.department_id,
  departmentName: r.d_name ?? null,
  active: toBool(r.active),
  ...(includeContact ? { email: r.email, phone: r.phone } : {}),
});

export async function listDepartments(ctx: AppContext, opts: { includeInactive?: boolean } = {}) {
  const q = ctx.db('departments').orderBy('name');
  if (!opts.includeInactive) q.where({ active: true });
  return (await q).map(depDto);
}

export async function saveDepartment(ctx: AppContext, actor: AuditActor, id: string | null, raw: unknown) {
  const d = departmentSchema.parse(raw);
  const dup = await ctx.db('departments').whereRaw('lower(name) = ?', [d.name.toLowerCase()]).modify((q) => { if (id) q.whereNot({ id }); }).first();
  if (dup) throw conflict('DUPLICATE', 'A department with that name already exists');
  const now = nowIso();
  const row = { name: d.name, notification_email: d.notificationEmail ?? null, active: d.active ?? true, updated_at: now };
  if (id) {
    if (!(await ctx.db('departments').where({ id }).update(row))) throw notFound('Department');
  } else {
    id = crypto.randomUUID();
    await ctx.db('departments').insert({ id, ...row, created_at: now });
  }
  await ctx.audit.log(actor, 'department.save', { type: 'department', id }, { name: d.name });
  return depDto(await ctx.db('departments').where({ id }).first());
}

/** Guards get names/departments only; contact details are limited to administrators. */
export async function listEmployees(ctx: AppContext, opts: { q?: string; includeInactive?: boolean; includeContact?: boolean } = {}) {
  const q = ctx.db('employees as e').leftJoin('departments as d', 'd.id', 'e.department_id').select('e.*', 'd.name as d_name').orderBy('e.full_name').limit(500);
  if (!opts.includeInactive) q.where('e.active', true);
  if (opts.q) q.whereRaw('lower(e.full_name) like ?', [`%${opts.q.toLowerCase().replace(/[%_]/g, '')}%`]);
  return (await q).map((r: Record<string, any>) => empDto(r, !!opts.includeContact));
}

export async function saveEmployee(ctx: AppContext, actor: AuditActor, id: string | null, raw: unknown) {
  const e = employeeSchema.parse(raw);
  if (e.departmentId && !(await ctx.db('departments').where({ id: e.departmentId }).first())) throw notFound('Department');
  const now = nowIso();
  const row = {
    full_name: e.fullName, email: e.email ?? null, phone: e.phone ?? null, job_title: e.jobTitle ?? null,
    department_id: e.departmentId ?? null, active: e.active ?? true, updated_at: now,
  };
  if (id) {
    if (!(await ctx.db('employees').where({ id }).update(row))) throw notFound('Employee');
  } else {
    id = crypto.randomUUID();
    await ctx.db('employees').insert({ id, ...row, created_at: now });
  }
  await ctx.audit.log(actor, 'employee.save', { type: 'employee', id }, { fullName: e.fullName });
  const r = await ctx.db('employees as e').leftJoin('departments as d', 'd.id', 'e.department_id').select('e.*', 'd.name as d_name').where('e.id', id).first();
  return empDto(r, true);
}
