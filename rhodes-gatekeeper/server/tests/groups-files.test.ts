import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentFor, demoEmiratesId, jpegBase64, setup, tabletAgent, type Agent, type Harness } from './helpers.js';
import { GraphSharePoint, type SharePointTarget } from '../src/files/sharepoint.js';
import { processSharePointSync } from '../src/services/files.js';
import { runRetention } from '../src/services/retention.js';
import { safeName } from '../src/files/naming.js';

let h: Harness;
let t: Date;
beforeEach(async () => {
  t = new Date('2026-11-04T10:30:00Z'); // 14:30 in Dubai
  h = await setup({ now: () => t, env: { SESSION_TTL_HOURS: '100000' } });
});
afterEach(async () => { await h.close(); });

const person = (name: string, seq: number, extra: Record<string, unknown> = {}) => ({
  fullName: name, company: 'Example Co',
  id: { documentType: 'emirates_id', status: 'scanned', method: 'camera_ocr', number: demoEmiratesId(seq), expiryDate: '2030-01-01' },
  ...extra,
});

function meetingGroup(names: string[], start = 1) {
  return {
    idempotencyKey: crypto.randomUUID(), visitType: 'meeting', hostEmployeeId: h.empId, purpose: 'Supplier audit', privacyNoticeAck: true,
    visitors: names.map((n, i) => person(n, start + i, { badgeNumber: `B${i + 1}` })),
  };
}

function deliveryGroup(plate = 'DUBAI A 12345', start = 50) {
  return {
    idempotencyKey: crypto.randomUUID(), visitType: 'delivery', direction: 'collection', deliveryCompany: 'Demo Freight', purpose: 'Collect finished goods',
    departmentId: h.depId, vehiclePlate: plate, poNumber: 'po-45001234', privacyNoticeAck: true,
    visitors: [person('John Driver', start), person('Ali Helper', start + 1)],
  };
}

