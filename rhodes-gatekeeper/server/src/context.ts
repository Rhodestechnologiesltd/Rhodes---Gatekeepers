import type { Logger } from 'pino';
import type { AppConfig } from './config.js';
import type { Db } from './db/knex.js';
import type { EmailProvider } from './email/providers.js';
import type { IdentityVerifier } from './scanning/verification.js';
import { IdProtector } from './security/crypto.js';
import { AuditService } from './services/audit.js';
import { EventBus } from './services/events.js';
import { SettingsService } from './services/settings.js';
import { EncryptedDiskStore, type FileStore } from './files/store.js';
import { DisabledSharePoint, GraphSharePoint, type SharePointTarget } from './files/sharepoint.js';

/** Dependencies shared by services and routes. Constructed once in index.ts (or per test). */
export interface AppContext {
  config: AppConfig;
  db: Db;
  log: Logger;
  ids: IdProtector;
  email: EmailProvider;
  verifier: IdentityVerifier;
  settings: SettingsService;
  audit: AuditService;
  events: EventBus;
  files: FileStore;
  sharepoint: SharePointTarget;
  now: () => Date;
}

export function buildContext(parts: {
  config: AppConfig;
  db: Db;
  log: Logger;
  email: EmailProvider;
  verifier: IdentityVerifier;
  sharepoint?: SharePointTarget;
  files?: FileStore;
  now?: () => Date;
}): AppContext {
  const ids = new IdProtector(parts.config.DATA_ENCRYPTION_KEY, parts.config.ALLOW_FULL_ID_STORAGE);
  const c = parts.config;
  return {
    ...parts,
    ids,
    files: parts.files ?? new EncryptedDiskStore(c.STORAGE_DIR, ids.masterKey),
    sharepoint:
      parts.sharepoint ??
      (c.SHAREPOINT_ENABLED
        ? new GraphSharePoint({ tenantId: c.M365_TENANT_ID!, clientId: c.M365_CLIENT_ID!, clientSecret: c.M365_CLIENT_SECRET!, driveId: c.SHAREPOINT_DRIVE_ID!, basePath: c.SHAREPOINT_BASE_PATH })
        : new DisabledSharePoint()),
    settings: new SettingsService(parts.db),
    audit: new AuditService(parts.db),
    events: new EventBus(),
    now: parts.now ?? (() => new Date()),
  };
}
