import './env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { loadConfig } from './config.js';
import { buildContext } from './context.js';
import { createDb, migrateLatest } from './db/knex.js';
import { createEmailProvider } from './email/providers.js';
import { createVerifier } from './scanning/verification.js';
import { createApp } from './http/app.js';
import { processOutbox } from './services/notifications.js';
import { runRetention } from './services/retention.js';
import { processSharePointSync } from './services/files.js';

async function main() {
  const config = loadConfig();
  const log = pino({ level: config.LOG_LEVEL, redact: ['req.headers.cookie', 'password', '*.password', 'idNumber', '*.idNumber'] });
  const db = createDb(config);
  const applied = await migrateLatest(db);
  if (applied.length) log.info({ applied }, 'Database migrations applied');

  const ctx = buildContext({ config, db, log, email: createEmailProvider(config, log), verifier: createVerifier(config.ID_VERIFICATION_PROVIDER) });

  if (ctx.email.name === 'devlog') log.warn('EMAIL_PROVIDER=devlog — emails are LOGGED, NOT SENT. Non-production only.');
  log.info({ storage: config.STORAGE_DIR, sharepoint: ctx.sharepoint.enabled }, 'File storage ready (encrypted at rest)');
  if (ctx.ids.usingDevKey) log.warn('DATA_ENCRYPTION_KEY not set — using a development key. Never run like this in production.');

  const here = path.dirname(fileURLToPath(import.meta.url));
  const staticDir = process.env.WEB_DIST_DIR ?? path.resolve(here, '../../web/dist');
  const app = createApp(ctx, { staticDir });
  const server = app.listen(config.PORT, () => log.info({ port: config.PORT }, 'Rhodes Gatekeeper listening'));

  const timers: NodeJS.Timeout[] = [];
  if (config.JOBS_ENABLED === 'true') {
    timers.push(setInterval(() => void processOutbox(ctx).catch((e) => log.error({ err: e?.message }, 'outbox error')), 15_000));
    if (ctx.sharepoint.enabled) {
      timers.push(setInterval(() => void processSharePointSync(ctx).catch((e) => log.error({ err: e?.message }, 'SharePoint sync error')), 30_000));
    }
    const retention = () => void runRetention(ctx, { id: null, username: 'system' }).catch((e) => log.error({ err: e?.message }, 'retention error'));
    timers.push(setInterval(retention, 6 * 3600_000));
    setTimeout(retention, 60_000);
  }
  // Deliver right after each check-in/out rather than waiting for the next poll.
  ctx.events.subscribe(() => setTimeout(() => void processOutbox(ctx).catch(() => undefined), 250));

  const shutdown = (sig: string) => {
    log.info({ sig }, 'Shutting down');
    timers.forEach(clearInterval);
    server.close(() => void db.destroy().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
