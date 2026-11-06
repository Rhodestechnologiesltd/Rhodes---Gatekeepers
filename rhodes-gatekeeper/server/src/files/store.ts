import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Encrypted file store on the server's disk. Every file is AES-256-GCM encrypted with a key derived
 * (HKDF) from DATA_ENCRYPTION_KEY, so a copy of the storage folder alone reveals nothing.
 *
 * Layout mirrors the folders users see:  <STORAGE_DIR>/Visitors/2026/11/<folder>/<file>.enc
 */
export interface FileStore {
  put(relPath: string, data: Buffer): Promise<void>;
  get(relPath: string): Promise<Buffer>;
  remove(relPath: string): Promise<void>;
  removeDir(relDir: string): Promise<void>;
}

const MAGIC = Buffer.from('RGF1');

export class EncryptedDiskStore implements FileStore {
  private readonly root: string;
  private readonly key: Buffer;

  constructor(rootDir: string, masterKey: Buffer) {
    this.root = path.resolve(rootDir);
    this.key = Buffer.from(crypto.hkdfSync('sha256', masterKey, Buffer.alloc(0), 'rhodes-gatekeeper-files', 32));
  }

  /** Resolve inside the root only — refuses any path that would escape it. */
  private abs(relPath: string): string {
    const p = path.resolve(this.root, relPath);
    if (p !== this.root && !p.startsWith(this.root + path.sep)) throw new Error('Invalid storage path');
    return p;
  }

  async put(relPath: string, data: Buffer): Promise<void> {
    const target = this.abs(relPath) + '.enc';
    await fs.mkdir(path.dirname(target), { recursive: true });
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([c.update(data), c.final()]);
    const tmp = `${target}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, Buffer.concat([MAGIC, iv, c.getAuthTag(), enc]), { mode: 0o600 });
    await fs.rename(tmp, target);
  }

  async get(relPath: string): Promise<Buffer> {
    const raw = await fs.readFile(this.abs(relPath) + '.enc');
    if (!raw.subarray(0, 4).equals(MAGIC)) throw new Error('Unrecognised file format');
    const iv = raw.subarray(4, 16);
    const tag = raw.subarray(16, 32);
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(raw.subarray(32)), d.final()]);
  }

  async remove(relPath: string): Promise<void> {
    await fs.rm(this.abs(relPath) + '.enc', { force: true });
  }

  async removeDir(relDir: string): Promise<void> {
    const p = this.abs(relDir);
    if (p === this.root) throw new Error('Refusing to remove storage root');
    await fs.rm(p, { recursive: true, force: true });
  }
}

/** Detect the real type from the first bytes; never trust the client's declared type. */
export function sniffMime(buf: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf' | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

export const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
