import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

// ---------------- passwords (scrypt, no native dependency) ----------------
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
  });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

export const PASSWORD_MIN_LENGTH = 10;
export function passwordProblems(pw: string): string | null {
  if (pw.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  if (pw.length > 200) return 'Password is too long';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password must contain letters and numbers';
  return null;
}

// ---------------- session tokens ----------------
export function newSessionToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}
export function sha256Hex(v: string): string {
  return crypto.createHash('sha256').update(v).digest('hex');
}

// ---------------- identity-number protection ----------------
/**
 * Keyed hash so the same ID can be recognised on a repeat visit without storing the number.
 * Without DATA_ENCRYPTION_KEY (development only) a fixed dev key is used and a warning is logged at startup.
 */
const DEV_KEY = Buffer.alloc(32, 7);

export class IdProtector {
  private readonly key: Buffer;
  constructor(base64Key: string | undefined, readonly fullStorageAllowedByEnv: boolean) {
    this.key = base64Key ? Buffer.from(base64Key, 'base64') : DEV_KEY;
  }

  /** Root key material for deriving other keys (e.g. file encryption). Never log or return it. */
  get masterKey(): Buffer {
    return this.key;
  }

  get usingDevKey(): boolean {
    return this.key.equals(DEV_KEY);
  }

  hash(idNumber: string): string {
    return crypto.createHmac('sha256', this.key).update(normalizeIdNumber(idNumber)).digest('hex');
  }

  encrypt(plain: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encKey(), iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
  }

  decrypt(payload: string): string {
    const [v, iv, tag, data] = payload.split('.');
    if (v !== 'v1') throw new Error('Unsupported ciphertext version');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.encKey(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  }

  /** Derive a separate encryption key so HMAC and AES never share key material directly. */
  private encKey(): Buffer {
    return Buffer.from(crypto.hkdfSync('sha256', this.key, Buffer.alloc(0), 'rhodes-gatekeeper-id-enc', 32));
  }
}

export function normalizeIdNumber(v: string): string {
  return v.replace(/[\s-]/g, '').toUpperCase();
}

/** 784-1990-1234567-1 → 784-****-*****67-1 ; other documents → ******1234 */
export function maskIdNumber(v: string | null | undefined): string | null {
  if (!v) return null;
  const n = normalizeIdNumber(v);
  if (/^784\d{12}$/.test(n)) return `784-****-*****${n.slice(12, 14)}-${n.slice(14)}`;
  if (n.length <= 4) return '*'.repeat(n.length);
  return `${'*'.repeat(Math.min(n.length - 4, 8))}${n.slice(-4)}`;
}
