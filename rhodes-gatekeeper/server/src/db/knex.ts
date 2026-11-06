import fs from 'node:fs';
import path from 'node:path';
import knexFactory, { type Knex } from 'knex';
import type { AppConfig } from '../config.js';
import { migrations } from './migrations.js';

export type Db = Knex;

export function createDb(config: Pick<AppConfig, 'DB_CLIENT' | 'DATABASE_URL' | 'SQLITE_FILENAME' | 'DB_SSL'>): Db {
  if (config.DB_CLIENT === 'pg') {
    return knexFactory({
      client: 'pg',
      connection: {
        connectionString: config.DATABASE_URL,
        ssl: config.DB_SSL ? { rejectUnauthorized: true } : undefined,
      },
      pool: { min: 1, max: 10 },
    });
  }
  const filename = config.SQLITE_FILENAME;
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  return knexFactory({
    client: 'better-sqlite3',
    connection: { filename },
    useNullAsDefault: true,
    pool: {
      min: 1,
      max: 1,
      afterCreate: (conn: { pragma: (s: string) => void }, done: (err: Error | null, conn: unknown) => void) => {
        conn.pragma('foreign_keys = ON');
        if (filename !== ':memory:') conn.pragma('journal_mode = WAL');
        done(null, conn);
      },
    },
  });
}

/** Migrations are bundled in code so they run identically from tsx and compiled JS. */
export async function migrateLatest(db: Db): Promise<string[]> {
  const [, applied] = await db.migrate.latest({
    migrationSource: {
      getMigrations: async () => Object.keys(migrations).sort(),
      getMigrationName: (m: string) => m,
      getMigration: async (m: string) => migrations[m],
    },
  });
  return applied as string[];
}

// ---------- portable value helpers (SQLite returns 0/1 + strings, PG returns booleans + Date) ----------

export function toIso(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function toBool(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 't' || v === 'true';
}

export function parseJson<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined || v === '') return fallback;
  if (typeof v === 'object') return v as T;
  try {
    return JSON.parse(String(v)) as T;
  } catch {
    return fallback;
  }
}

export const nowIso = (): string => new Date().toISOString();
