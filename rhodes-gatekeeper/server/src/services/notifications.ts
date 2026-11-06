import crypto from 'node:crypto';
import { z } from 'zod';
import type { Knex } from 'knex';
import type { AppContext } from '../context.js';
import { nowIso, parseJson, toBool, toIso } from '../db/knex.js';
import { VISIT_TYPES, type VisitType } from '../domain/types.js';
import { renderVisitEmail } from '../email/templates.js';
import { getVisitForEmail } from './visits.js';

export interface NotificationRule {
  visitType: VisitType;
  enabled: boolean;
  notifyHost: boolean;
  notifyDepartment: boolean;
  extraRecipients: string[];
  notifyOnCheckout: boolean;
}

export const DEFAULT_RULES: Record<VisitType, Omit<NotificationRule, 'visitType'>> = {
  meeting: { enabled: true, notifyHost: true, notifyDepartment: false, extraRecipients: [], notifyOnCheckout: false },
  delivery: { enabled: true, notifyHost: true, notifyDepartment: true, extraRecipients: [], notifyOnCheckout: false },
  customer: { enabled: true, notifyHost: true, notifyDepartment: false, extraRecipients: [], notifyOnCheckout: false },
  other: { enabled: true, notifyHost: true, notifyDepartment: false, extraRecipients: [], notifyOnCheckout: false },
};

export const ruleSchema = z.object({
  enabled: z.boolean(),
  notifyHost: z.boolean(),
  notifyDepartment: z.boolean(),
  extraRecipients: z.array(z.string().trim().email('Invalid email address')).max(20),
  notifyOnCheckout: z.boolean(),
});

export async function getRules(db: Knex): Promise<NotificationRule[]> {
  const rows = await db('notification_rules');
  return VISIT_TYPES.map((t) => {
    const r = rows.find((x: Record<string, unknown>) => x.visit_type === t);
    if (!r) return { visitType: t, ...DEFAULT_RULES[t] };
    return {
      visitType: t,
      enabled: toBool(r.enabled),
      notifyHost: toBool(r.notify_host),
      notifyDepartment: toBool(r.notify_department),
      extraRecipients: parseJson<string[]>(r.extra_recipients, []),
      notifyOnCheckout: toBool(r.notify_on_checkout),
    };
  });
}

export async function saveRule(db: Knex, visitType: VisitType, raw: unknown): Promise<NotificationRule> {
  const r = ruleSchema.parse(raw);
  const row = {
    visit_type: visitType,
    enabled: r.enabled,
    notify_host: r.notifyHost,
    notify_department: r.notifyDepartment,
    extra_recipients: JSON.stringify([...new Set(r.extraRecipients.map((e) => e.toLowerCase()))]),
    notify_on_checkout: r.notifyOnCheckout,
    updated_at: nowIso(),
  };
  await db('notification_rules').insert(row).onConflict('visit_type').merge();
  return (await getRules(db)).find((x) => x.visitType === visitType)!;
}

/**
 * Transactional outbox: notification rows are written in the SAME transaction as the visit, then
 * delivered asynchronously by processOutbox(). A slow or failed email never blocks the gate.
 */
export async function queueVisitNotifications(
  ctx: AppContext,
  event: 'visit.checked_in' | 'visit.checked_out',
  visitId: string,
  trx: Knex,
): Promise<void> {
  const { dto, departmentId } = await getVisitForEmail(ctx, visitId, trx);
  await queueFor(ctx, event, dto, departmentId, visitId, trx);
}

/** One arrival email for the whole group (lead visitor's details + list of everyone). */
export async function queueGroupCheckInNotification(ctx: AppContext, groupId: string, trx: Knex): Promise<void> {
  const members = await trx('visits as v')
    .join('visitors as p', 'p.id', 'v.visitor_id')
    .where('v.group_id', groupId)
    .orderBy('v.group_position')
    .select('v.id', 'v.reference_no', 'v.group_role', 'v.badge_number', 'p.full_name');
  if (!members.length) return;
  const { dto, departmentId } = await getVisitForEmail(ctx, members[0].id, trx);
  const people = members.map((m: Record<string, any>) => ({ name: m.full_name, ref: Number(m.reference_no), role: m.group_role ?? 'visitor', badge: m.badge_number ?? null }));
  await queueFor(ctx, 'visit.checked_in', dto, departmentId, members[0].id, trx, people);
}