describe('group check-in', () => {
  it('checks in a group: one visit and Visitor ID per person, one folder, one email', async () => {
    const guard = await agentFor(h, 'guard');
    const res = await guard.post('/api/visit-groups').send(meetingGroup(['Nadia Sample Example', 'Sam Visitor', 'Taylor Guest']));
    expect(res.status).toBe(201);
    const { group, visits } = res.body;
    expect(visits).toHaveLength(3);
    const refs = visits.map((v: any) => v.referenceNo);
    expect(new Set(refs).size).toBe(3);
    expect(refs[1]).toBe(refs[0] + 1);
    expect(visits.map((v: any) => v.badgeNumber)).toEqual(['B1', 'B2', 'B3']);
    expect(visits.every((v: any) => v.group.id === group.id && v.host.name === 'Host Example')).toBe(true);
    expect(group.folderName).toBe('NADIA-SAMPLE-EXAMPLE_2026-11-04_1430');
    expect(group.folderPath).toBe('Visitors/2026/11/NADIA-SAMPLE-EXAMPLE_2026-11-04_1430');
    expect(group.visitorCount).toBe(3);
    expect(res.body.required).toHaveLength(3);

    const mails = await h.db('notifications');
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toBe('3 visitors arrived: Nadia Sample Example +2 — Meeting an employee');
    expect(mails[0].body_text).toContain(`V${refs[1]} Sam Visitor · badge B2`);
  });

  it('delivery: driver + helpers, plate-based folder, roles and direction', async () => {
    const guard = await agentFor(h, 'guard');
    const res = await guard.post('/api/visit-groups').send(deliveryGroup());
    expect(res.status).toBe(201);
    expect(res.body.group.folderName).toBe('DUBAI-A-12345_2026-11-04_1430');
    expect(res.body.group.folderPath).toMatch(/^Vehicles\/2026\/11\//);
    expect(res.body.group.direction).toBe('collection');
    expect(res.body.group.poNumber).toBe('PO-45001234');
    expect(res.body.visits.map((v: any) => v.group.role)).toEqual(['driver', 'helper']);
    expect((await h.db('notifications').first()).subject).toContain('DUBAI A 12345');
  });

  it('same plate twice in the same minute gets a unique folder (_2)', async () => {
    const guard = await agentFor(h, 'guard');
    const a = await guard.post('/api/visit-groups').send(deliveryGroup('DUBAI A 12345', 50));
    const b = await guard.post('/api/visit-groups').send(deliveryGroup('DUBAI A 12345', 60));
    expect(a.body.group.folderName).toBe('DUBAI-A-12345_2026-11-04_1430');
    expect(b.body.group.folderName).toBe('DUBAI-A-12345_2026-11-04_1430_2');
  });

  it('rejects the same ID twice in one group, and anyone already on site', async () => {
    const guard = await agentFor(h, 'guard');
    const g = meetingGroup(['A Person', 'B Person']);
    g.visitors[1].id.number = g.visitors[0].id.number;
    const dup = await guard.post('/api/visit-groups').send(g);
    expect(dup.status).toBe(400);
    expect(dup.body.error.details.fields['visitors.1.id.number']).toMatch(/Same ID/);

    await guard.post('/api/visit-groups').send(meetingGroup(['On Site'], 7));
    const again = await guard.post('/api/visit-groups').send(meetingGroup(['New Person', 'On Site Again'], 6)); // seq 7 again
    expect(again.status).toBe(409);
    expect(again.body.error.details.visitorIndex).toBe(1);
  });

  it('enforces the maximum group size from settings', async () => {
    await h.ctx.settings.update({ capture: { maxGroupSize: 2 } }, null);
    const guard = await agentFor(h, 'guard');
    expect((await guard.post('/api/visit-groups').send(meetingGroup(['A', 'B', 'C']))).status).toBe(400);
  });

  it('idempotent: a retried group submit returns the same group', async () => {
    const guard = await agentFor(h, 'guard');
    const body = meetingGroup(['A Person', 'B Person']);
    const [x, y] = await Promise.all([guard.post('/api/visit-groups').send(body), guard.post('/api/visit-groups').send(body)]);
    expect([x.status, y.status].sort()).toEqual([200, 201]);
    expect(x.body.group.id).toBe(y.body.group.id);
    expect(await h.db('visits')).toHaveLength(2);
  });

  it('check out one person, then the rest of the group together', async () => {
    const guard = await agentFor(h, 'guard');
    const { body } = await guard.post('/api/visit-groups').send(meetingGroup(['A', 'B', 'C']));
    t = new Date('2026-11-04T11:00:00Z');
    expect((await guard.post(`/api/visits/${body.visits[0].id}/check-out`).send({})).status).toBe(200);
    t = new Date('2026-11-04T12:00:00Z');
    const all = await guard.post(`/api/visit-groups/${body.group.id}/check-out`).send({});
    expect(all.status).toBe(200);
    expect(all.body.onSiteCount).toBe(0);
    const durations = (await h.db('visits').orderBy('group_position')).map((v) => v.checked_out_at);
    expect(durations.map((d) => new Date(d).toISOString())).toEqual(['2026-11-04T11:00:00.000Z', '2026-11-04T12:00:00.000Z', '2026-11-04T12:00:00.000Z']);
    expect((await guard.post(`/api/visit-groups/${body.group.id}/check-out`).send({})).status).toBe(409);
  });
});

async function upload(guard: Agent, groupId: string, body: Record<string, unknown>) {
  return guard.post(`/api/visit-groups/${groupId}/files`).send({ dataBase64: jpegBase64(), ...body });
}

describe('files and folders', () => {
  it('auto-names, encrypts and stores ID images per visitor in the group folder', async () => {
    const guard = await agentFor(h, 'guard');
    const { body } = await guard.post('/api/visit-groups').send(meetingGroup(['Nadia Sample Example', 'Sam Visitor']));
    const [v1, v2] = body.visits;
    const f1 = await upload(guard, body.group.id, { kind: 'id_front', visitId: v1.id });
    const f2 = await upload(guard, body.group.id, { kind: 'id_back', visitId: v1.id });
    const f3 = await upload(guard, body.group.id, { kind: 'id_front', visitId: v2.id });
    expect([f1.status, f2.status, f3.status]).toEqual([201, 201, 201]);
    expect(f1.body.fileName).toBe(`V${v1.referenceNo}_NADIA-SAMPLE-EXAMPLE_EID-front.jpg`);
    expect(f2.body.fileName).toBe(`V${v1.referenceNo}_NADIA-SAMPLE-EXAMPLE_EID-back.jpg`);
    expect(f3.body.fileName).toBe(`V${v2.referenceNo}_SAM-VISITOR_EID-front.jpg`);
    // A retake for the same slot gets a numbered name
    const retake = await upload(guard, body.group.id, { kind: 'id_front', visitId: v1.id });
    expect(retake.body.fileName).toBe(`V${v1.referenceNo}_NADIA-SAMPLE-EXAMPLE_EID-front-2.jpg`);

    // On disk: in the folder, encrypted (no JPEG header), and not readable as an image
    const onDisk = path.join(h.storageDir, body.group.folderPath, `${f1.body.fileName}.enc`);
    const raw = fs.readFileSync(onDisk);
    expect(raw.subarray(0, 4).toString()).toBe('RGF1');
    expect(raw.includes(Buffer.from([0xff, 0xd8, 0xff]))).toBe(false);
  });

  it('retried upload of identical bytes is not stored twice', async () => {
    const guard = await agentFor(h, 'guard');
    const { body } = await guard.post('/api/visit-groups').send(meetingGroup(['A Person']));
    const data = jpegBase64(1);
    const a = await upload(guard, body.group.id, { kind: 'id_front', visitId: body.visits[0].id, dataBase64: data });
    const b = await upload(guard, body.group.id, { kind: 'id_front', visitId: body.visits[0].id, dataBase64: data });
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(b.body.id).toBe(a.body.id);
  });

  it('vehicle folder: plate photo and PO/invoice named after the plate and document number', async () => {
    const guard = await agentFor(h, 'guard');
    const { body } = await guard.post('/api/visit-groups').send(deliveryGroup());
    const plate = await upload(guard, body.group.id, { kind: 'plate' });
    const pdf = Buffer.from('%PDF-1.4\n% demo purchase order\n').toString('base64');
    const po = await upload(guard, body.group.id, { kind: 'po', dataBase64: pdf, docNumber: '45001234', ocrText: 'PURCHASE ORDER PO No 45001234 Vanilla base 200 kg' });
    const inv = await upload(guard, body.group.id, { kind: 'invoice', docNumber: 'INV-77' });
    expect(plate.body.fileName).toBe('DUBAI-A-12345_plate_1.jpg');
    expect(po.body.fileName).toBe('DUBAI-A-12345_PO-45001234_1.pdf');
    expect(inv.body.fileName).toBe('DUBAI-A-12345_INVOICE-INV-77_1.jpg');
    const driver = await upload(guard, body.group.id, { kind: 'id_front', visitId: body.visits[0].id });
    expect(driver.body.fileName).toBe(`V${body.visits[0].referenceNo}_DRIVER_JOHN-DRIVER_EID-front.jpg`);
    expect((await h.db('visit_groups').first()).invoice_number).toBe('INV-77');
  });

  it('rejects disguised files, PDFs for ID/plate photos, and visitors from another group', async () => {
    const guard = await agentFor(h, 'guard');
    const a = await guard.post('/api/visit-groups').send(meetingGroup(['A Person']));
    const b = await guard.post('/api/visit-groups').send(meetingGroup(['B Person'], 20));
    const html = Buffer.from('<html><script>alert(1)</script></html>').toString('base64');
    expect((await upload(guard, a.body.group.id, { kind: 'document', dataBase64: html })).status).toBe(400);
    const pdf = Buffer.from('%PDF-1.4 x').toString('base64');
    expect((await upload(guard, a.body.group.id, { kind: 'id_front', visitId: a.body.visits[0].id, dataBase64: pdf })).status).toBe(400);
    expect((await upload(guard, a.body.group.id, { kind: 'id_front', visitId: b.body.visits[0].id })).status).toBe(400);
    expect((await upload(guard, a.body.group.id, { kind: 'id_front' })).status).toBe(400);
  });

  it('respects the "store ID images" setting and the 24-hour upload window', async () => {
    const guard = await agentFor(h, 'guard');
    const { body } = await guard.post('/api/visit-groups').send(meetingGroup(['A Person']));
    await h.ctx.settings.update({ capture: { storeIdImages: false } }, null);
    expect((await upload(guard, body.group.id, { kind: 'id_front', visitId: body.visits[0].id })).body.error.code).toBe('ID_IMAGES_DISABLED');
    await h.ctx.settings.update({ capture: { storeIdImages: true } }, null);
    t = new Date('2026-11-05T11:00:00Z');
    expect((await upload(guard, body.group.id, { kind: 'id_front', visitId: body.visits[0].id })).body.error.code).toBe('UPLOAD_WINDOW_CLOSED');
  });

  it('ID images: managers can open them (audited); reception cannot; documents visible to both', async () => {
    const guard = await agentFor(h, 'guard');
    const { body } = await guard.post('/api/visit-groups').send(deliveryGroup());
    const id = await upload(guard, body.group.id, { kind: 'id_front', visitId: body.visits[0].id, dataBase64: jpegBase64(42) });
    const plate = await upload(guard, body.group.id, { kind: 'plate' });
    const reception = await agentFor(h, 'reception');
    const manager = await agentFor(h, 'manager');

    expect((await reception.get(`/api/files/${id.body.id}/content`)).status).toBe(403);
    expect((await reception.get(`/api/files/${plate.body.id}/content`)).status).toBe(200);
    const img = await manager.get(`/api/files/${id.body.id}/content`).buffer(true);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/jpeg');
    expect(img.headers['cache-control']).toContain('no-store');
    expect(Buffer.from(img.body).equals(Buffer.from(jpegBase64(42), 'base64'))).toBe(true);
    expect(await h.db('audit_logs').where({ action: 'file.view_id' })).toHaveLength(1);
    expect((await guard.get(`/api/files/${plate.body.id}/content`)).status).toBe(403); // guards upload only

    const folder = await reception.get(`/api/folders/${body.group.id}`);
    expect(folder.body.files).toHaveLength(2);
    expect(folder.body.canViewIdImages).toBe(false);
    expect(folder.body.visits).toHaveLength(2);
  });

  it('folder ZIP: managers only, contains the auto-named files, audited', async () => {
    const guard = await agentFor(h, 'guard');
    const { body } = await guard.post('/api/visit-groups').send(deliveryGroup());
    await upload(guard, body.group.id, { kind: 'plate' });
    await upload(guard, body.group.id, { kind: 'id_front', visitId: body.visits[0].id });
    expect((await (await agentFor(h, 'reception')).get(`/api/folders/${body.group.id}/download.zip`)).status).toBe(403);
    const zip = await (await agentFor(h, 'manager')).get(`/api/folders/${body.group.id}/download.zip`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(zip.status).toBe(200);
    const buf = zip.body as Buffer;
    expect(buf.subarray(0, 2).toString()).toBe('PK');
    expect(buf.includes(Buffer.from('DUBAI-A-12345_2026-11-04_1430/DUBAI-A-12345_plate_1.jpg'))).toBe(true);
    expect(buf.includes(Buffer.from('_DRIVER_JOHN-DRIVER_EID-front.jpg'))).toBe(true);
    expect(await h.db('audit_logs').where({ action: 'folder.download' })).toHaveLength(1);
  });
});

describe('search', () => {
  it('finds visits, folders and files by name, Visitor/Group ID, full ID number, plate, PO and file name', async () => {
    const guard = await agentFor(h, 'guard');
    const m = await guard.post('/api/visit-groups').send(meetingGroup(['Nadia Sample Example', 'Sam Visitor'], 100));
    const d = await guard.post('/api/visit-groups').send(deliveryGroup('SHARJAH 3 4567', 200));
    await upload(guard, d.body.group.id, { kind: 'po', docNumber: '45009999', ocrText: 'PURCHASE ORDER 45009999 strawberry puree' });
    const rec = await agentFor(h, 'reception');
    const s = async (q: string) => (await rec.get(`/api/search?q=${encodeURIComponent(q)}`)).body;

    expect((await s('sam visitor')).visits.map((v: any) => v.visitorName)).toEqual(['Sam Visitor']);
    const ref = m.body.visits[1].referenceNo;
    expect((await s(`V${ref}`)).visits[0].referenceNo).toBe(ref);
    expect((await s(`G${m.body.group.groupNo}`)).folders[0].id).toBe(m.body.group.id);
    expect((await s(demoEmiratesId(101))).visits.map((v: any) => v.visitorName)).toEqual(['Sam Visitor']);
    expect(await h.db('audit_logs').where({ action: 'search.id_number' })).toHaveLength(1);
    const plate = await s('sharjah 3-4567');
    expect(plate.folders[0].vehiclePlate).toBe('SHARJAH 3 4567');
    expect(plate.visits).toHaveLength(2);
    expect((await s('PO-45001234')).folders[0].id).toBe(d.body.group.id);
    expect((await s('strawberry')).files[0].kind).toBe('po');
    expect((await s('NADIA-SAMPLE')).folders[0].folderName).toBe('NADIA-SAMPLE-EXAMPLE_2026-11-04_1430');
    expect((await (await agentFor(h, 'guard')).get('/api/search?q=sam')).status).toBe(403);
  });

  it('folder list filters by visitors / vehicles and date', async () => {
    const guard = await agentFor(h, 'guard');
    await guard.post('/api/visit-groups').send(meetingGroup(['A Person']));
    await guard.post('/api/visit-groups').send(deliveryGroup());
    const rec = await agentFor(h, 'reception');
    expect((await rec.get('/api/folders?type=vehicles')).body.items.map((f: any) => f.folderName)).toEqual(['DUBAI-A-12345_2026-11-04_1430']);
    expect((await rec.get('/api/folders?type=visitors')).body.total).toBe(1);
    expect((await rec.get('/api/folders?from=2026-11-05&to=2026-11-05')).body.total).toBe(0);
  });
});

describe('gate tablets and sign-in channels', () => {
  it('guards cannot sign in on the web; staff cannot sign in on a tablet', async () => {
    const web = await request(h.app).post('/api/auth/login').set('X-Requested-With', 'RhodesGatekeeper').send({ username: 'guard', password: 'Test-Password-123' });
    expect(web.status).toBe(403);
    expect(web.body.error.code).toBe('WRONG_CLIENT');
    await expect(tabletAgent(h, 'reception')).rejects.toThrow(/403/);
  });

  it('tablet sign-in requires an enrolled device; enrolment code is single use', async () => {
    const admin = await agentFor(h, 'admin');
    const created = await admin.post('/api/admin/devices').send({ name: 'Gate 2 tablet' });
    expect(created.status).toBe(201);
    const code = created.body.enrollmentCode as string;
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const noDevice = await request(h.app).post('/api/auth/mobile/login').set('X-Requested-With', 'RhodesGatekeeper').send({ username: 'guard', password: 'Test-Password-123' });
    expect(noDevice.body.error.code).toBe('DEVICE_NOT_ENROLLED');

    const enroll = await request(h.app).post('/api/device/enroll').set('X-Requested-With', 'RhodesGatekeeper').send({ code: code.toLowerCase().replace('-', ' '), platform: 'android' });
    expect(enroll.status).toBe(201);
    const again = await request(h.app).post('/api/device/enroll').set('X-Requested-With', 'RhodesGatekeeper').send({ code });
    expect(again.body.error.code).toBe('INVALID_CODE');
    const guard = await tabletAgent(h, 'guard', { id: enroll.body.deviceId, secret: enroll.body.deviceSecret });
    expect((await guard.get('/api/visits/on-site')).status).toBe(200);
  });

  it('revoking a tablet ends its sessions immediately', async () => {
    const guard = await agentFor(h, 'guard');
    expect((await guard.get('/api/visits/on-site')).status).toBe(200);
    await (await agentFor(h, 'admin')).post(`/api/admin/devices/${h.device.id}/revoke`).send({});
    expect((await guard.get('/api/visits/on-site')).status).toBe(401);
    await expect(tabletAgent(h, 'guard')).rejects.toThrow(/DEVICE_NOT_ENROLLED/);
  });

  it('a bearer token is not accepted as a web cookie, and vice versa', async () => {
    const guard = await agentFor(h, 'guard');
    const asCookie = await request(h.app).get('/api/visits/on-site').set('Cookie', `rg_session=${guard.token}`);
    expect(asCookie.status).toBe(401);
    const web = await request(h.app).post('/api/auth/login').set('X-Requested-With', 'RhodesGatekeeper').send({ username: 'reception', password: 'Test-Password-123' });
    const cookieToken = String(web.headers['set-cookie']).match(/rg_session=([^;]+)/)![1];
    expect((await request(h.app).get('/api/visits').set('Authorization', `Bearer ${cookieToken}`)).status).toBe(401);
  });

  it('CORS: tablet app origins get a preflight answer without credentials; other sites do not', async () => {
    const ok = await request(h.app).options('/api/visit-groups').set('Origin', 'capacitor://localhost').set('Access-Control-Request-Method', 'POST');
    expect(ok.status).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe('capacitor://localhost');
    expect(ok.headers['access-control-allow-credentials']).toBeUndefined();
    const evil = await request(h.app).options('/api/visit-groups').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST');
    expect(evil.status).toBe(403);
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('reception can no longer create check-ins (gate is tablet-only)', async () => {
    const rec = await agentFor(h, 'reception');
    expect((await rec.post('/api/visit-groups').send(meetingGroup(['A']))).status).toBe(403);
  });
});

describe('SharePoint copy', () => {
  function fakeSharePoint() {
    const uploads: { path: string; size: number }[] = [];
    const deleted: string[] = [];
    let fail = 0;
    const sp: SharePointTarget & { uploads: typeof uploads; deleted: string[]; failNext: (n: number) => void } = {
      enabled: true, uploads, deleted,
      failNext: (n) => { fail = n; },
      async upload(p, data) {
        if (fail > 0) { fail--; throw new Error('HTTP 503'); }
        uploads.push({ path: p, size: data.length });
        return { itemId: `item-${uploads.length}`, parentId: `folder-${p.split('/').slice(0, -1).join('/')}` };
      },
      async deleteItem(id) { deleted.push(id); },
    };
    return sp;
  }

  it('queues each upload, copies it to the same folder path, and retries failures', async () => {
    await h.close();
    const sp = fakeSharePoint();
    h = await setup({ now: () => t, sharepoint: sp, env: { SESSION_TTL_HOURS: '100000' } });
    const guard = await agentFor(h, 'guard');
    const { body } = await guard.post('/api/visit-groups').send(deliveryGroup());
    await upload(guard, body.group.id, { kind: 'plate' });
    sp.failNext(1);
    expect(await processSharePointSync(h.ctx)).toEqual({ uploaded: 0, deleted: 0, failed: 1 });
    t = new Date(t.getTime() + 10 * 60_000);
    expect(await processSharePointSync(h.ctx)).toEqual({ uploaded: 1, deleted: 0, failed: 0 });
    expect(sp.uploads[0].path).toBe('Vehicles/2026/11/DUBAI-A-12345_2026-11-04_1430/DUBAI-A-12345_plate_1.jpg');
    expect((await h.db('files').first()).sp_status).toBe('synced');
    expect((await h.db('visit_groups').first()).sp_folder_item_id).toBe('folder-Vehicles/2026/11/DUBAI-A-12345_2026-11-04_1430');
  });

  it('Graph client: simple PUT for small files, upload session for large ones, no auth header on session URL', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      const u = String(url);
      if (u.includes('/oauth2/')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
      if (u.endsWith('createUploadSession')) return new Response(JSON.stringify({ uploadUrl: 'https://upload.example/session1' }));
      return new Response(JSON.stringify({ id: 'ITEM', parentReference: { id: 'PARENT' } }), { status: 201 });
    }) as unknown as typeof fetch;
    const g = new GraphSharePoint({ tenantId: 't', clientId: 'c', clientSecret: 's', driveId: 'b!drive', basePath: 'Rhodes Gatekeeper' }, fake);
    const r = await g.upload('Vehicles/2026/11/DUBAI-A-12345_2026-11-04_1430/x.jpg', Buffer.alloc(100), 'image/jpeg');
    expect(r).toEqual({ itemId: 'ITEM', parentId: 'PARENT' });
    expect(calls[1].url).toBe('https://graph.microsoft.com/v1.0/drives/b!drive/root:/Rhodes%20Gatekeeper/Vehicles/2026/11/DUBAI-A-12345_2026-11-04_1430/x.jpg:/content?@microsoft.graph.conflictBehavior=replace');
    expect((calls[1].init.headers as Record<string, string>).Authorization).toBe('Bearer tok');

    calls.length = 0;
    await g.upload('Visitors/a.pdf', Buffer.alloc(7 * 1024 * 1024), 'application/pdf');
    const chunks = calls.filter((c) => c.url === 'https://upload.example/session1');
    expect(chunks).toHaveLength(3);
    expect((chunks[0].init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect((chunks[2].init.headers as Record<string, string>)['Content-Range']).toBe(`bytes ${2 * 3276800}-${7 * 1024 * 1024 - 1}/${7 * 1024 * 1024}`);
  });
});

describe('retention of files', () => {
  it('deletes ID images after their own period, keeps documents; later anonymises the folder', async () => {
    await h.close();
    const fakeSp: SharePointTarget = { enabled: true, async upload(p) { return { itemId: `i-${p}`, parentId: 'PARENT' }; }, async deleteItem() {} };
    h = await setup({ now: () => t, sharepoint: fakeSp, env: { SESSION_TTL_HOURS: '100000' } });
    const guard = await agentFor(h, 'guard');
    const { body } = await guard.post('/api/visit-groups').send(meetingGroup(['Nadia Sample Example']));
    await upload(guard, body.group.id, { kind: 'id_front', visitId: body.visits[0].id });
    await upload(guard, body.group.id, { kind: 'document' });
    await processSharePointSync(h.ctx);
    await guard.post(`/api/visit-groups/${body.group.id}/check-out`).send({});
    await h.ctx.settings.update({ retention: { enabled: true, idImageDays: 30, visitorDataDays: 365, mode: 'anonymize', auditLogDays: 730, notificationDays: 90 } }, null);
    const admin = { id: null, username: 'test' };

    t = new Date('2026-12-15T10:00:00Z'); // 41 days later
    const r1 = await runRetention(h.ctx, admin);
    expect(r1.idImagesDeleted).toBe(1);
    const files = await h.db('files').orderBy('kind');
    expect(files.find((f) => f.kind === 'id_front').deleted_at).not.toBeNull();
    expect(files.find((f) => f.kind === 'id_front').file_name).not.toContain('NADIA');
    expect(files.find((f) => f.kind === 'document').deleted_at).toBeNull();
    expect(await h.db('sp_deletions')).toHaveLength(1);
    const left = fs.readdirSync(path.join(h.storageDir, body.group.folderPath));
    expect(left).toHaveLength(1);

    t = new Date('2027-12-01T10:00:00Z'); // past the visitor-data period
    const r2 = await runRetention(h.ctx, admin);
    expect(r2.filesDeleted).toBe(1);
    const g = await h.db('visit_groups').first();
    expect(g.folder_name).toBe(`ANONYMISED_G${body.group.groupNo}`);
    expect(fs.existsSync(path.join(h.storageDir, body.group.folderPath))).toBe(false);
    expect((await h.db('visitors').first()).full_name).toBe('Anonymised visitor');
  });
});

describe('naming', () => {
  it('produces file-system and SharePoint safe names', () => {
    expect(safeName('José  O\'Brien / "Test"#%')).toBe('JOSE-O-BRIEN-TEST');
    expect(safeName('')).toBe('UNKNOWN');
    expect(safeName('محمد أحمد')).toBe('محمد-أحمد');
  });
});
