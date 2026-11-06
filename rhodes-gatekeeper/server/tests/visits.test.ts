import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentFor, buildTd1, checkInBody, demoEmiratesId, setup, type Harness } from './helpers.js';

let h: Harness;
beforeEach(async () => { h = await setup(); });
afterEach(async () => { await h.close(); });

describe('check-in workflow', () => {
  it('meeting: requires a host and purpose, then checks in', async () => {
    const guard = await agentFor(h, 'guard');
    const missing = await guard.post('/api/visits').send(checkInBody({ visitType: 'meeting' }));
    expect(missing.status).toBe(400);
    expect(missing.body.error.details.fields).toHaveProperty('hostEmployeeId');
    expect(missing.body.error.details.fields).toHaveProperty('purpose');

    const ok = await guard.post('/api/visits').send(checkInBody({ visitType: 'meeting', hostEmployeeId: h.empId, purpose: 'Supplier review' }));
    expect(ok.status).toBe(201);
    expect(ok.body.visit.status).toBe('on_site');
    expect(ok.body.visit.host.name).toBe('Host Example');
    expect(ok.body.visit.department.name).toBe('Warehouse'); // inherited from host
    expect(ok.body.visit.checkedInAt).toMatch(/Z$/);
    expect(ok.body.visit.referenceNo).toBeGreaterThan(1000);
  });

  it('meeting: accepts a free-text host when the employee is not in the directory', async () => {
    const guard = await agentFor(h, 'guard');
    const ok = await guard.post('/api/visits').send(checkInBody({ visitType: 'meeting', hostName: 'Visiting Auditor Lead', purpose: 'Audit' }));
    expect(ok.status).toBe(201);
    expect(ok.body.visit.host).toMatchObject({ employeeId: null, name: 'Visiting Auditor Lead' });
  });

  it('delivery: requires company, purpose and a receiving employee or department', async () => {
    const guard = await agentFor(h, 'guard');
    const bad = await guard.post('/api/visits').send(checkInBody({ visitType: 'delivery' }));
    expect(Object.keys(bad.body.error.details.fields)).toEqual(expect.arrayContaining(['deliveryCompany', 'purpose', 'departmentId', 'vehiclePlate']));
    const ok = await guard.post('/api/visits').send(checkInBody({ visitType: 'delivery', deliveryCompany: 'Demo Freight', purpose: 'Packaging', departmentId: h.depId, vehiclePlate: 'DUBAI A 12345' }));
    expect(ok.status).toBe(201);
    expect(ok.body.visit.deliveryCompany).toBe('Demo Freight');
  });

  it('customer: no host required, optional sales reference', async () => {
    const guard = await agentFor(h, 'guard');
    const ok = await guard.post('/api/visits').send(checkInBody({ visitType: 'customer', salesReference: 'SO-123' }));
    expect(ok.status).toBe(201);
    expect(ok.body.visit.host).toBeNull();
    expect(ok.body.visit.salesReference).toBe('SO-123');
  });

  it('other: requires a description', async () => {
    const guard = await agentFor(h, 'guard');
    expect((await guard.post('/api/visits').send(checkInBody({ visitType: 'other' }))).status).toBe(400);
    expect((await guard.post('/api/visits').send(checkInBody({ visitType: 'other', purpose: 'Fire safety inspection' }))).status).toBe(201);
  });

  it('enforces privacy-notice acknowledgement and ID policy from settings', async () => {
    const guard = await agentFor(h, 'guard');
    expect((await guard.post('/api/visits').send(checkInBody({ privacyNoticeAck: false }))).status).toBe(400);
    const noId = checkInBody({ id: { documentType: 'none', status: 'not_provided' } });
    expect((await guard.post('/api/visits').send(noId)).status).toBe(400);
    await h.ctx.settings.update({ requireIdDocument: false }, null);
    expect((await guard.post('/api/visits').send({ ...noId, idempotencyKey: crypto.randomUUID() })).status).toBe(201);
  });

  it('validates the Emirates ID number format', async () => {
    const guard = await agentFor(h, 'guard');
    const res = await guard.post('/api/visits').send(checkInBody({ id: { documentType: 'emirates_id', status: 'manual', number: '123' } }));
    expect(res.status).toBe(400);
    expect(res.body.error.details.fields['id.number']).toMatch(/784/);
  });

  it('duplicate submission (same idempotency key) returns the original visit, not a second one', async () => {
    const guard = await agentFor(h, 'guard');
    const body = checkInBody();
    const [a, b] = await Promise.all([guard.post('/api/visits').send(body), guard.post('/api/visits').send(body)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 201]);
    expect(a.body.visit.id).toBe(b.body.visit.id);
    const [{ n }] = await h.db('visits').count({ n: '*' });
    expect(Number(n)).toBe(1);
  });

  it('blocks checking in the same ID twice while on site, and points to the open visit', async () => {
    const guard = await agentFor(h, 'guard');
    const first = await guard.post('/api/visits').send(checkInBody({}, 7));
    const second = await guard.post('/api/visits').send(checkInBody({}, 7));
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('ALREADY_ON_SITE');
    expect(second.body.error.details.visitId).toBe(first.body.visit.id);
  });

  it('check-out records a timestamp and duration; double check-out is rejected', async () => {
    let t = new Date('2026-10-27T06:00:00Z');
    await h.close();
    h = await setup({ now: () => t });
    const guard = await agentFor(h, 'guard');
    const { body } = await guard.post('/api/visits').send(checkInBody());
    t = new Date('2026-10-27T07:45:00Z');
    const out = await guard.post(`/api/visits/${body.visit.id}/check-out`).send({});
    expect(out.status).toBe(200);
    expect(out.body.checkedOutAt).toBe('2026-10-27T07:45:00.000Z');
    expect(out.body.durationMinutes).toBe(105);
    expect(out.body.checkoutMethod).toBe('gate');
    const again = await guard.post(`/api/visits/${body.visit.id}/check-out`).send({});
    expect(again.status).toBe(409);
  });

  it('on-site list shows only open visits with masked IDs', async () => {
    const guard = await agentFor(h, 'guard');
    const a = await guard.post('/api/visits').send(checkInBody({}, 1));
    await guard.post('/api/visits').send(checkInBody({}, 2));
    await guard.post(`/api/visits/${a.body.visit.id}/check-out`).send({});
    const list = await guard.get('/api/visits/on-site');
    expect(list.body).toHaveLength(1);
    expect(list.body[0].idNumberMasked).toMatch(/\*/);
    expect(JSON.stringify(list.body)).not.toContain(demoEmiratesId(2));
  });

  it('reception can correct a missed check-out; it is flagged as a manual correction', async () => {
    const guard = await agentFor(h, 'guard');
    const reception = await agentFor(h, 'reception');
    const { body } = await guard.post('/api/visits').send(checkInBody());
    const when = new Date(Date.now() + 1000).toISOString();
    expect((await reception.post(`/api/visits/${body.visit.id}/manual-check-out`).send({ checkedOutAt: when, reason: 'x' })).status).toBe(400);
    const ok = await reception.post(`/api/visits/${body.visit.id}/manual-check-out`).send({ checkedOutAt: new Date().toISOString(), reason: 'Left via side gate, confirmed by host' });
    expect(ok.status).toBe(200);
    expect(ok.body.checkoutMethod).toBe('manual_correction');
  });

  it('reception edits are audited by field name only (no values)', async () => {
    const guard = await agentFor(h, 'guard');
    const reception = await agentFor(h, 'reception');
    const { body } = await guard.post('/api/visits').send(checkInBody());
    const res = await reception.patch(`/api/visits/${body.visit.id}`).send({ visitor: { fullName: 'Corrected Name' }, purpose: 'Updated' });
    expect(res.status).toBe(200);
    expect(res.body.visitor.fullName).toBe('Corrected Name');
    const log = await h.db('audit_logs').where({ action: 'visit.update' }).first();
    expect(JSON.parse(log.details).changedFields).toEqual(['purpose', 'visitor.fullName']);
    expect(log.details).not.toContain('Corrected Name');
  });
});