async function queueFor(
  ctx: AppContext,
  event: 'visit.checked_in' | 'visit.checked_out',
  dto: Awaited<ReturnType<typeof getVisitForEmail>>['dto'],
  departmentId: string | null,
  visitId: string,
  trx: Knex,
  people?: { name: string; ref: number; role: string; badge: string | null }[],
): Promise<void> {
  const rule = (await getRules(trx)).find((r) => r.visitType === dto.visitType)!;
  if (!rule.enabled) return;
  if (event === 'visit.checked_out' && !rule.notifyOnCheckout) return;

  const recipients = new Set<string>();
  if (rule.notifyHost && dto.host?.email) recipients.add(dto.host.email.toLowerCase());
  if (rule.notifyDepartment && departmentId) {
    const dep = await trx('departments').where({ id: departmentId }).first();
    if (dep?.notification_email) recipients.add(String(dep.notification_email).toLowerCase());
  }
  for (const r of rule.extraRecipients) recipients.add(r.toLowerCase());

  const settings = await ctx.settings.get();
  const content = renderVisitEmail(event, dto, {
    siteName: settings.siteName,
    timezone: settings.timezone,
    appBaseUrl: ctx.config.APP_BASE_URL,
    footer: settings.emailFooter,
  }, people);
  const to = [...recipients];
  const status = to.length === 0 ? 'skipped' : ctx.email.name === 'disabled' ? 'skipped' : 'pending';
  await trx('notifications').insert({
    id: crypto.randomUUID(),
    visit_id: visitId,
    event,
    recipients: JSON.stringify(to),
    subject: content.subject,
    body_html: content.html,
    body_text: content.text,
    status,
    provider: ctx.email.name,
    attempts: 0,
    last_error: to.length === 0 ? 'No recipients configured for this visit' : status === 'skipped' ? 'Email disabled' : null,
    next_attempt_at: status === 'pending' ? ctx.now().toISOString() : null,
    created_at: ctx.now().toISOString(),
  });
}

const MAX_ATTEMPTS = 6;
let running = false;

/** Deliver due notifications. Safe to call repeatedly; retries with exponential backoff. */
export async function processOutbox(ctx: AppContext, batchSize = 20): Promise<{ sent: number; failed: number }> {
  if (running) return { sent: 0, failed: 0 };
  running = true;
  let sent = 0;
  let failed = 0;
  try {
    const due = await ctx.db('notifications')
      .where({ status: 'pending' })
      .where('next_attempt_at', '<=', ctx.now().toISOString())
      .orderBy('created_at')
      .limit(batchSize);
    for (const n of due) {
      const attempts = Number(n.attempts) + 1;
      try {
        await ctx.email.send({ to: parseJson<string[]>(n.recipients, []), subject: n.subject, html: n.body_html, text: n.body_text });
        await ctx.db('notifications').where({ id: n.id }).update({
          status: 'sent', attempts, sent_at: ctx.now().toISOString(), last_error: null, provider: ctx.email.name,
        });
        sent++;
      } catch (e) {
        const msg = String((e as Error)?.message ?? e).slice(0, 500);
        const giveUp = attempts >= MAX_ATTEMPTS;
        const delayMs = Math.min(2 ** attempts * 30_000, 60 * 60_000);
        await ctx.db('notifications').where({ id: n.id }).update({
          status: giveUp ? 'failed' : 'pending',
          attempts,
          last_error: msg,
          next_attempt_at: giveUp ? null : new Date(ctx.now().getTime() + delayMs).toISOString(),
        });
        ctx.log.warn({ notificationId: n.id, attempts, giveUp }, 'Email notification delivery failed');
        failed++;
      }
    }
  } finally {
    running = false;
  }
  return { sent, failed };
}

export async function listNotifications(ctx: AppContext, q: { status?: string; visitId?: string; limit?: number }) {
  const query = ctx.db('notifications').orderBy('created_at', 'desc').limit(Math.min(q.limit ?? 100, 500));
  if (q.status) query.where({ status: q.status });
  if (q.visitId) query.where({ visit_id: q.visitId });
  const rows = await query;
  return rows.map((n: Record<string, unknown>) => ({
    id: n.id,
    visitId: n.visit_id,
    event: n.event,
    recipients: parseJson<string[]>(n.recipients, []),
    subject: n.subject,
    status: n.status,
    provider: n.provider,
    attempts: Number(n.attempts),
    lastError: n.last_error,
    createdAt: toIso(n.created_at),
    sentAt: toIso(n.sent_at),
  }));
}

export async function retryNotification(ctx: AppContext, id: string): Promise<boolean> {
  const n = await ctx.db('notifications').where({ id }).whereIn('status', ['failed', 'pending']).update({
    status: 'pending', next_attempt_at: ctx.now().toISOString(), attempts: 0,
  });
  return n > 0;
}
