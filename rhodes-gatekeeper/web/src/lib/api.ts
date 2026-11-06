/** Thin fetch wrapper. Session is an httpOnly cookie; every call carries the CSRF header the API requires. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: { fields?: Record<string, string>; [k: string]: unknown };
  constructor(status: number, code: string, message: string, details?: { fields?: Record<string, string>; [k: string]: unknown }) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
  get fields(): Record<string, string> {
    return this.details?.fields ?? {};
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

/**
 * Web app: same origin, session cookie.
 * Tablet app: absolute server URL + bearer token (set after sign-in), never cookies.
 */
const conn: { baseUrl: string; token: string | null } = { baseUrl: '', token: null };
export function configureApi(c: { baseUrl?: string; token?: string | null }) {
  if (c.baseUrl !== undefined) conn.baseUrl = c.baseUrl.replace(/\/+$/, '');
  if (c.token !== undefined) conn.token = c.token;
}
export const apiBase = () => conn.baseUrl;

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; signal?: AbortSignal; headers?: Record<string, string> } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${conn.baseUrl}/api${path}`, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers: {
        'X-Requested-With': 'RhodesGatekeeper',
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(conn.token ? { Authorization: `Bearer ${conn.token}` } : {}),
        ...(opts.headers ?? {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: conn.baseUrl ? 'omit' : 'same-origin',
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check the network connection and try again.');
  }
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/') && !path.startsWith('/device/')) onUnauthorized?.();
    const err = data?.error ?? {};
    throw new ApiError(res.status, err.code ?? 'ERROR', err.message ?? `Request failed (${res.status})`, err.details);
  }
  return data as T;
}

/** UUID v4 that also works on plain-HTTP LAN origins (where crypto.randomUUID is unavailable). */
export function uuid(): string {
  if (typeof crypto.randomUUID === 'function' && window.isSecureContext) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function qs(params: Record<string, string | number | undefined | null | false>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '' && v !== false) u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}
