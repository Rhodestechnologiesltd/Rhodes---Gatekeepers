import fs from 'node:fs';
import path from 'node:path';
import express, { Router, type Request, type Response } from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { ROLE_PERMISSIONS } from '../domain/permissions.js';
import { VISIT_TYPES, VISIT_TYPE_LABELS } from '../domain/types.js';
import { changeOwnPassword, login, logout } from '../services/users.js';
import { SESSION_COOKIE, actorOf, bearerToken, errorHandler, loadUser, mobileCors, requireAuth, requireCsrfHeader } from './middleware.js';
import { enrollDevice, verifyDevice } from '../services/devices.js';
import { AppError } from '../errors.js';
import { gateRoutes } from './routes/gate.js';
import { staffRoutes } from './routes/staff.js';
import { adminRoutes } from './routes/admin.js';

export function createApp(ctx: AppContext, opts: { staticDir?: string } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', ctx.config.TRUST_PROXY === 'false' ? false : ctx.config.TRUST_PROXY);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'"],
          mediaSrc: ["'self'", 'blob:'],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
        },
      },
      // Camera access is needed on the check-in page for barcode scanning.
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use((_req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    next();
  });

  // Operational request log — method, route path and status only. No bodies, no query strings.
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      if (req.path === '/api/health' || !req.path.startsWith('/api')) return;
      ctx.log.info({ method: req.method, path: req.path.replace(/[0-9a-f-]{36}/gi, ':id'), status: res.statusCode, ms: Date.now() - start, user: req.user?.username }, 'request');
    });
    next();
  });

  const api = Router();
  api.use(mobileCors(ctx.config.MOBILE_DEV_ORIGINS.split(',').map((x) => x.trim())));
  // Photo uploads carry base64 images; every other endpoint keeps a small body limit.
  const bigJson = express.json({ limit: '18mb' });
  const smallJson = express.json({ limit: '100kb' });
  api.use((req, res, next) => (/^\/visit-groups\/[^/]+\/files$/.test(req.path) ? bigJson : smallJson)(req, res, next));
  api.use(cookieParser());
  api.use(requireCsrfHeader);
  api.use(loadUser(ctx));
  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  api.get('/health', async (_req, res) => {
    try {
      await ctx.db.raw('select 1');
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'db_unavailable' });
    }
  });

  // ---------------- auth
  const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: { code: 'RATE_LIMITED', message: 'Too many sign-in attempts. Please wait and try again.' } } });

  api.post('/auth/login', loginLimiter, async (req: Request, res: Response) => {
    const body = z.object({ username: z.string().max(80), password: z.string().max(200) }).parse(req.body);
    const { token, user } = await login(ctx, body.username, body.password, { ip: req.ip, userAgent: req.get('user-agent') });
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true, secure: ctx.config.cookieSecure, sameSite: 'strict', path: '/api',
      maxAge: ctx.config.SESSION_TTL_HOURS * 3600_000 * 30, // browser-side cap; the server enforces the real (sliding) expiry
    });
    res.json({ user, permissions: [...ROLE_PERMISSIONS[user.role]] });
  });

  /** Gate tablet sign-in: requires an enrolled device (X-Device-Id / X-Device-Secret). Returns a bearer token. */
  api.post('/auth/mobile/login', loginLimiter, async (req: Request, res: Response) => {
    const body = z.object({ username: z.string().max(80), password: z.string().max(200) }).parse(req.body);
    const device = await verifyDevice(ctx, req.get('x-device-id'), req.get('x-device-secret'));
    if (!device) throw new AppError(401, 'DEVICE_NOT_ENROLLED', 'This tablet is not enrolled or has been revoked. Ask an administrator for an enrolment code.');
    const { token, user } = await login(ctx, body.username, body.password, { ip: req.ip, userAgent: req.get('user-agent'), client: 'mobile', deviceId: device.id });
    res.json({ token, user, permissions: [...ROLE_PERMISSIONS[user.role]], device: { id: device.id, name: device.name } });
  });

  const enrollLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please wait and try again.' } } });
  api.post('/device/enroll', enrollLimiter, async (req, res) => {
    res.status(201).json(await enrollDevice(ctx, req.body, req.ip));
  });

  api.post('/auth/logout', async (req, res) => {
    await logout(ctx, bearerToken(req) ?? req.cookies?.[SESSION_COOKIE]);
    if (req.user) await ctx.audit.log(actorOf(req), 'auth.logout', { type: 'user', id: req.user.id });
    res.clearCookie(SESSION_COOKIE, { path: '/api' });
    res.json({ ok: true });
  });

  api.get('/auth/me', requireAuth, async (req, res) => {
    const s = await ctx.settings.get();
    const { client, deviceId, ...user } = req.user!;
    res.json({
      user,
      client,
      deviceId,
      permissions: [...ROLE_PERMISSIONS[req.user!.role]],
      app: {
        companyName: s.companyName,
        siteName: s.siteName,
        timezone: s.timezone,
        requireIdDocument: s.requireIdDocument,
        privacyNotice: s.privacyNotice,
        visitTypes: VISIT_TYPES.map((t) => ({ value: t, label: VISIT_TYPE_LABELS[t] })),
        emailMode: ctx.email.name,
        verificationEnabled: ctx.verifier.enabled,
        nonProduction: !ctx.config.isProduction,
        capture: s.capture,
        sharepointEnabled: ctx.sharepoint.enabled,
      },
    });
  });

  api.post('/auth/change-password', requireAuth, async (req, res) => {
    const b = z.object({ currentPassword: z.string().max(200), newPassword: z.string().max(200) }).parse(req.body);
    await changeOwnPassword(ctx, req.user!, b.currentPassword, b.newPassword);
    res.json({ ok: true });
  });

  api.use(gateRoutes(ctx));
  api.use(staffRoutes(ctx));
  api.use('/admin', adminRoutes(ctx));
  api.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } }));
  api.use(errorHandler(ctx));

  app.use('/api', api);

  // ---------------- web app (built React bundle)
  const staticDir = opts.staticDir;
  if (staticDir && fs.existsSync(path.join(staticDir, 'index.html'))) {
    app.use(express.static(staticDir, { index: false, maxAge: '1h', setHeaders: (res, p) => { if (p.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); } }));
    app.get('/{*splat}', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(staticDir, 'index.html'));
    });
  }
  return app;
}
