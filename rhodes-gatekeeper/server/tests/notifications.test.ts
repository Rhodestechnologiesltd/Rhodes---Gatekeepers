import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentFor, checkInBody, demoEmiratesId, setup, type Harness } from './helpers.js';
import { DevLogEmailProvider, GraphEmailProvider, type EmailMessage, type EmailProvider } from '../src/email/providers.js';
import { processOutbox } from '../src/services/notifications.js';

let h: Harness;
afterEach(async () => { await h?.close(); });

describe('visit notifications', () => {
  it('queues an email to the host on check-in and delivers it via the outbox', async () => {
    h = await setup();
    const guard = await agentFor(h, 'guard');
    await guard.post('/api/visits').send(checkInBody({ visitType: 'meeting', hostEmployeeId: h.empId, purpose: 'Review' }));
    const n = await h.db('notifications').first();
    expect(n.status).toBe('pending');
    expect(JSON.parse(n.recipients)).toEqual(['host@example.com']);
    expect(await processOutbox(h.ctx)).toEqual({ sent: 1, failed: 0 });
    const dev = h.email as DevLogEmailProvider;
    expect(dev.sent).toHaveLength(1);
    expect(dev.sent[0].subject).toMatch(/Visitor arrived: Test Visitor/);
  });

  it('never includes the ID number in email content', async () => {
    h = await setup();
    const guard = await agentFor(h, 'guard');
    await guard.post('/api/visits').send(checkInBody({ visitType: 'meeting', hostEmployeeId: h.empId, purpose: 'Review' }, 77));
    const n = await h.db('notifications').first();
    for (const s of [demoEmiratesId(77), demoEmiratesId(77).replace(/-/g, ''), '784-']) {
      expect(n.body_html).not.toContain(s);
      expect(n.body_text).not.toContain(s);
    }
  });

  it('escapes HTML in visitor-entered text', async () => {
    h = await setup();
    const guard = await agentFor(h, 'guard');
    await guard.post('/api/visits').send(checkInBody({ visitType: 'meeting', hostEmployeeId: h.empId, purpose: '<script>alert(1)</script>' }));
    const n = await h.db('notifications').first();
    expect(n.body_html).not.toContain('<script>');
    expect(n.body_html).toContain('&lt;script&gt;');
  });

  it('applies per-visit-type rules: department list + extra recipients, checkout notifications', async () => {
    h = await setup();
    const admin = await agentFor(h, 'admin');
    const put = await admin.put('/api/admin/notification-rules/delivery').send({
      enabled: true, notifyHost: false, notifyDepartment: true, extraRecipients: ['security@example.com'], notifyOnCheckout: true,
    });
    expect(put.status).toBe(200);
    const guard = await agentFor(h, 'guard');
    const { body } = await guard.post('/api/visits').send(checkInBody({ visitType: 'delivery', deliveryCompany: 'Demo Freight', purpose: 'Boxes', departmentId: h.depId, vehiclePlate: 'DUBAI A 12345', hostEmployeeId: h.empId }));
    await guard.post(`/api/visits/${body.visit.id}/check-out`).send({});
    const rows = await h.db('notifications').orderBy('created_at');
    expect(rows.map((r) => r.event)).toEqual(['visit.checked_in', 'visit.checked_out']);
    expect(JSON.parse(rows[0].recipients).sort()).toEqual(['security@example.com', 'warehouse-dl@example.com']);
  });

  it('records "skipped" when no recipient is configured, and nothing when the rule is disabled', async () => {
    h = await setup();
    const guard = await agentFor(h, 'guard');
    await guard.post('/api/visits').send(checkInBody({ visitType: 'meeting', hostEmployeeId: h.empNoEmail, purpose: 'x' }, 1));
    expect((await h.db('notifications').first()).status).toBe('skipped');
    const admin = await agentFor(h, 'admin');
    await admin.put('/api/admin/notification-rules/customer').send({ enabled: false, notifyHost: true, notifyDepartment: false, extraRecipients: ['a@example.com'], notifyOnCheckout: false });
    await guard.post('/api/visits').send(checkInBody({ visitType: 'customer' }, 2));
    expect(await h.db('notifications')).toHaveLength(1);
  });

  it('rejects invalid recipient addresses in rules', async () => {
    h = await setup();
    const admin = await agentFor(h, 'admin');
    const res = await admin.put('/api/admin/notification-rules/meeting').send({ enabled: true, notifyHost: true, notifyDepartment: false, extraRecipients: ['not-an-email'], notifyOnCheckout: false });
    expect(res.status).toBe(400);
  });

  it('a failing provider never blocks check-in; delivery is retried with backoff, then marked failed', async () => {
    let t = new Date('2026-10-27T06:00:00Z');
    const failing: EmailProvider = { name: 'graph', delivers: true, send: vi.fn(async () => { throw new Error('HTTP 503'); }) };
    h = await setup({ email: failing, now: () => t });
    const guard = await agentFor(h, 'guard');
    const res = await guard.post('/api/visits').send(checkInBody({ visitType: 'meeting', hostEmployeeId: h.empId, purpose: 'x' }));
    expect(res.status).toBe(201);
    for (let i = 0; i < 6; i++) {
      await processOutbox(h.ctx);
      t = new Date(t.getTime() + 2 * 3600_000);
    }
    const n = await h.db('notifications').first();
    expect(n.status).toBe('failed');
    expect(Number(n.attempts)).toBe(6);
    expect(n.last_error).toContain('503');
  });
});

