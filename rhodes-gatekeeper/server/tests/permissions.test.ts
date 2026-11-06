import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentFor, setup, type Harness } from './helpers.js';
import { can } from '../src/domain/permissions.js';

let h: Harness;
beforeEach(async () => { h = await setup(); });
afterEach(async () => { await h.close(); });

describe('authentication', () => {
  it('rejects unauthenticated API calls', async () => {
    expect((await request(h.app).get('/api/visits/on-site')).status).toBe(401);
    expect((await request(h.app).get('/api/dashboard')).status).toBe(401);
  });

  it('requires the CSRF header on state-changing requests', async () => {
    const res = await request(h.app).post('/api/auth/login').send({ username: 'guard', password: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF');
  });

  it('sets an httpOnly, SameSite=Strict session cookie', async () => {
    const res = await request(h.app).post('/api/auth/login').set('X-Requested-With', 'RhodesGatekeeper').send({ username: 'reception', password: 'Test-Password-123' });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
  });

  it('locks the account after repeated failures and audits them', async () => {
    const post = () => request(h.app).post('/api/auth/login').set('X-Requested-With', 'RhodesGatekeeper').send({ username: 'guard', password: 'wrong-password-1' });
    for (let i = 0; i < 5; i++) expect((await post()).status).toBe(401);
    const locked = await request(h.app).post('/api/auth/login').set('X-Requested-With', 'RhodesGatekeeper').send({ username: 'guard', password: 'Test-Password-123' });
    expect(locked.status).toBe(423);
    const fails = await h.db('audit_logs').where({ action: 'auth.login_failed' });
    expect(fails.length).toBe(5);
  });

  it('revokes sessions when a user is disabled', async () => {
    const guard = await agentFor(h, 'guard');
    const admin = await agentFor(h, 'admin');
    expect((await guard.get('/api/visits/on-site')).status).toBe(200);
    expect((await admin.patch(`/api/admin/users/${h.users.guard}`).send({ active: false })).status).toBe(200);
    expect((await guard.get('/api/visits/on-site')).status).toBe(401);
  });
});

describe('role-based authorisation (server-side)', () => {
  const cases: [string, 'get' | 'post' | 'put', string, { guard: number; reception: number; admin: number }][] = [
    ['on-site list', 'get', '/api/visits/on-site', { guard: 200, reception: 200, admin: 200 }],
    ['employee picker', 'get', '/api/directory/employees', { guard: 200, reception: 200, admin: 200 }],
    ['visit history', 'get', '/api/visits', { guard: 403, reception: 200, admin: 200 }],
    ['dashboard', 'get', '/api/dashboard', { guard: 403, reception: 200, admin: 200 }],
    ['monthly report', 'get', '/api/reports/summary', { guard: 403, reception: 200, admin: 200 }],
    ['CSV export', 'get', '/api/reports/export.csv', { guard: 403, reception: 200, admin: 200 }],
    ['manage users', 'get', '/api/admin/users', { guard: 403, reception: 403, admin: 200 }],
    ['manage employees', 'get', '/api/admin/employees', { guard: 403, reception: 403, admin: 200 }],
    ['settings', 'get', '/api/admin/settings', { guard: 403, reception: 403, admin: 200 }],
    ['audit log', 'get', '/api/admin/audit', { guard: 403, reception: 403, admin: 200 }],
    ['retention run', 'post', '/api/admin/retention/run', { guard: 403, reception: 403, admin: 200 }],
  ];
  for (const [name, method, url, expected] of cases) {
    it(`${name}: ${url}`, async () => {
      for (const role of ['guard', 'reception', 'admin'] as const) {
        const a = await agentFor(h, role);
        const res = await a[method](url);
        expect(res.status, `${role} ${method.toUpperCase()} ${url}`).toBe(expected[role]);
      }
    });
  }

  it('only admins may reveal stored full ID numbers', () => {
    expect(can('guard', 'visitor.view_sensitive')).toBe(false);
    expect(can('reception', 'visitor.view_sensitive')).toBe(false);
    expect(can('admin', 'visitor.view_sensitive')).toBe(true);
  });

  it('guards cannot edit visits or manually close them', async () => {
    const guard = await agentFor(h, 'guard');
    expect((await guard.patch('/api/visits/00000000-0000-0000-0000-000000000000').send({ purpose: 'x' })).status).toBe(403);
    expect((await guard.post('/api/visits/00000000-0000-0000-0000-000000000000/manual-check-out').send({})).status).toBe(403);
  });

  it('forces a password change before other actions when flagged', async () => {
    await h.db('users').where({ id: h.users.guard }).update({ must_change_password: true });
    const guard = await agentFor(h, 'guard');
    const res = await guard.get('/api/visits/on-site');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await guard.post('/api/auth/change-password').send({ currentPassword: 'Test-Password-123', newPassword: 'Brand-New-Pass-456' })).status).toBe(200);
    expect((await guard.get('/api/visits/on-site')).status).toBe(200);
  });

  it('prevents removing the last administrator', async () => {
    const admin = await agentFor(h, 'admin');
    const other = await admin.post('/api/admin/users').send({ username: 'admin2', displayName: 'Second', role: 'admin', password: 'Another-Pass-789' });
    expect(other.status).toBe(201);
    expect((await admin.patch(`/api/admin/users/${other.body.id}`).send({ role: 'guard' })).status).toBe(200);
    const self = await admin.patch(`/api/admin/users/${h.users.admin}`).send({ role: 'guard' });
    expect(self.status).toBe(409);
    // Even another actor cannot remove the only remaining active admin.
    const { updateUser } = await import('../src/services/users.js');
    await expect(updateUser(h.ctx, { id: 'cli', username: 'cli' }, h.users.admin, { active: false })).rejects.toMatchObject({ code: 'LAST_ADMIN' });
  });
});
