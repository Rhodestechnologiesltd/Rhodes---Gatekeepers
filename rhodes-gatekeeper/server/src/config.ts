import { z } from 'zod';

/**
 * Environment configuration. Secrets come ONLY from environment variables
 * (or a secrets manager that injects them as env vars). Nothing is hard-coded.
 */
const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  APP_BASE_URL: z.string().url().default('http://localhost:5173'),

  DB_CLIENT: z.enum(['pg', 'sqlite']).default('sqlite'),
  DATABASE_URL: z.string().optional(),
  SQLITE_FILENAME: z.string().default('./data/gatekeeper.sqlite'),
  DB_SSL: bool,

  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  COOKIE_SECURE: z.enum(['true', 'false', 'auto']).default('auto'),
  TRUST_PROXY: z.string().default('loopback'),

  /** 32-byte key, base64. Used to HMAC ID numbers (repeat-visitor matching) and to encrypt full IDs if enabled. */
  DATA_ENCRYPTION_KEY: z.string().optional(),
  /** Second, independent gate for storing full ID numbers. Must be true AND the admin setting enabled. */
  ALLOW_FULL_ID_STORAGE: bool,

  EMAIL_PROVIDER: z.enum(['graph', 'devlog', 'disabled']).default('devlog'),
  ALLOW_DEV_EMAIL_IN_PRODUCTION: bool,
  M365_TENANT_ID: z.string().optional(),
  M365_CLIENT_ID: z.string().optional(),
  M365_CLIENT_SECRET: z.string().optional(),
  M365_SENDER_ADDRESS: z.string().email().optional(),

  ID_VERIFICATION_PROVIDER: z.enum(['none']).default('none'),

  /** Encrypted file storage (ID images, plate photos, PO/invoice). */
  STORAGE_DIR: z.string().default('./data/files'),

  /** Copy each visit folder to a SharePoint / OneDrive document library via Microsoft Graph. */
  SHAREPOINT_ENABLED: bool,
  SHAREPOINT_DRIVE_ID: z.string().optional(),
  SHAREPOINT_BASE_PATH: z.string().default('Rhodes Gatekeeper'),

  /** Extra origins allowed to call the API from the mobile app during development (comma-separated). */
  MOBILE_DEV_ORIGINS: z.string().default(''),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  JOBS_ENABLED: z.enum(['true', 'false']).default('true'),
});

export type AppConfig = z.infer<typeof schema> & { isProduction: boolean; cookieSecure: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const c = parsed.data;
  const isProduction = c.NODE_ENV === 'production';
  const errors: string[] = [];

  if (c.DB_CLIENT === 'pg' && !c.DATABASE_URL) errors.push('DATABASE_URL is required when DB_CLIENT=pg');
  if (isProduction && c.DB_CLIENT !== 'pg') errors.push('Production requires DB_CLIENT=pg (PostgreSQL)');

  if (c.DATA_ENCRYPTION_KEY) {
    const len = Buffer.from(c.DATA_ENCRYPTION_KEY, 'base64').length;
    if (len !== 32) errors.push('DATA_ENCRYPTION_KEY must be 32 bytes encoded as base64');
  } else if (isProduction) {
    errors.push('DATA_ENCRYPTION_KEY is required in production');
  }
  if (c.ALLOW_FULL_ID_STORAGE && !c.DATA_ENCRYPTION_KEY) {
    errors.push('ALLOW_FULL_ID_STORAGE requires DATA_ENCRYPTION_KEY');
  }

  if (c.EMAIL_PROVIDER === 'graph') {
    for (const k of ['M365_TENANT_ID', 'M365_CLIENT_ID', 'M365_CLIENT_SECRET', 'M365_SENDER_ADDRESS'] as const) {
      if (!c[k]) errors.push(`${k} is required when EMAIL_PROVIDER=graph`);
    }
  }
  if (c.SHAREPOINT_ENABLED) {
    for (const k of ['M365_TENANT_ID', 'M365_CLIENT_ID', 'M365_CLIENT_SECRET', 'SHAREPOINT_DRIVE_ID'] as const) {
      if (!c[k]) errors.push(`${k} is required when SHAREPOINT_ENABLED=true`);
    }
  }
  if (isProduction && c.EMAIL_PROVIDER === 'devlog' && !c.ALLOW_DEV_EMAIL_IN_PRODUCTION) {
    errors.push(
      'EMAIL_PROVIDER=devlog is a NON-PRODUCTION logger. Use graph or disabled in production ' +
        '(or set ALLOW_DEV_EMAIL_IN_PRODUCTION=true for a supervised pilot).',
    );
  }
  if (errors.length) throw new Error(`Invalid configuration:\n - ${errors.join('\n - ')}`);

  const cookieSecure = c.COOKIE_SECURE === 'auto' ? isProduction : c.COOKIE_SECURE === 'true';
  return { ...c, isProduction, cookieSecure };
}
