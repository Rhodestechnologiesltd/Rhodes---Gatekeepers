import { Router, type Request } from 'express';
import { z } from 'zod';
import { DateTime } from 'luxon';
import type { AppContext } from '../../context.js';
import { actorOf, requirePermission } from '../middleware.js';
import { can } from '../../domain/permissions.js';
import { VISIT_TYPES } from '../../domain/types.js';
import { getVisit, listAllVisitsInRange, listVisits, manualCheckout, revealIdNumber, updateVisit, type VisitFilters } from '../../services/visits.js';
import { buildSummary, dashboard, localRange, monthRange, visitsToCsv } from '../../services/reports.js';
import { listNotifications } from '../../services/notifications.js';
import { getFileForUser, getFolder, listFolders, streamFolderZip } from '../../services/files.js';
import { search } from '../../services/search.js';
import { checkOutGroup } from '../../services/groups.js';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const filterQuery = z.object({
  from: dateStr.optional(),
  to: dateStr.optional(),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  status: z.enum(['on_site', 'checked_out']).optional(),
  visitType: z.enum(VISIT_TYPES).optional(),
  employeeId: z.string().max(36).optional(),
  departmentId: z.string().max(36).optional(),
  q: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/** Turn query-string filters (local dates in the company timezone) into service filters (UTC). */
async function toFilters(ctx: AppContext, req: Request): Promise<VisitFilters & { fromDate?: string; toDate?: string }> {
  const q = filterQuery.parse(req.query);
  const { timezone } = await ctx.settings.get();
  let range: { from?: string; to?: string; fromDate?: string; toDate?: string } = {};
  if (q.month) range = monthRange(q.month, timezone);
  else if (q.from || q.to) range = { ...localRange(q.from ?? q.to!, q.to ?? q.from!, timezone), fromDate: q.from ?? q.to, toDate: q.to ?? q.from };
  return {
    ...range,
    status: q.status, visitType: q.visitType, hostEmployeeId: q.employeeId, departmentId: q.departmentId,
    q: q.q?.trim() || undefined, limit: q.limit, offset: q.offset,
  };
}

/** Reception / authorised staff endpoints. */
export function staffRoutes(ctx: AppContext): Router {
  const r = Router();

  r.get('/visits', requirePermission('visit.view_all'), async (req, res) => {
    res.json(await listVisits(ctx, await toFilters(ctx, req)));
  });
  r.get('/visits/:id', requirePermission('visit.view_all'), async (req, res) => {
    res.json(await getVisit(ctx, String(req.params.id)));
  });
  r.patch('/visits/:id', requirePermission('visit.edit'), async (req, res) => {
    res.json(await updateVisit(ctx, actorOf(req), String(req.params.id), req.body));
  });
  r.post('/visits/:id/manual-check-out', requirePermission('visit.manual_checkout'), async (req, res) => {
    res.json(await manualCheckout(ctx, actorOf(req), String(req.params.id), req.body));
  });
  r.post('/visits/:id/reveal-id', requirePermission('visitor.view_sensitive'), async (req, res) => {
    const { reason } = z.object({ reason: z.string().max(200) }).parse(req.body ?? {});
    res.set('Cache-Control', 'no-store');
    res.json(await revealIdNumber(ctx, actorOf(req), String(req.params.id), reason));
  });
  r.get('/visits/:id/notifications', requirePermission('visit.view_all'), async (req, res) => {
    res.json(await listNotifications(ctx, { visitId: String(req.params.id) }));
  });

  // ---------------- search & folders
  r.get('/search', requirePermission('search.use'), async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    res.json(await search(ctx, actorOf(req), q));
  });

  r.get('/folders', requirePermission('files.view'), async (req, res) => {
    const q = z.object({
      from: dateStr.optional(), to: dateStr.optional(), q: z.string().max(80).optional(),
      type: z.enum(['visitors', 'vehicles']).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(), offset: z.coerce.number().int().min(0).optional(),
    }).parse(req.query);
    const { timezone } = await ctx.settings.get();
    const range = q.from || q.to ? localRange(q.from ?? q.to!, q.to ?? q.from!, timezone) : {};
    res.json(await listFolders(ctx, { ...range, q: q.q?.trim() || undefined, type: q.type, limit: q.limit, offset: q.offset }));
  });

  r.get('/folders/:id', requirePermission('files.view'), async (req, res) => {
    const id = String(req.params.id);
    const folder = await getFolder(ctx, id);
    const visits = (await listAllVisitsInRange(ctx, { groupId: id })).sort((a, b) => (a.group?.position ?? 0) - (b.group?.position ?? 0));
    res.json({ ...folder, visits, canViewIdImages: can(req.user!.role, 'files.view_id'), canDownload: can(req.user!.role, 'files.download') });
  });

  r.get('/folders/:id/download.zip', requirePermission('files.download'), async (req, res) => {
    await streamFolderZip(ctx, actorOf(req), String(req.params.id), res);
  });

  r.post('/visit-groups/:id/manual-check-out-all', requirePermission('visit.manual_checkout'), async (req, res) => {
    const { note } = z.object({ note: z.string().max(500).optional() }).parse(req.body ?? {});
    res.json(await checkOutGroup(ctx, actorOf(req), String(req.params.id), note));
  });

  /** File content. Identity-card images need files.view_id and every view is audited. */
  r.get('/files/:id/content', requirePermission('files.view'), async (req, res) => {
    const download = req.query.download === '1';
    const { data, file } = await getFileForUser(ctx, actorOf(req), String(req.params.id), download ? 'download' : 'view');
    res.set({
      'Content-Type': file.mime,
      'Content-Length': String(data.length),
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${file.fileName}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    });
    res.end(data);
  });

  r.get('/dashboard', requirePermission('report.view'), async (req, res) => {
    const q = z.object({ from: dateStr.optional(), to: dateStr.optional() }).parse(req.query);
    res.json(await dashboard(ctx, { fromDate: q.from, toDate: q.to ?? q.from }));
  });

  r.get('/reports/summary', requirePermission('report.view'), async (req, res) => {
    const f = await toFilters(ctx, req);
    if (!f.from) {
      const { timezone } = await ctx.settings.get();
      Object.assign(f, monthRange(DateTime.fromJSDate(ctx.now(), { zone: timezone }).toFormat('yyyy-MM'), timezone));
    }
    const { visits, ...summary } = await buildSummary(ctx, f);
    res.json({ range: { fromDate: f.fromDate, toDate: f.toDate }, ...summary, visitCount: visits.length });
  });

  r.get('/reports/export.csv', requirePermission('report.export'), async (req, res) => {
    const f = await toFilters(ctx, req);
    const { timezone } = await ctx.settings.get();
    if (!f.from) Object.assign(f, monthRange(DateTime.fromJSDate(ctx.now(), { zone: timezone }).toFormat('yyyy-MM'), timezone));
    const visits = await listAllVisitsInRange(ctx, { ...f, limit: undefined, offset: undefined });
    await ctx.audit.log(actorOf(req), 'report.export', { type: 'report' }, {
      fromDate: f.fromDate, toDate: f.toDate, visitType: f.visitType, employeeId: f.hostEmployeeId, departmentId: f.departmentId, rows: visits.length,
    });
    const name = `rhodes-gatekeeper-visits_${f.fromDate}_to_${f.toDate}.csv`;
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
    res.send(visitsToCsv(visits, timezone));
  });

  return r;
}
