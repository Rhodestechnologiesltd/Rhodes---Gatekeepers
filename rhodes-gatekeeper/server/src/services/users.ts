import crypto from 'node:crypto';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { AuditActor } from './audit.js';
import { nowIso, toBool, toIso } from '../db/knex.js';
import { ROLES, ROLE_CLIENTS, isRole, type Role } from '../domain/permissions.js';
import type { AuthUser } from '../domain/types.js';
import { hashPassword, newSessionToken, passwordProblems, sha256Hex, verifyPassword } from '../security/crypto.js';
import { AppError, badRequest, conflict, notFound } from '../errors.js';

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

export const createUserSchema = z.object({
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,80}$/, 'Username: 3–80 letters, numbers, . _ -'),
  displayName: z.string().trim().min(1).max(160),
  email: z.string().trim().email().max(254).optional().or(z.literal('').transform(() => undefined)),
  role: z.enum(ROLES),
  password: z.string(),
});
export const updateUserSchema = z
  .object({
    displayName: z.string().trim().min(1).max(160),
    email: z.string().trim().email().max(254).nullable().or(z.literal('').transform(() => null)),
    role: z.enum(ROLES),
    active: z.boolean(),
    password: z.string(),
  })
  .partial()
  .strict();

function userDto(r: Record<string, any>) {
  return {
    id: r.id, username: r.username, displayName: r.display_name, email: r.email, role: r.role as Role,
    active: toBool(r.active), mustChangePassword: toBool(r.must_change_password),
    lockedUntil: toIso(r.locked_until), lastLoginAt: toIso(r.last_login_at), createdAt: toIso(r.created_at),
  };
}

export async function listUsers(ctx: AppContext) {
  return (await ctx.db('users').orderBy('display_name')).map(userDto);
}

export async function createUser(ctx: AppContext, actor: AuditActor, raw: unknown, opts: { mustChangePassword?: boolean } = {}) {
  const input = createUserSchema.parse(raw);
  const problem = passwordProblems(input.password);
  if (problem) throw badRequest(problem, { fields: { password: problem } });
  if (await ctx.db('users').where({ username: input.username }).first()) throw conflict('USERNAME_TAKEN', 'That username is already in use');
  const id = crypto.randomUUID();
  const now = nowIso();
  await ctx.db('users').insert({
    id, username: input.username, display_name: input.displayName, email: input.email ?? null, role: input.role,
    password_hash: await hashPassword(input.password), active: true,
    must_change_password: opts.mustChangePassword ?? true, failed_logins: 0, created_at: now, updated_at: now,
  });
  await ctx.audit.log(actor, 'user.create', { type: 'user', id }, { username: input.username, role: input.role });
  return userDto(await ctx.db('users').where({ id }).first());
}

export async function updateUser(ctx: AppContext, actor: AuditActor, id: string, raw: unknown) {
  const input = updateUserSchema.parse(raw);
  const user = await ctx.db('users').where({ id }).first();
  if (!user) throw notFound('User');
  const demotingOrDisablingAdmin =
    user.role === 'admin' && toBool(user.active) && ((input.role && input.role !== 'admin') || input.active === false);
  if (demotingOrDisablingAdmin) {
    const [{ n }] = await ctx.db('users').where({ role: 'admin', active: true }).count({ n: '*' });
    if (Number(n) <= 1) throw conflict('LAST_ADMIN', 'At least one active administrator is required');
  }
  if (actor.id === id && (input.active === false || (input.role && input.role !== user.role))) {
    throw conflict('SELF_CHANGE', 'You cannot change your own role or disable your own account');
  }
  const patch: Record<string, unknown> = { updated_at: nowIso() };
  if (input.displayName !== undefined) patch.display_name = input.displayName;
  if (input.email !== undefined) patch.email = input.email;
  if (input.role !== undefined) patch.role = input.role;
  if (input.active !== undefined) patch.active = input.active;
  if (input.password !== undefined) {
    const problem = passwordProblems(input.password);
    if (problem) throw badRequest(problem, { fields: { password: problem } });
    patch.password_hash = await hashPassword(input.password);
    patch.must_change_password = actor.id !== id;
    patch.failed_logins = 0;
    patch.locked_until = null;
  }
  await ctx.db('users').where({ id }).update(patch);
  // Role/active/password changes revoke existing sessions.
  if (input.role !== undefined || input.active === false || input.password !== undefined) {
    await ctx.db('sessions').where({ user_id: id }).del();
  }
  const changed = Object.keys(input).filter((k) => k !== 'password');
  await ctx.audit.log(actor, 'user.update', { type: 'user', id }, { changedFields: changed, passwordReset: input.password !== undefined });
  return userDto(await ctx.db('users').where({ id }).first());
}

// ------------------------------------------------------------------ authentication
export type ClientKind = 'web' | 'mobile';

