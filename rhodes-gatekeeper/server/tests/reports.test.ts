import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentFor, checkInBody, setup, type Harness } from './helpers.js';
import { loadConfig } from '../src/config.js';

let h: Harness;
let t: Date;
beforeEach(async () => {
  t = new Date('2026-10-05T05:00:00Z'); // 09:00 in Dubai
  h = await setup({ now: () => t, env: { SESSION_TTL_HOURS: '100000' } });
});
afterEach(async () => { await h.close(); });

async function visit(guard: Awaited<ReturnType<typeof agentFor>>, at: string, minutes: number | null, body: Record<string, unknown>, seq: number) {
  t = new Date(at);
  const r = await guard.post('/api/visits').send(checkInBody(body, seq));
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  if (minutes !== null) {
    t = new Date(Date.parse(at) + minutes * 60_000);
    await guard.post(`/api/visits/${r.body.visit.id}/check-out`).send({});
  }
  return r.body.visit.id as string;
}

describe('reports', () => {
  it('monthly summary groups by employee/department/type and handles missing check-outs', async () => {
    const guard = await agentFor(h, 'guard');
    const reception = await agentFor(h, 'reception');
    await visit(guard, '2026-10-05T05:00:00Z', 60, { visitType: 'meeting', hostEmployeeId: h.empId, purpose: 'A' }, 1);
    await visit(guard, '2026-10-06T05:00:00Z', 30, { visitType: 'meeting', hostEmployeeId: h.empId, purpose: 'B' }, 2);
    await visit(guard, '2026-10-07T05:00:00Z', null, { visitType: 'meeting', hostEmployeeId: h.empId, purpose: 'C' }, 3); // never checked out
    await visit(guard, '2026-10-08T05:00:00Z', 20, { visitType: 'delivery', deliveryCompany: 'X', purpose: 'Y', departmentId: h.depId, vehiclePlate: 'DUBAI A 12345' }, 4);
    await visit(guard, '2026-09-30T19:30:00Z', 10, { visitType: 'customer' }, 5); // 23:30 Sep 30 Dubai → September
    await visit(guard, '2026-09-30T20:30:00Z', 10, { visitType: 'customer' }, 6); // 00:30 Oct 1 Dubai → October

    t = new Date('2026-10-20T08:00:00Z');
    const res = await reception.get('/api/reports/summary?month=2026-10');
    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({ visits: 5, completed: 4, missingCheckout: 1, totalMinutes: 120, averageMinutes: 30 });
    const host = res.body.byEmployee.find((e: any) => e.label === 'Host Example');
    expect(host).toMatchObject({ visits: 3, completed: 2, missingCheckout: 1, totalMinutes: 90, averageMinutes: 45 });
    expect(res.body.byType.find((x: any) => x.key === 'delivery').visits).toBe(1);
    expect(res.body.byDepartment.find((x: any) => x.label === 'Warehouse').visits).toBe(4);
    expect(res.body.durationDefinition).toMatch(/not a record of how long/);

    const filtered = await reception.get(`/api/reports/summary?month=2026-10&employeeId=${h.empId}`);
    expect(filtered.body.totals.visits).toBe(3);
    const byType = await reception.get('/api/reports/summary?from=2026-10-01&to=2026-10-31&visitType=customer');
    expect(byType.body.totals.visits).toBe(1);
  });

  it('CSV export: local times, missing check-outs labelled, definition note, audited', async () => {
    const guard = await agentFor(h, 'guard');
    const reception = await agentFor(h, 'reception');
    await visit(guard, '2026-10-05T05:00:00Z', 45, { visitType: 'customer', visitor: { fullName: '=cmd|calc', company: 'Co' } }, 1);
    await visit(guard, '2026-10-06T05:00:00Z', null, { visitType: 'customer' }, 2);
    const res = await reception.get('/api/reports/export.csv?month=2026-10');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const csv = res.text;
    expect(csv).toContain('2026-10-05 09:00'); // Dubai local time
    expect(csv).toContain('2026-10-05 09:45');
    expect(csv).toContain('NOT CHECKED OUT');
    expect(csv).toContain("'=cmd|calc");
    expect(csv).toMatch(/not a record of how long/);
    expect(await h.db('audit_logs').where({ action: 'report.export' })).toHaveLength(1);
  });

  it('dashboard: on-site, today counts, overdue visitors not checked out', async () => {
    const guard = await agentFor(h, 'guard');
    const reception = await agentFor(h, 'reception');
    await visit(guard, '2026-10-04T05:00:00Z', null, { visitType: 'customer' }, 1); // yesterday, still on site
    await visit(guard, '2026-10-05T05:00:00Z', 30, { visitType: 'customer' }, 2);
    await visit(guard, '2026-10-05T06:00:00Z', null, { visitType: 'other', purpose: 'Inspection' }, 3);
    t = new Date('2026-10-05T08:00:00Z');
    const res = await reception.get('/api/dashboard');
    expect(res.body.today).toBe('2026-10-05');
    expect(res.body.onSiteCount).toBe(2);
    expect(res.body.todayStats.totals.visits).toBe(2);
    expect(res.body.notCheckedOut).toHaveLength(1);
    expect(res.body.selected.totals.averageMinutes).toBe(30);
  });

  it('retention (anonymise) removes personal data from old finished visits but keeps statistics', async () => {
    const guard = await agentFor(h, 'guard');
    const admin = await agentFor(h, 'admin');
    await visit(guard, '2026-01-05T05:00:00Z', 30, { visitType: 'customer', visitor: { fullName: 'Old Visitor', company: 'Old Co' } }, 1);
    await visit(guard, '2026-10-05T05:00:00Z', 30, { visitType: 'customer', visitor: { fullName: 'Recent Visitor' } }, 2);
    t = new Date('2026-10-05T09:00:00Z');
    await h.ctx.settings.update({ retention: { enabled: true, visitorDataDays: 180, mode: 'anonymize', auditLogDays: 730, notificationDays: 90 } }, null);
    const res = await admin.post('/api/admin/retention/run').send({});
    expect(res.body.visitorsAffected).toBe(1);
    const names = (await h.db('visitors').orderBy('created_at')).map((v) => v.full_name);
    expect(names).toEqual(['Anonymised visitor', 'Recent Visitor']);
    const old = await h.db('visitors').where({ full_name: 'Anonymised visitor' }).first();
    expect(old.id_number_hash).toBeNull();
    expect(old.id_number_masked).toBeNull();
    expect(await h.db('visits')).toHaveLength(2); // statistics kept
  });
});

describe('configuration safety', () => {
  it('refuses the dev email logger in production unless explicitly allowed', () => {
    const base = { NODE_ENV: 'production', DB_CLIENT: 'pg', DATABASE_URL: 'postgres://x', DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') };
    expect(() => loadConfig({ ...base, EMAIL_PROVIDER: 'devlog' })).toThrow(/NON-PRODUCTION/);
    expect(() => loadConfig({ ...base, EMAIL_PROVIDER: 'graph' })).toThrow(/M365_TENANT_ID/);
    expect(() => loadConfig({ ...base, EMAIL_PROVIDER: 'disabled' })).not.toThrow();
  });
  it('requires an encryption key and PostgreSQL in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', EMAIL_PROVIDER: 'disabled' })).toThrow(/PostgreSQL|DATA_ENCRYPTION_KEY/);
  });
});
