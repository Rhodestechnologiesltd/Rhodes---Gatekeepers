import { z } from 'zod';
import { DateTime } from 'luxon';
import type { Db } from '../db/knex.js';
import { nowIso, parseJson } from '../db/knex.js';

const tz = z.string().refine((v) => DateTime.local().setZone(v).isValid, 'Unknown IANA timezone');

/** Company-configurable settings, editable by administrators. */
export const settingsSchema = z.object({
  companyName: z.string().min(1).max(120),
  siteName: z.string().min(1).max(120),
  timezone: tz,
  requireIdDocument: z.boolean(),
  /** Admin approval to keep full ID numbers (encrypted). Has effect ONLY if ALLOW_FULL_ID_STORAGE=true in the environment. */
  storeFullIdNumber: z.boolean(),
  storeIdExpiryDate: z.boolean(),
  privacyNotice: z.object({
    enabled: z.boolean(),
    requireAcknowledgement: z.boolean(),
    text: z.string().max(4000),
  }),
  overdueAfterHours: z.number().int().min(1).max(72),
  capture: z.object({
    /** Keep photos of identity cards in the visit folder (encrypted, access-controlled, audited). */
    storeIdImages: z.boolean(),
    /** Require front + back photos of each visitor's ID before check-in can be completed. */
    requireIdImages: z.boolean(),
    requirePlatePhotoForDelivery: z.boolean(),
    requireDocumentForDelivery: z.boolean(),
    maxGroupSize: z.number().int().min(1).max(100),
  }),
  retention: z.object({
    enabled: z.boolean(),
    visitorDataDays: z.number().int().min(1).max(3650),
    mode: z.enum(['anonymize', 'delete']),
    auditLogDays: z.number().int().min(30).max(3650),
    notificationDays: z.number().int().min(1).max(3650),
    /** Identity-card images are deleted after this many days (may be shorter than visitor data). */
    idImageDays: z.number().int().min(1).max(3650),
  }),
  emailFooter: z.string().max(500),
});
export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  companyName: 'Company name (configure in Settings)',
  siteName: 'Main Gate',
  timezone: 'Asia/Dubai',
  requireIdDocument: true,
  storeFullIdNumber: false,
  storeIdExpiryDate: true,
  privacyNotice: {
    enabled: true,
    requireAcknowledgement: true,
    text:
      'PLACEHOLDER — replace with the company-approved privacy notice. ' +
      'We record your name, company, the purpose of your visit and your arrival and departure times for site ' +
      'security and safety. Identity card details are used to confirm who is on site. ' +
      'Contact the company for information on how your data is handled and how long it is kept.',
  },
  overdueAfterHours: 10,
  capture: { storeIdImages: true, requireIdImages: true, requirePlatePhotoForDelivery: true, requireDocumentForDelivery: true, maxGroupSize: 25 },
  retention: { enabled: false, visitorDataDays: 365, mode: 'anonymize', auditLogDays: 730, notificationDays: 90, idImageDays: 180 },
  emailFooter: 'This is an automated message from Rhodes Gatekeeper. Please do not reply.',
};

const KEY = 'app';

export class SettingsService {
  private cache: Settings | null = null;
  constructor(private readonly db: Db) {}

  async get(): Promise<Settings> {
    if (this.cache) return this.cache;
    const row = await this.db('settings').where({ key: KEY }).first();
    const stored = parseJson<Partial<Settings>>(row?.value, {});
    const merged = {
      ...DEFAULT_SETTINGS,
      ...stored,
      privacyNotice: { ...DEFAULT_SETTINGS.privacyNotice, ...(stored.privacyNotice ?? {}) },
      retention: { ...DEFAULT_SETTINGS.retention, ...(stored.retention ?? {}) },
      capture: { ...DEFAULT_SETTINGS.capture, ...(stored.capture ?? {}) },
    };
    const parsed = settingsSchema.safeParse(merged);
    this.cache = parsed.success ? parsed.data : DEFAULT_SETTINGS;
    return this.cache;
  }

  async update(patch: unknown, userId: string | null): Promise<{ settings: Settings; changedKeys: string[] }> {
    const current = await this.get();
    const p = (patch ?? {}) as Partial<Settings>;
    const next = settingsSchema.parse({
      ...current,
      ...p,
      privacyNotice: { ...current.privacyNotice, ...(p.privacyNotice ?? {}) },
      retention: { ...current.retention, ...(p.retention ?? {}) },
      capture: { ...current.capture, ...(p.capture ?? {}) },
    });
    const changedKeys = (Object.keys(next) as (keyof Settings)[]).filter(
      (k) => JSON.stringify(next[k]) !== JSON.stringify(current[k]),
    );
    const value = JSON.stringify(next);
    const exists = await this.db('settings').where({ key: KEY }).first();
    if (exists) await this.db('settings').where({ key: KEY }).update({ value, updated_at: nowIso(), updated_by: userId });
    else await this.db('settings').insert({ key: KEY, value, updated_at: nowIso(), updated_by: userId });
    this.cache = next;
    return { settings: next, changedKeys };
  }
}
