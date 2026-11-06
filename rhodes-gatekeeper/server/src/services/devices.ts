import crypto from 'node:crypto';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { AuditActor } from './audit.js';
import { toIso } from '../db/knex.js';
import { sha256Hex } from '../security/crypto.js';
import { AppError, notFound } from '../errors.js';

/**
 * Gate tablets must be enrolled by an administrator before a guard can sign in on them.
 *  1. Admin → Devices → "Add tablet" → a one-time code (valid 24 h) is shown.
 *  2. On the tablet app: enter the server address and the code.
 *  3. The tablet receives a device secret (kept in the device keychain/keystore).
 * Revoking a device signs out every session on it immediately.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const CODE_TTL_HOURS = 24;

function newCode(): string {
  const bytes = crypto.randomBytes(8);
  const c = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}
const normCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');

export const createDeviceSchema = z.object({ name: z.string().trim().min(1).max(120) });
export const enrollSchema = z.object({
  code: z.string().trim().min(6).max(20),
  platform: z.enum(['android', 'ios', 'web']).optional(),
  appVersion: z.string().max(40).optional(),
});

function dto(r: Record<string, any>) {
  const now = new Date().toISOString();
  const status = r.revoked_at ? 'revoked' : r.secret_hash ? 'active' : r.enrollment_expires_at && toIso(r.enrollment_expires_at)! > now ? 'awaiting_enrollment' : 'code_expired';
  return {
    id: r.id, name: r.name, status, platform: r.platform, appVersion: r.app_version,
    enrolledAt: toIso(r.enrolled_at), lastSeenAt: toIso(r.last_seen_at), revokedAt: toIso(r.revoked_at),
    enrollmentExpiresAt: r.secret_hash ? null : toIso(r.enrollment_expires_at), createdAt: toIso(r.created_at),
  };
}

export async function listDevices(ctx: AppContext) {
  return (await ctx.db('devices').orderBy('created_at', 'desc')).map(dto);
}

export async function createDevice(ctx: AppContext, actor: AuditActor, raw: unknown) {
  const { name } = createDeviceSchema.parse(raw);
  const id = crypto.randomUUID();
  const code = newCode();
  const now = ctx.now();
  await ctx.db('devices').insert({
    id, name, enrollment_code_hash: sha256Hex(normCode(code)),
    enrollment_expires_at: new Date(now.getTime() + CODE_TTL_HOURS * 3600_000).toISOString(),
    created_by: actor.id, created_at: now.toISOString(),
  });
  await ctx.audit.log(actor, 'device.create', { type: 'device', id }, { name });
  return { device: dto(await ctx.db('devices').where({ id }).first()), enrollmentCode: code };
}

/** New code for a device that has not enrolled yet, or to re-enrol a replaced tablet (old secret revoked). */
export async function regenerateCode(ctx: AppContext, actor: AuditActor, id: string) {
  const d = await ctx.db('devices').where({ id }).first();
  if (!d) throw notFound('Device');
  const code = newCode();
  await ctx.db('devices').where({ id }).update({
    enrollment_code_hash: sha256Hex(normCode(code)),
    enrollment_expires_at: new Date(ctx.now().getTime() + CODE_TTL_HOURS * 3600_000).toISOString(),
    secret_hash: null, revoked_at: null, enrolled_at: null,
  });
  await ctx.db('sessions').where({ device_id: id }).del();
  await ctx.audit.log(actor, 'device.new_code', { type: 'device', id });
  return { device: dto(await ctx.db('devices').where({ id }).first()), enrollmentCode: code };
}

export async function revokeDevice(ctx: AppContext, actor: AuditActor, id: string) {
  const n = await ctx.db('devices').where({ id }).update({ revoked_at: ctx.now().toISOString(), secret_hash: null, enrollment_code_hash: null });
  if (!n) throw notFound('Device');
  await ctx.db('sessions').where({ device_id: id }).del();
  await ctx.audit.log(actor, 'device.revoke', { type: 'device', id });
  return dto(await ctx.db('devices').where({ id }).first());
}

export async function enrollDevice(ctx: AppContext, raw: unknown, ip?: string) {
  const input = enrollSchema.parse(raw);
  const d = await ctx.db('devices').where({ enrollment_code_hash: sha256Hex(normCode(input.code)) }).whereNull('revoked_at').first();
  if (!d || !d.enrollment_expires_at || toIso(d.enrollment_expires_at)! < ctx.now().toISOString()) {
    await ctx.audit.log({ id: null, username: null, ip }, 'device.enroll_failed', { type: 'device' });
    throw new AppError(400, 'INVALID_CODE', 'That enrolment code is not valid or has expired. Ask an administrator for a new code.');
  }
  const secret = crypto.randomBytes(32).toString('base64url');
  await ctx.db('devices').where({ id: d.id }).update({
    secret_hash: sha256Hex(secret), enrollment_code_hash: null, enrollment_expires_at: null,
    enrolled_at: ctx.now().toISOString(), last_seen_at: ctx.now().toISOString(),
    platform: input.platform ?? null, app_version: input.appVersion ?? null,
  });
  await ctx.audit.log({ id: null, username: null, ip }, 'device.enroll', { type: 'device', id: d.id }, { platform: input.platform });
  return { deviceId: d.id, deviceSecret: secret, deviceName: d.name };
}

/** Validate the device credentials a tablet presents at sign-in. */
export async function verifyDevice(ctx: AppContext, deviceId: string | undefined, secret: string | undefined) {
  if (!deviceId || !secret || secret.length > 100) return null;
  const d = await ctx.db('devices').where({ id: deviceId }).whereNull('revoked_at').first();
  if (!d?.secret_hash) return null;
  const a = Buffer.from(sha256Hex(secret));
  const b = Buffer.from(String(d.secret_hash));
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? d : null;
}
