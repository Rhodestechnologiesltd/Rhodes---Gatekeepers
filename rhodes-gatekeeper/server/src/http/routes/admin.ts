import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { actorOf, requirePermission } from '../middleware.js';
import { VISIT_TYPES } from '../../domain/types.js';
import { createUser, listUsers, updateUser } from '../../services/users.js';
import { listDepartments, listEmployees, saveDepartment, saveEmployee } from '../../services/directory.js';
import { getRules, listNotifications, processOutbox, retryNotification, saveRule } from '../../services/notifications.js';
import { runRetention } from '../../services/retention.js';
import { notFound } from '../../errors.js';
import { createDevice, listDevices, regenerateCode, revokeDevice } from '../../services/devices.js';
import { processSharePointSync, retrySharePoint, syncStatus } from '../../services/files.js';

/** Administrator endpoints. */
export function adminRoutes(ctx: AppContext): Router {
  const r = Router();

  // ---- users
  r.get('/users', requirePermission('user.manage'), async (_req, res) => res.json(await listUsers(ctx)));
  r.post('/users', requirePermission('user.manage'), async (req, res) => res.status(201).json(await createUser(ctx, actorOf(req), req.body)));
  r.patch('/users/:id', requirePermission('user.manage'), async (req, res) => res.json(await updateUser(ctx, actorOf(req), String(req.params.id), req.body)));

  // ---- directory
  r.get('/departments', requirePermission('directory.manage'), async (_req, res) => res.json(await listDepartments(ctx, { includeInactive: true })));
  r.post('/departments', requirePermission('directory.manage'), async (req, res) => res.status(201).json(await saveDepartment(ctx, actorOf(req), null, req.body)));
  r.patch('/departments/:id', requirePermission('directory.manage'), async (req, res) => res.json(await saveDepartment(ctx, actorOf(req), String(req.params.id), req.body)));
  r.get('/employees', requirePermission('directory.manage'), async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 80) : undefined;
    res.json(await listEmployees(ctx, { q, includeInactive: true, includeContact: true }));
  });
  r.post('/employees', requirePermission('directory.manage'), async (req, res) => res.status(201).json(await saveEmployee(ctx, actorOf(req), null, req.body)));
  r.patch('/employees/:id', requirePermission('directory.manage'), async (req, res) => res.json(await saveEmployee(ctx, actorOf(req), String(req.params.id), req.body)));

  // ---- settings
  r.get('/settings', requirePermission('settings.manage'), async (_req, res) => {
    res.json({ settings: await ctx.settings.get(), environment: environmentInfo(ctx) });
  });
  r.put('/settings', requirePermission('settings.manage'), async (req, res) => {
    const { settings, changedKeys } = await ctx.settings.update(req.body, req.user!.id);
    await ctx.audit.log(actorOf(req), 'settings.update', { type: 'settings' }, { changedKeys });
    res.json({ settings, environment: environmentInfo(ctx) });
  });

  // ---- notification rules + outbox
  r.get('/notification-rules', requirePermission('settings.manage'), async (_req, res) => res.json(await getRules(ctx.db)));
  r.put('/notification-rules/:visitType', requirePermission('settings.manage'), async (req, res) => {
    const visitType = z.enum(VISIT_TYPES).parse(req.params.visitType);
    const rule = await saveRule(ctx.db, visitType, req.body);
    await ctx.audit.log(actorOf(req), 'notification_rule.update', { type: 'notification_rule' }, { visitType });
    res.json(rule);
  });
  r.get('/notifications', requirePermission('settings.manage'), async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    res.json(await listNotifications(ctx, { status }));
  });
  r.post('/notifications/:id/retry', requirePermission('settings.manage'), async (req, res) => {
    if (!(await retryNotification(ctx, String(req.params.id)))) throw notFound('Notification');
    await ctx.audit.log(actorOf(req), 'notification.retry', { type: 'notification', id: String(req.params.id) });
    void processOutbox(ctx);
    res.json({ ok: true });
  });

  // ---- gate tablets
  r.get('/devices', requirePermission('device.manage'), async (_req, res) => res.json(await listDevices(ctx)));
  r.post('/devices', requirePermission('device.manage'), async (req, res) => res.status(201).json(await createDevice(ctx, actorOf(req), req.body)));
  r.post('/devices/:id/new-code', requirePermission('device.manage'), async (req, res) => res.json(await regenerateCode(ctx, actorOf(req), String(req.params.id))));
  r.post('/devices/:id/revoke', requirePermission('device.manage'), async (req, res) => res.json(await revokeDevice(ctx, actorOf(req), String(req.params.id))));

  // ---- SharePoint copy
  r.get('/sharepoint', requirePermission('files.manage_sync'), async (_req, res) => res.json(await syncStatus(ctx)));
  r.post('/sharepoint/retry', requirePermission('files.manage_sync'), async (req, res) => {
    const n = await retrySharePoint(ctx);
    await ctx.audit.log(actorOf(req), 'sharepoint.retry', { type: 'system' }, { files: n });
    void processSharePointSync(ctx);
    res.json({ requeued: n });
  });

  // ---- audit + retention
  r.get('/audit', requirePermission('audit.view'), async (req, res) => {
    const q = z
      .object({ action: z.string().max(60).optional(), entityId: z.string().max(36).optional(), limit: z.coerce.number().int().max(500).optional(), offset: z.coerce.number().int().min(0).optional() })
      .parse(req.query);
    res.json(await ctx.audit.list(q));
  });
  r.post('/retention/run', requirePermission('retention.run'), async (req, res) => {
    res.json(await runRetention(ctx, actorOf(req), { force: true }));
  });

  return r;
}

export function environmentInfo(ctx: AppContext) {
  return {
    emailProvider: ctx.email.name,
    emailDelivers: ctx.email.delivers,
    verificationProvider: ctx.verifier.name,
    verificationEnabled: ctx.verifier.enabled,
    sharepointEnabled: ctx.sharepoint.enabled,
    sharepointBasePath: ctx.sharepoint.enabled ? ctx.config.SHAREPOINT_BASE_PATH : null,
    fullIdStorageAllowedByEnvironment: ctx.ids.fullStorageAllowedByEnv,
    usingDevelopmentEncryptionKey: ctx.ids.usingDevKey,
    database: ctx.config.DB_CLIENT,
    nodeEnv: ctx.config.NODE_ENV,
  };
}
