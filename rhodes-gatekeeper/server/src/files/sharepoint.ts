/**
 * SharePoint / OneDrive copy of visit folders via Microsoft Graph (application permissions).
 *
 * Required: an Entra ID app registration (can be the same one used for email) with the application
 * permission **Sites.Selected**, plus a write grant on the one target site (see README). The target is a
 * document library identified by its drive ID (SHAREPOINT_DRIVE_ID).
 *
 * Files are uploaded decrypted (SharePoint encrypts at rest and applies its own access control); restrict
 * the library to the people allowed to see visitor identity documents.
 */
export interface SharePointTarget {
  readonly enabled: boolean;
  upload(path: string, data: Buffer, mime: string): Promise<{ itemId: string; parentId: string | null }>;
  deleteItem(itemId: string): Promise<void>;
}

export class DisabledSharePoint implements SharePointTarget {
  readonly enabled = false;
  async upload(): Promise<never> {
    throw new Error('SharePoint is not enabled');
  }
  async deleteItem(): Promise<void> {}
}

const SIMPLE_LIMIT = 4 * 1024 * 1024;
const CHUNK = 320 * 1024 * 10; // 3.125 MiB, a multiple of 320 KiB as Graph requires

export class GraphSharePoint implements SharePointTarget {
  readonly enabled = true;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly cfg: { tenantId: string; clientId: string; clientSecret: string; driveId: string; basePath: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value;
    const res = await this.fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(this.cfg.tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      }),
    });
    if (!res.ok) throw new Error(`Microsoft identity token request failed (HTTP ${res.status})`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  /** "Vehicles/2026/11/X/file.jpg" → URL-encoded per segment under the configured base folder. */
  private itemPath(rel: string): string {
    const segs = [...this.cfg.basePath.split('/'), ...rel.split('/')].filter(Boolean);
    return segs.map(encodeURIComponent).join('/');
  }

  private base(): string {
    return `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(this.cfg.driveId)}`;
  }

  async upload(rel: string, data: Buffer, mime: string) {
    const token = await this.accessToken();
    const auth = { Authorization: `Bearer ${token}` };
    let item: { id: string; parentReference?: { id?: string } };
    if (data.length <= SIMPLE_LIMIT) {
      const res = await this.fetchImpl(`${this.base()}/root:/${this.itemPath(rel)}:/content?@microsoft.graph.conflictBehavior=replace`, {
        method: 'PUT',
        headers: { ...auth, 'Content-Type': mime },
        body: new Uint8Array(data),
      });
      if (!res.ok) {
        if (res.status === 401) this.token = null;
        throw new Error(`SharePoint upload failed (HTTP ${res.status})`);
      }
      item = (await res.json()) as typeof item;
    } else {
      const s = await this.fetchImpl(`${this.base()}/root:/${this.itemPath(rel)}:/createUploadSession`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
      });
      if (!s.ok) throw new Error(`SharePoint upload session failed (HTTP ${s.status})`);
      const { uploadUrl } = (await s.json()) as { uploadUrl: string };
      let last: Response | null = null;
      for (let start = 0; start < data.length; start += CHUNK) {
        const end = Math.min(start + CHUNK, data.length);
        // The pre-authenticated upload URL must NOT receive the Authorization header.
        last = await this.fetchImpl(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Length': String(end - start), 'Content-Range': `bytes ${start}-${end - 1}/${data.length}` },
          body: new Uint8Array(data.subarray(start, end)),
        });
        if (!last.ok && last.status !== 202) throw new Error(`SharePoint chunk upload failed (HTTP ${last.status})`);
      }
      item = (await last!.json()) as typeof item;
    }
    return { itemId: item.id, parentId: item.parentReference?.id ?? null };
  }

  async deleteItem(itemId: string): Promise<void> {
    const token = await this.accessToken();
    const res = await this.fetchImpl(`${this.base()}/items/${encodeURIComponent(itemId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status !== 204 && res.status !== 404 && !res.ok) throw new Error(`SharePoint delete failed (HTTP ${res.status})`);
  }
}
