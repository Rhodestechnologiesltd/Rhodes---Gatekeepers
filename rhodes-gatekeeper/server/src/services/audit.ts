import crypto from 'node:crypto';
import type { Db } from '../db/knex.js';
import { nowIso, parseJson, toIso } from '../db/knex.js';

export interface AuditActor {
  id: string | null;
  username: string | null;
  ip?: string | null;
}

/** Keys that must never be written to audit details. */
const FORBIDDEN = /id_?number|idnumber|password|token|secret|dob|date_?of_?birth/i;

function scrub(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details)) out[k] = FORBIDDEN.test(k) ? '[redacted]' : v;
  return out;
}

export class AuditService {
  constructor(private readonly db: Db) {}

  async log(
    actor: AuditActor,
    action: string,
    entity?: { type: string; id?: string | null },
    details?: Record<string, unknown>,
    trx?: Db,
  ): Promise<void> {
    await (trx ?? this.db)('audit_logs').insert({
      id: crypto.randomUUID(),
      at: nowIso(),
      actor_user_id: actor.id,
      actor_username: actor.username,
      action,
      entity_type: entity?.type ?? null,
      entity_id: entity?.id ?? null,
      details: details ? JSON.stringify(scrub(details)) : null,
      ip: actor.ip ?? null,
    });
  }

  async list(q: { from?: string; to?: string; action?: string; entityId?: string; limit?: number; offset?: number }) {
    const query = this.db('audit_logs').orderBy('at', 'desc');
    if (q.from) query.where('at', '>=', q.from);
    if (q.to) query.where('at', '<', q.to);
    if (q.action) query.where('action', q.action);
    if (q.entityId) query.where('entity_id', q.entityId);
    const rows = await query.limit(Math.min(q.limit ?? 100, 500)).offset(q.offset ?? 0);
    return rows.map((r) => ({
      id: r.id,
      at: toIso(r.at),
      actorUserId: r.actor_user_id,
      actorUsername: r.actor_username,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      details: parseJson<Record<string, unknown> | null>(r.details, null),
      ip: r.ip,
    }));
  }
}
