import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import type { AppContext } from '../context.js';
import type { AuthUser } from '../domain/types.js';
import { can, type Permission, type Role } from '../domain/permissions.js';
import { AppError, forbidden, unauthorized } from '../errors.js';
import { authenticate } from '../services/users.js';
import type { AuditActor } from '../services/audit.js';

export const SESSION_COOKIE = 'rg_session';
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'RhodesGatekeeper';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser & { client: 'web' | 'mobile'; deviceId: string | null };
    }
  }
}

export const actorOf = (req: Request): AuditActor & { role: Role; deviceId: string | null } => ({
  id: req.user?.id ?? null,
  username: req.user?.username ?? null,
  ip: req.ip ?? null,
  role: req.user?.role ?? 'guard',
  deviceId: req.user?.deviceId ?? null,
});

export function bearerToken(req: Request): string | undefined {
  const h = req.get('authorization');
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
}

/** Loads the signed-in user: web sessions from the cookie, tablet sessions from the bearer token. */
export const loadUser = (ctx: AppContext) => async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const bearer = bearerToken(req);
    const user = bearer ? await authenticate(ctx, bearer, 'mobile') : await authenticate(ctx, req.cookies?.[SESSION_COOKIE] as string | undefined, 'web');
    if (user) req.user = user;
    next();
  } catch (e) {
    next(e);
  }
};

/**
 * CORS for the gate tablet app only. Capacitor serves the app from capacitor://localhost (iOS) and
 * https://localhost (Android). Credentials (cookies) are never allowed cross-origin; the app uses a
 * bearer token bound to an enrolled device.
 */
export const mobileCors = (extraOrigins: string[]) => {
  const allowed = new Set(['capacitor://localhost', 'ionic://localhost', 'https://localhost', 'http://localhost', ...extraOrigins.filter(Boolean)]);
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.get('origin');
    if (origin && allowed.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Requested-With, X-Device-Id, X-Device-Secret');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    }
    if (req.method === 'OPTIONS') return res.status(origin && allowed.has(origin) ? 204 : 403).end();
    next();
  };
};

/**
 * CSRF defence for web sessions: the session cookie is SameSite=Strict (never sent on cross-site
 * requests) AND every state-changing call must carry a custom header, which a foreign page cannot add
 * without a CORS preflight. Preflights are answered only for the tablet app's local origins, never with
 * Allow-Credentials, and tablet sessions use a bearer token that browsers do not attach automatically.
 */
export const requireCsrfHeader = (req: Request, _res: Response, next: NextFunction) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get(CSRF_HEADER) !== CSRF_VALUE) return next(new AppError(403, 'CSRF', 'Missing request header'));
  next();
};

export const requireAuth = (req: Request, _res: Response, next: NextFunction) => {
  if (!req.user) return next(unauthorized());
  next();
};

/** Server-side authorisation. Every protected route declares the permission it needs. */
export const requirePermission = (...perms: Permission[]) => (req: Request, _res: Response, next: NextFunction) => {
  if (!req.user) return next(unauthorized());
  if (req.user.mustChangePassword) {
    return next(new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'Please change your password before continuing'));
  }
  if (!perms.every((p) => can(req.user!.role, p))) return next(forbidden());
  next();
};

/** Error handler: friendly messages to clients; logs without request bodies (which may hold personal data). */
export const errorHandler = (ctx: AppContext) => (err: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Please correct the highlighted fields',
        details: { fields: Object.fromEntries(err.issues.map((i) => [i.path.join('.'), i.message])) },
      },
    });
  }
  const e = err as { type?: string; status?: number };
  if (e?.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed request' } });
  if (e?.type === 'entity.too.large') return res.status(413).json({ error: { code: 'TOO_LARGE', message: 'Request too large' } });
  ctx.log.error({ err: { message: (err as Error)?.message, stack: (err as Error)?.stack }, path: req.path, method: req.method }, 'Unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' } });
};