describe('Microsoft Graph provider', () => {
  it('gets a client-credentials token, caches it, and calls sendMail for the configured sender', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      if (String(url).includes('/oauth2/v2.0/token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    const p = new GraphEmailProvider({ tenantId: 'tenant-placeholder', clientId: 'client-placeholder', clientSecret: 'secret-placeholder', sender: 'gatekeeper@example.com' }, fakeFetch);
    const msg: EmailMessage = { to: ['a@example.com', 'b@example.com'], subject: 'S', html: '<p>x</p>', text: 'x' };
    await p.send(msg);
    await p.send(msg);
    expect(calls.filter((c) => c.url.includes('token'))).toHaveLength(1);
    const send = calls.find((c) => c.url.includes('sendMail'))!;
    expect(send.url).toBe('https://graph.microsoft.com/v1.0/users/gatekeeper%40example.com/sendMail');
    expect((send.init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    const body = JSON.parse(String(send.init.body));
    expect(body.message.toRecipients).toEqual([{ emailAddress: { address: 'a@example.com' } }, { emailAddress: { address: 'b@example.com' } }]);
    expect(String(calls[0].init.body)).toContain('grant_type=client_credentials');
  });

  it('surfaces Graph errors so the outbox can retry', async () => {
    const fakeFetch = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('token') ? new Response(JSON.stringify({ access_token: 't', expires_in: 3600 })) : new Response('{}', { status: 403 }),
    ) as unknown as typeof fetch;
    const p = new GraphEmailProvider({ tenantId: 't', clientId: 'c', clientSecret: 's', sender: 'x@example.com' }, fakeFetch);
    await expect(p.send({ to: ['a@example.com'], subject: 's', html: 'h', text: 't' })).rejects.toThrow(/403/);
  });

  it('dev logger is clearly marked non-production and logs no body', async () => {
    const lines: string[] = [];
    const log = pino({ level: 'warn' }, { write: (s: string) => lines.push(s) });
    await new DevLogEmailProvider(log).send({ to: ['a@example.com'], subject: 'Hello', html: '<p>SECRET BODY</p>', text: 'SECRET BODY' });
    expect(lines.join('')).toContain('NON-PRODUCTION');
    expect(lines.join('')).not.toContain('SECRET BODY');
    expect(lines.join('')).not.toContain('a@example.com');
  });
});
