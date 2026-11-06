import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import request from 'supertest';
import { loadConfig } from '../src/config.js';
import { buildContext, type AppContext } from '../src/context.js';
import { createDb, migrateLatest } from '../src/db/knex.js';
import { DevLogEmailProvider, type EmailProvider } from '../src/email/providers.js';
import { createApp } from '../src/http/app.js';
import { NoVerificationService } from '../src/scanning/verification.js';
import { hashPassword, sha256Hex } from '../src/security/crypto.js';
import type { SharePointTarget } from '../src/files/sharepoint.js';
import { demoEmiratesId } from '../src/db/seed.js';
import { mrzCheckDigit } from '../src/scanning/parse.js';

export const PASSWORD = 'Test-Password-123';
export { demoEmiratesId };

export async function setup(opts: { env?: Record<string, string>; email?: EmailProvider; now?: () => Date; sharepoint?: SharePointTarget } = {}) {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-files-'));
  // Set TEST_DATABASE_URL to run the same suite against PostgreSQL (see `npm run test:pg`).
  const pgUrl = process.env.TEST_DATABASE_URL;
  const config = loadConfig({
    NODE_ENV: 'test',
    DB_CLIENT: pgUrl ? 'pg' : 'sqlite',
    DATABASE_URL: pgUrl,
    SQLITE_FILENAME: ':memory:',
    DATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    LOG_LEVEL: 'silent',
    JOBS_ENABLED: 'false',
    STORAGE_DIR: storageDir,
    ...opts.env,
  });
  const db = createDb(config);
  if (pgUrl) await db.raw('drop schema if exists public cascade; create schema public;');
  await migrateLatest(db);
  const log = pino({ level: 'silent' });
  const email = opts.email ?? new DevLogEmailProvider(log);
  const ctx = buildContext({ config, db, log, email, verifier: new NoVerificationService(), now: opts.now, sharepoint: opts.sharepoint });
  const app = createApp(ctx);

  const now = new Date().toISOString();
  const hash = await hashPassword(PASSWORD);
  const users: Record<string, string> = {};
  for (const role of ['guard', 'reception', 'manager', 'admin'] as const) {
    const id = crypto.randomUUID();
    users[role] = id;
    await db('users').insert({ id, username: role, display_name: `Test ${role}`, role, password_hash: hash, active: true, must_change_password: false, failed_logins: 0, created_at: now, updated_at: now });
  }
  const depId = crypto.randomUUID();
  await db('departments').insert({ id: depId, name: 'Warehouse', notification_email: 'warehouse-dl@example.com', active: true, created_at: now, updated_at: now });
  const empId = crypto.randomUUID();
  await db('employees').insert({ id: empId, full_name: 'Host Example', email: 'host@example.com', department_id: depId, active: true, created_at: now, updated_at: now });
  const empNoEmail = crypto.randomUUID();
  await db('employees').insert({ id: empNoEmail, full_name: 'No Mail Example', email: null, department_id: null, active: true, created_at: now, updated_at: now });

  // An enrolled gate tablet for the guard.
  const deviceId = crypto.randomUUID();
  const deviceSecret = crypto.randomBytes(32).toString('base64url');
  await db('devices').insert({ id: deviceId, name: 'Test gate tablet', secret_hash: sha256Hex(deviceSecret), enrolled_at: now, created_at: now });

  return {
    ctx, app, db, email, users, depId, empId, empNoEmail, storageDir, device: { id: deviceId, secret: deviceSecret },
    close: async () => {
      await db.destroy();
      fs.rmSync(storageDir, { recursive: true, force: true });
    },
  };
}

export type Harness = Awaited<ReturnType<typeof setup>>;

export type Agent = Awaited<ReturnType<typeof agentFor>>;

/**
 * Returns a client signed in as the given role, with the CSRF header pre-set.
 * Guards sign in the way the tablet app does (enrolled device → bearer token); everyone else via the web cookie.
 */
export async function agentFor(h: Harness, role: 'guard' | 'reception' | 'manager' | 'admin') {
  if (role === 'guard') return tabletAgent(h, 'guard');
  const agent = request.agent(h.app);
  const res = await agent.post('/api/auth/login').set('X-Requested-With', 'RhodesGatekeeper').send({ username: role, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login failed ${res.status} ${JSON.stringify(res.body)}`);
  const wrap = (m: 'get' | 'post' | 'patch' | 'put') => (url: string) => agent[m](url).set('X-Requested-With', 'RhodesGatekeeper');
  return { get: wrap('get'), post: wrap('post'), patch: wrap('patch'), put: wrap('put') };
}

export async function tabletAgent(h: Harness, username: string, device = h.device) {
  const res = await request(h.app).post('/api/auth/mobile/login')
    .set('X-Requested-With', 'RhodesGatekeeper').set('X-Device-Id', device.id).set('X-Device-Secret', device.secret)
    .send({ username, password: PASSWORD });
  if (res.status !== 200) throw new Error(`tablet login failed ${res.status} ${JSON.stringify(res.body)}`);
  const token = res.body.token as string;
  const wrap = (m: 'get' | 'post' | 'patch' | 'put') => (url: string) =>
    request(h.app)[m](url).set('X-Requested-With', 'RhodesGatekeeper').set('Authorization', `Bearer ${token}`);
  return { get: wrap('get'), post: wrap('post'), patch: wrap('patch'), put: wrap('put'), token };
}

/** A small valid JPEG (1×1 pixel) plus a few random bytes so each call has a distinct hash. */
export function jpegBase64(seed = Math.random()): string {
  const base = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');
  return Buffer.concat([base, Buffer.from(String(seed))]).toString('base64');
}

export function checkInBody(overrides: Record<string, unknown> = {}, idSeq = 1) {
  return {
    idempotencyKey: crypto.randomUUID(),
    visitType: 'customer',
    visitor: { fullName: 'Test Visitor', company: 'Example Co' },
    id: { documentType: 'emirates_id', status: 'scanned', method: 'camera_barcode', number: demoEmiratesId(idSeq), expiryDate: '2030-01-01' },
    privacyNoticeAck: true,
    ...overrides,
  };
}

/** Build a syntactically valid TD1 MRZ (fictional data) with correct check digits. */
export function buildTd1(p: { docNumber: string; eid: string; dob: string; sex: string; expiry: string; nationality: string; surname: string; given: string }) {
  const pad = (s: string, n: number) => (s + '<'.repeat(n)).slice(0, n);
  const docNo = pad(p.docNumber, 9);
  const l1 = pad(`IDARE${docNo}${mrzCheckDigit(docNo)}${p.eid}`, 30);
  const l2head = `${p.dob}${mrzCheckDigit(p.dob)}${p.sex}${p.expiry}${mrzCheckDigit(p.expiry)}${pad(p.nationality, 3)}`;
  const opt2 = '<'.repeat(11);
  const composite = mrzCheckDigit(l1.slice(5, 30) + l2head.slice(0, 7) + l2head.slice(8, 15) + opt2);
  const l2 = `${l2head}${opt2}${composite}`;
  const l3 = pad(`${p.surname}<<${p.given.replace(/ /g, '<')}`, 30);
  return [l1, l2, l3].join('\n');
}