export async function login(
  ctx: AppContext,
  username: string,
  password: string,
  meta: { ip?: string; userAgent?: string; client?: ClientKind; deviceId?: string | null },
) {
  const client: ClientKind = meta.client ?? 'web';
  const uname = String(username ?? '').trim().toLowerCase();
  const user = await ctx.db('users').where({ username: uname }).first();
  const fail = async (reason: string) => {
    await ctx.audit.log({ id: user?.id ?? null, username: uname.slice(0, 80), ip: meta.ip }, 'auth.login_failed', { type: 'user', id: user?.id }, { reason });
    return new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect username or password');
  };
  if (!user) {
    await verifyPassword(password ?? '', 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86)); // equalise timing
    throw await fail('unknown_user');
  }
  if (!toBool(user.active)) throw await fail('inactive');
  const lockedUntil = toIso(user.locked_until);
  if (lockedUntil && lockedUntil > ctx.now().toISOString()) {
    await ctx.audit.log({ id: user.id, username: user.username, ip: meta.ip }, 'auth.login_locked', { type: 'user', id: user.id });
    throw new AppError(423, 'ACCOUNT_LOCKED', `Too many failed attempts. Try again after ${LOCK_MINUTES} minutes or ask an administrator.`);
  }
  if (!(await verifyPassword(String(password ?? ''), user.password_hash))) {
    const failed = Number(user.failed_logins) + 1;
    await ctx.db('users').where({ id: user.id }).update({
      failed_logins: failed >= MAX_FAILED ? 0 : failed,
      locked_until: failed >= MAX_FAILED ? new Date(ctx.now().getTime() + LOCK_MINUTES * 60_000).toISOString() : null,
    });
    throw await fail('bad_password');
  }
  // The gate runs on enrolled tablets only; office staff use the web app.
  if (!ROLE_CLIENTS[user.role as Role]?.has(client)) {
    await ctx.audit.log({ id: user.id, username: user.username, ip: meta.ip }, 'auth.login_wrong_client', { type: 'user', id: user.id }, { client });
    throw new AppError(403, 'WRONG_CLIENT', client === 'web'
      ? 'Security guards sign in on the Rhodes Gatekeeper app on the gate tablet. The web app is for reception and managers.'
      : 'This tablet app is for security guards. Reception, managers and administrators use the web app.');
  }
  const token = newSessionToken();
  const now = ctx.now();
  await ctx.db('users').where({ id: user.id }).update({ failed_logins: 0, locked_until: null, last_login_at: now.toISOString() });
  await ctx.db('sessions').insert({
    id: sha256Hex(token), user_id: user.id, created_at: now.toISOString(), last_seen_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ctx.config.SESSION_TTL_HOURS * 3600_000).toISOString(),
    user_agent: meta.userAgent?.slice(0, 255) ?? null,
    client,
    device_id: meta.deviceId ?? null,
  });
  await ctx.audit.log({ id: user.id, username: user.username, ip: meta.ip }, 'auth.login', { type: 'user', id: user.id }, { client, deviceId: meta.deviceId ?? undefined });
  return { token, user: toAuthUser(user) };
}

function toAuthUser(r: Record<string, any>): AuthUser {
  if (!isRole(r.role)) throw new Error('Invalid role');
  return { id: r.id, username: r.username, displayName: r.display_name, role: r.role, mustChangePassword: toBool(r.must_change_password) };
}

/**
 * Resolve a session token for the given client kind; sliding expiry.
 * Cookie tokens are only valid as web sessions and bearer tokens only as tablet sessions, and a tablet
 * session dies as soon as its device is revoked.
 */
export async function authenticate(
  ctx: AppContext,
  token: string | undefined,
  client: ClientKind = 'web',
): Promise<(AuthUser & { client: ClientKind; deviceId: string | null }) | null> {
  if (!token || token.length > 200) return null;
  const id = sha256Hex(token);
  const row = await ctx.db('sessions as s')
    .join('users as u', 'u.id', 's.user_id')
    .leftJoin('devices as d', 'd.id', 's.device_id')
    .where('s.id', id)
    .select('u.*', 's.expires_at as s_expires', 's.last_seen_at as s_seen', 's.client as s_client', 's.device_id as s_device', 'd.revoked_at as d_revoked', 'd.secret_hash as d_secret')
    .first();
  if (!row || row.s_client !== client) return null;
  const now = ctx.now();
  const deviceInvalid = client === 'mobile' && (!row.s_device || row.d_revoked || !row.d_secret);
  if (toIso(row.s_expires)! <= now.toISOString() || !toBool(row.active) || deviceInvalid || !ROLE_CLIENTS[row.role as Role]?.has(client)) {
    await ctx.db('sessions').where({ id }).del();
    return null;
  }
  // Refresh at most once a minute to limit writes.
  if (now.getTime() - Date.parse(toIso(row.s_seen)!) > 60_000) {
    await ctx.db('sessions').where({ id }).update({
      last_seen_at: now.toISOString(),
      expires_at: new Date(now.getTime() + ctx.config.SESSION_TTL_HOURS * 3600_000).toISOString(),
    });
    if (row.s_device) await ctx.db('devices').where({ id: row.s_device }).update({ last_seen_at: now.toISOString() });
  }
  return { ...toAuthUser(row), client: row.s_client, deviceId: row.s_device ?? null };
}

export async function logout(ctx: AppContext, token: string | undefined) {
  if (token) await ctx.db('sessions').where({ id: sha256Hex(token) }).del();
}

export async function changeOwnPassword(ctx: AppContext, user: AuthUser, current: string, next: string) {
  const row = await ctx.db('users').where({ id: user.id }).first();
  if (!row || !(await verifyPassword(String(current ?? ''), row.password_hash))) {
    throw new AppError(400, 'INVALID_PASSWORD', 'Current password is incorrect');
  }
  const problem = passwordProblems(String(next ?? ''));
  if (problem) throw badRequest(problem, { fields: { newPassword: problem } });
  if (current === next) throw badRequest('New password must be different');
  await ctx.db('users').where({ id: user.id }).update({ password_hash: await hashPassword(next), must_change_password: false, updated_at: nowIso() });
  await ctx.audit.log({ id: user.id, username: user.username }, 'auth.password_changed', { type: 'user', id: user.id });
}
