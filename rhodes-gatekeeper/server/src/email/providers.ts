import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';

export interface EmailMessage {
  to: string[];
  subject: string;
  html: string;
  text: string;
}

export interface EmailProvider {
  readonly name: 'graph' | 'devlog' | 'disabled';
  /** true only for providers that actually deliver mail */
  readonly delivers: boolean;
  send(msg: EmailMessage): Promise<void>;
}

/**
 * Microsoft 365 via Microsoft Graph (OAuth 2.0 client-credentials flow).
 *
 * Requires an Entra ID app registration with the *application* permission Mail.Send (admin consented).
 * Strongly recommended: restrict the app to the single sender mailbox using Exchange Online
 * RBAC for Applications (or an Application Access Policy) so it cannot send as anyone else.
 * The sender is a company-approved mailbox (e.g. gatekeeper@company) — the tablet has no mailbox.
 */
export class GraphEmailProvider implements EmailProvider {
  readonly name = 'graph' as const;
  readonly delivers = true;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly cfg: { tenantId: string; clientId: string; clientSecret: string; sender: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value;
    const res = await this.fetchImpl(
      `https://login.microsoftonline.com/${encodeURIComponent(this.cfg.tenantId)}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.cfg.clientId,
          client_secret: this.cfg.clientSecret,
          scope: 'https://graph.microsoft.com/.default',
          grant_type: 'client_credentials',
        }),
      },
    );
    if (!res.ok) throw new Error(`Microsoft identity token request failed (HTTP ${res.status})`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  async send(msg: EmailMessage): Promise<void> {
    const token = await this.accessToken();
    const res = await this.fetchImpl(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(this.cfg.sender)}/sendMail`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            subject: msg.subject,
            body: { contentType: 'HTML', content: msg.html },
            toRecipients: msg.to.map((address) => ({ emailAddress: { address } })),
          },
          saveToSentItems: true,
        }),
      },
    );
    if (res.status !== 202 && !res.ok) {
      if (res.status === 401) this.token = null;
      throw new Error(`Microsoft Graph sendMail failed (HTTP ${res.status})`);
    }
  }
}

/**
 * DEVELOPMENT ONLY. Writes a short line to the log instead of sending. NOT FOR PRODUCTION.
 * Logs recipients count and subject only — never the body (which contains visitor details).
 */
export class DevLogEmailProvider implements EmailProvider {
  readonly name = 'devlog' as const;
  readonly delivers = false;
  readonly sent: EmailMessage[] = [];
  constructor(private readonly log: Logger) {}
  async send(msg: EmailMessage): Promise<void> {
    this.sent.push(msg);
    if (this.sent.length > 50) this.sent.shift();
    this.log.warn({ recipients: msg.to.length, subject: msg.subject }, '[NON-PRODUCTION EMAIL LOGGER] email not sent');
  }
}

export class DisabledEmailProvider implements EmailProvider {
  readonly name = 'disabled' as const;
  readonly delivers = false;
  async send(): Promise<void> {
    /* intentionally does nothing */
  }
}

export function createEmailProvider(config: AppConfig, log: Logger): EmailProvider {
  switch (config.EMAIL_PROVIDER) {
    case 'graph':
      return new GraphEmailProvider({
        tenantId: config.M365_TENANT_ID!,
        clientId: config.M365_CLIENT_ID!,
        clientSecret: config.M365_CLIENT_SECRET!,
        sender: config.M365_SENDER_ADDRESS!,
      });
    case 'disabled':
      return new DisabledEmailProvider();
    case 'devlog':
    default:
      return new DevLogEmailProvider(log);
  }
}
