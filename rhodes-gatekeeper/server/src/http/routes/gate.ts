import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { actorOf, requirePermission } from '../middleware.js';
import { parseIdScan } from '../../scanning/parse.js';
import { parseDocumentText, parseIdOcr, parsePlateText } from '../../scanning/ocr.js';
import { checkOut, listAllVisitsInRange, lookupByIdNumber } from '../../services/visits.js';
import { checkInGroup, checkInSingle, checkOutGroup } from '../../services/groups.js';
import { getFolder, uploadFile } from '../../services/files.js';
import { listDepartments, listEmployees } from '../../services/directory.js';
import { forbidden } from '../../errors.js';

/** Gate endpoints, used by the security guard's tablet app. */
export function gateRoutes(ctx: AppContext): Router {
  const r = Router();

  // ---------------- scanning (raw data / OCR text is parsed, never stored or logged)
  r.post('/scan/parse', requirePermission('scan.parse'), async (req, res) => {
    const { raw } = z.object({ raw: z.string().min(1).max(2000) }).parse(req.body);
    const parsed = parseIdScan(raw);
    const lookup = parsed.idNumber ? await lookupByIdNumber(ctx, parsed.idNumber) : null;
    res.json({ parsed, lookup, verificationAvailable: ctx.verifier.enabled });
  });

  /** OCR text of the ID card photos (front and/or back), recognised on the tablet. */
  r.post('/scan/parse-ocr', requirePermission('scan.parse'), async (req, res) => {
    const b = z.object({ front: z.string().max(8000).optional(), back: z.string().max(8000).optional() }).parse(req.body);
    const parsed = parseIdOcr(b.front, b.back);
    const lookup = parsed.idNumber ? await lookupByIdNumber(ctx, parsed.idNumber) : null;
    res.json({ parsed, lookup, verificationAvailable: ctx.verifier.enabled });
  });

  r.post('/scan/parse-plate', requirePermission('scan.parse'), (req, res) => {
    const { text } = z.object({ text: z.string().max(4000) }).parse(req.body);
    res.json({ suggestions: parsePlateText(text) });
  });

  r.post('/scan/parse-document', requirePermission('scan.parse'), (req, res) => {
    const { text } = z.object({ text: z.string().max(20000) }).parse(req.body);
    res.json(parseDocumentText(text));
  });

  r.post('/scan/lookup', requirePermission('scan.parse'), async (req, res) => {
    const { idNumber } = z.object({ idNumber: z.string().trim().min(5).max(40) }).parse(req.body);
    res.json(await lookupByIdNumber(ctx, idNumber));
  });

  r.get('/directory/employees', requirePermission('directory.read'), async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 80) : undefined;
    res.json(await listEmployees(ctx, { q }));
  });
  r.get('/directory/departments', requirePermission('directory.read'), async (_req, res) => {
    res.json((await listDepartments(ctx)).map(({ id, name }) => ({ id, name })));
  });

  // ---------------- check-in
  /** Group check-in: one or more visitors (or a driver + helpers) arriving together. */
  r.post('/visit-groups', requirePermission('visit.create'), async (req, res) => {
    const result = await checkInGroup(ctx, actorOf(req), req.body);
    res.status(result.replayed ? 200 : 201).json(result);
  });

  /** Single-visitor check-in (kept for integrations; the tablet app uses /visit-groups). */
  r.post('/visits', requirePermission('visit.create'), async (req, res) => {
    const result = await checkInSingle(ctx, actorOf(req), req.body);
    res.status(result.replayed ? 200 : 201).json(result);
  });

  /** The tablet can read back a group it checked in recently (to resume uploads) — names only, no file contents. */
  r.get('/visit-groups/:id', requirePermission('files.upload'), async (req, res) => {
    const { group, files } = await getFolder(ctx, String(req.params.id));
    if (Date.now() - Date.parse(group.checkedInAt) > 24 * 3600_000) throw forbidden();
    res.json({ group, files: files.map((f) => ({ id: f.id, kind: f.kind, visitId: f.visitId, fileName: f.fileName })) });
  });

  /** Upload one captured photo / document into the group's folder. Body: JSON with base64 data. */
  r.post('/visit-groups/:id/files', requirePermission('files.upload'), async (req, res) => {
    const out = await uploadFile(ctx, actorOf(req), String(req.params.id), req.body);
    res.status(out.replayed ? 200 : 201).json(out.file);
  });

  // ---------------- on site / check-out
  r.get('/visits/on-site', requirePermission('visit.view_onsite'), async (_req, res) => {
    const visits = await listAllVisitsInRange(ctx, { status: 'on_site' });
    res.json(
      visits.map((v) => ({
        id: v.id, referenceNo: v.referenceNo, visitType: v.visitType, visitorName: v.visitor.fullName,
        company: v.visitor.company, idNumberMasked: v.visitor.idNumberMasked, hostName: v.host?.name ?? null,
        department: v.department?.name ?? null, deliveryCompany: v.deliveryCompany, badgeNumber: v.badgeNumber,
        vehiclePlate: v.vehiclePlate, checkedInAt: v.checkedInAt,
        groupId: v.group?.id ?? null, groupNo: v.group?.groupNo ?? null, groupRole: v.group?.role ?? null, groupPosition: v.group?.position ?? null,
      })),
    );
  });

  r.post('/visits/:id/check-out', requirePermission('visit.checkout'), async (req, res) => {
    const { note } = z.object({ note: z.string().max(500).optional() }).parse(req.body ?? {});
    res.json(await checkOut(ctx, actorOf(req), String(req.params.id), note));
  });

  r.post('/visit-groups/:id/check-out', requirePermission('visit.checkout'), async (req, res) => {
    const { note } = z.object({ note: z.string().max(500).optional() }).parse(req.body ?? {});
    res.json(await checkOutGroup(ctx, actorOf(req), String(req.params.id), note));
  });

  /** Live updates for the web dashboard (Server-Sent Events). Payloads contain IDs only. */
  r.get('/events', requirePermission('visit.view_onsite'), (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 5000\n\n');
    const unsub = ctx.events.subscribe((e) => res.write(`event: visit\ndata: ${JSON.stringify(e)}\n\n`));
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      unsub();
    });
  });

  return r;
}