describe('identity data minimisation', () => {
  it('stores only a masked ID and keyed hash by default, never the number', async () => {
    const guard = await agentFor(h, 'guard');
    const id = demoEmiratesId(55);
    await guard.post('/api/visits').send(checkInBody({}, 55));
    const v = await h.db('visitors').first();
    expect(v.id_number_encrypted).toBeNull();
    expect(v.id_number_masked).toMatch(/\*/);
    const dump = JSON.stringify(await Promise.all(['visitors', 'visits', 'audit_logs', 'notifications'].map((t) => h.db(t))));
    expect(dump).not.toContain(id);
    expect(dump).not.toContain(id.replace(/-/g, ''));
  });

  it('stores an encrypted full ID only when BOTH the environment and admin setting allow it; reveal is audited', async () => {
    await h.close();
    h = await setup({ env: { ALLOW_FULL_ID_STORAGE: 'true' } });
    const guard = await agentFor(h, 'guard');
    const admin = await agentFor(h, 'admin');
    await guard.post('/api/visits').send(checkInBody({}, 1));
    expect((await h.db('visitors').first()).id_number_encrypted).toBeNull(); // admin setting still off

    await h.ctx.settings.update({ storeFullIdNumber: true }, null);
    const { body } = await guard.post('/api/visits').send(checkInBody({}, 2));
    const row = await h.db('visitors').where({ id: body.visit.visitor.id }).first();
    expect(row.id_number_encrypted).toMatch(/^v1\./);
    expect(row.id_number_encrypted).not.toContain(demoEmiratesId(2).replace(/-/g, ''));

    expect((await admin.post(`/api/visits/${body.visit.id}/reveal-id`).send({ reason: '' })).status).toBe(400);
    const reveal = await admin.post(`/api/visits/${body.visit.id}/reveal-id`).send({ reason: 'Police request ref 123' });
    expect(reveal.body.idNumber).toBe(demoEmiratesId(2));
    expect(await h.db('audit_logs').where({ action: 'visitor.view_sensitive' })).toHaveLength(1);
  });

  it('a scanned ID is labelled "scanned", never "verified", without a verification service', async () => {
    const guard = await agentFor(h, 'guard');
    const res = await guard.post('/api/visits').send(checkInBody());
    expect(res.body.visit.idStatus).toBe('scanned');
  });

  it('scan endpoint parses MRZ and finds repeat visitors / on-site duplicates', async () => {
    const guard = await agentFor(h, 'guard');
    await guard.post('/api/visits').send(checkInBody({ visitor: { fullName: 'Returning Person', company: 'Repeat Co' } }, 9));
    const mrz = buildTd1({ docNumber: 'Z00000001', eid: demoEmiratesId(9).replace(/-/g, ''), dob: '850101', sex: 'M', expiry: '300101', nationality: 'ARE', surname: 'PERSON', given: 'RETURNING' });
    const res = await guard.post('/api/scan/parse').send({ raw: mrz });
    expect(res.status).toBe(200);
    expect(res.body.parsed.idNumber).toBe(demoEmiratesId(9));
    expect(res.body.lookup.previousVisitor.company).toBe('Repeat Co');
    expect(res.body.lookup.onSiteVisit).not.toBeNull();
    expect(res.body.verificationAvailable).toBe(false);
  });
});

describe('live events', () => {
  it('publishes ID-only events on check-in and check-out', async () => {
    const events: unknown[] = [];
    h.ctx.events.subscribe((e) => events.push(e));
    const guard = await agentFor(h, 'guard');
    const { body } = await guard.post('/api/visits').send(checkInBody());
    await guard.post(`/api/visits/${body.visit.id}/check-out`).send({});
    expect(events.map((e: any) => e.type)).toEqual(['visit.checked_in', 'visit.checked_out']);
    expect(Object.keys(events[0] as object).sort()).toEqual(['at', 'type', 'visitId']);
  });
});
