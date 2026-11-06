import { useEffect, useState } from 'react';
import { api, ApiError, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateTime, VISIT_TYPE_LONG } from '../../lib/format';
import type { VisitType } from '../../lib/types';
import { Alert, Badge, Button, Card, Select, Spinner, TextArea, TextInput, Toggle, useAsync, useToast } from '../../components/ui';

interface Settings {
  companyName: string; siteName: string; timezone: string; requireIdDocument: boolean; storeFullIdNumber: boolean; storeIdExpiryDate: boolean;
  privacyNotice: { enabled: boolean; requireAcknowledgement: boolean; text: string };
  overdueAfterHours: number;
  capture: { storeIdImages: boolean; requireIdImages: boolean; requirePlatePhotoForDelivery: boolean; requireDocumentForDelivery: boolean; maxGroupSize: number };
  retention: { enabled: boolean; visitorDataDays: number; mode: 'anonymize' | 'delete'; auditLogDays: number; notificationDays: number; idImageDays: number };
  emailFooter: string;
}
interface Env { sharepointEnabled: boolean; sharepointBasePath: string | null; emailProvider: string; emailDelivers: boolean; verificationProvider: string; verificationEnabled: boolean; fullIdStorageAllowedByEnvironment: boolean; usingDevelopmentEncryptionKey: boolean; database: string; nodeEnv: string }
interface Rule { visitType: VisitType; enabled: boolean; notifyHost: boolean; notifyDepartment: boolean; extraRecipients: string[]; notifyOnCheckout: boolean }

const TIMEZONES = ['Asia/Dubai', 'Asia/Muscat', 'Asia/Riyadh', 'Asia/Qatar', 'Asia/Bahrain', 'Asia/Kuwait', 'Indian/Mauritius', 'Europe/London', 'UTC'];

export function SettingsPage() {
  const [tab, setTab] = useState<'general' | 'privacy' | 'notifications' | 'retention' | 'integrations'>('general');
  const data = useAsync(() => api<{ settings: Settings; environment: Env }>('/admin/settings'), []);
  if (data.loading && !data.data) return <Spinner />;
  if (data.error) return <Alert tone="error">{data.error.message}</Alert>;
  const tabs: [typeof tab, string][] = [['general', 'General'], ['privacy', 'ID, photos & privacy'], ['notifications', 'Notifications'], ['retention', 'Data retention'], ['integrations', 'Integrations']];
  return (
    <div className="stack">
      <div className="page-head"><div><h1>Settings</h1><p>Company policy and system configuration.</p></div></div>
      <div className="tabs" role="tablist">{tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>)}</div>
      {tab === 'notifications' ? <NotificationSettings env={data.data!.environment} /> : tab === 'integrations' ? <Integrations env={data.data!.environment} /> : (
        <SettingsForm tab={tab} initial={data.data!.settings} env={data.data!.environment} onSaved={(s) => data.setData({ ...data.data!, settings: s })} />
      )}
    </div>
  );
}

function SettingsForm({ tab, initial, env, onSaved }: { tab: 'general' | 'privacy' | 'retention'; initial: Settings; env: Env; onSaved: (s: Settings) => void }) {
  const { refresh } = useAuth();
  const toast = useToast();
  const [s, setS] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [retention, setRetention] = useState<string | null>(null);
  useEffect(() => setS(initial), [initial]);

  const save = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api<{ settings: Settings }>('/admin/settings', { method: 'PUT', body: s });
      onSaved(r.settings);
      await refresh();
      toast('Settings saved');
    } catch (e) { setErr((e as ApiError).message + (Object.keys((e as ApiError).fields).length ? `: ${Object.entries((e as ApiError).fields).map(([k, v]) => `${k} — ${v}`).join('; ')}` : '')); } finally { setBusy(false); }
  };
  const runRetention = async () => {
    if (!window.confirm(`Apply the retention policy now? Visitor data older than ${initial.retention.visitorDataDays} days will be ${initial.retention.mode === 'delete' ? 'DELETED' : 'anonymised'}. This cannot be undone.`)) return;
    try {
      const r = await api<{ visitorsAffected: number; auditLogsDeleted: number }>('/admin/retention/run', { body: {} });
      setRetention(`${r.visitorsAffected} visitor record(s) ${initial.retention.mode === 'delete' ? 'deleted' : 'anonymised'}, ${r.auditLogsDeleted} audit entries removed.`);
    } catch (e) { setErr((e as ApiError).message); }
  };

  return (
    <Card>
      <div className="stack" style={{ maxWidth: 760 }}>
        {err && <Alert tone="error">{err}</Alert>}
        {tab === 'general' && (
          <>
            <div className="form-grid">
              <TextInput label="Company name" value={s.companyName} onChange={(v) => setS({ ...s, companyName: v })} />
              <TextInput label="Site / gate name" value={s.siteName} onChange={(v) => setS({ ...s, siteName: v })} />
              <Select label="Company timezone" value={s.timezone} onChange={(v) => setS({ ...s, timezone: v })} options={[...new Set([s.timezone, ...TIMEZONES])].map((t) => ({ value: t, label: t }))} hint="All reports, day boundaries and email times use this timezone." />
              <TextInput label="Flag visitors on site longer than (hours)" type="number" min={1} max={72} value={String(s.overdueAfterHours)} onChange={(v) => setS({ ...s, overdueAfterHours: Number(v) || 1 })} />
            </div>
            <TextInput label="Email footer" value={s.emailFooter} onChange={(v) => setS({ ...s, emailFooter: v })} />
          </>
        )}
        {tab === 'privacy' && (
          <>
            <h3>Identity documents</h3>
            <Toggle label="Require an ID document for every check-in" checked={s.requireIdDocument} onChange={(v) => setS({ ...s, requireIdDocument: v })} hint="When off, guards can check in visitors without an ID (recorded as “No ID”)." />
            <Toggle label="Keep the card expiry date" checked={s.storeIdExpiryDate} onChange={(v) => setS({ ...s, storeIdExpiryDate: v })} />
            <Toggle label="Store full ID numbers (encrypted)" checked={s.storeFullIdNumber} onChange={(v) => setS({ ...s, storeFullIdNumber: v })}
              hint={<>By default only a masked number and a keyed hash are kept. Enable only with documented company approval. {env.fullIdStorageAllowedByEnvironment ? <Badge tone="amber">Allowed by server configuration</Badge> : <Badge>Blocked by server configuration (ALLOW_FULL_ID_STORAGE)</Badge>}</>} />
            <h3 style={{ marginTop: 8 }}>Photos at the gate</h3>
            <Toggle label="Save photos of identity cards in the visit folder" checked={s.capture.storeIdImages} onChange={(v) => setS({ ...s, capture: { ...s.capture, storeIdImages: v } })}
              hint="Encrypted on the server (and copied to SharePoint if enabled). Only managers and administrators can open them, and every view is recorded. Enable only with the company's approval." />
            {s.capture.storeIdImages && <Toggle label="Require front and back photos of each person's ID" checked={s.capture.requireIdImages} onChange={(v) => setS({ ...s, capture: { ...s.capture, requireIdImages: v } })} />}
            <Toggle label="Deliveries/collections: require a number-plate photo" checked={s.capture.requirePlatePhotoForDelivery} onChange={(v) => setS({ ...s, capture: { ...s.capture, requirePlatePhotoForDelivery: v } })} />
            <Toggle label="Deliveries/collections: require a PO or invoice photo" checked={s.capture.requireDocumentForDelivery} onChange={(v) => setS({ ...s, capture: { ...s.capture, requireDocumentForDelivery: v } })} />
            <TextInput label="Maximum people in one group" type="number" min={1} max={100} value={String(s.capture.maxGroupSize)} onChange={(v) => setS({ ...s, capture: { ...s.capture, maxGroupSize: Number(v) || 1 } })} />
            <Alert tone="info">Text on cards is read on the tablet. Date of birth is shown to the guard but never saved; the text read from ID cards is not stored.</Alert>
            <h3 style={{ marginTop: 8 }}>Visitor privacy notice</h3>
            <Toggle label="Show privacy notice at check-in" checked={s.privacyNotice.enabled} onChange={(v) => setS({ ...s, privacyNotice: { ...s.privacyNotice, enabled: v } })} />
            <Toggle label="Require the visitor's acknowledgement" checked={s.privacyNotice.requireAcknowledgement} onChange={(v) => setS({ ...s, privacyNotice: { ...s.privacyNotice, requireAcknowledgement: v } })} />
            <TextArea label="Notice text" rows={8} value={s.privacyNotice.text} onChange={(v) => setS({ ...s, privacyNotice: { ...s.privacyNotice, text: v } })} hint="Use wording approved by the company's legal/privacy owner. The default text is a placeholder." />
          </>
        )}
        {tab === 'retention' && (
          <>
            <Alert tone="warn">Set these periods according to the company's own legal and policy requirements. The application does not determine what is legally required.</Alert>
            <Toggle label="Apply retention automatically (checked every 6 hours)" checked={s.retention.enabled} onChange={(v) => setS({ ...s, retention: { ...s.retention, enabled: v } })} />
            <div className="form-grid">
              <TextInput label="Keep visitor personal data for (days)" type="number" min={1} value={String(s.retention.visitorDataDays)} onChange={(v) => setS({ ...s, retention: { ...s.retention, visitorDataDays: Number(v) || 1 } })} />
              <Select label="After that period" value={s.retention.mode} onChange={(v) => setS({ ...s, retention: { ...s.retention, mode: v as 'anonymize' | 'delete' } })} options={[{ value: 'anonymize', label: 'Anonymise (keep counts and durations)' }, { value: 'delete', label: 'Delete the visit entirely' }]} />
              <TextInput label="Keep audit log for (days)" type="number" min={30} value={String(s.retention.auditLogDays)} onChange={(v) => setS({ ...s, retention: { ...s.retention, auditLogDays: Number(v) || 30 } })} />
              <TextInput label="Keep sent email records for (days)" type="number" min={1} value={String(s.retention.notificationDays)} onChange={(v) => setS({ ...s, retention: { ...s.retention, notificationDays: Number(v) || 1 } })} />
              <TextInput label="Delete ID card photos after (days)" type="number" min={1} value={String(s.retention.idImageDays)} onChange={(v) => setS({ ...s, retention: { ...s.retention, idImageDays: Number(v) || 1 } })} hint="Can be shorter than visitor data. Plate and PO/invoice photos follow the visitor-data period." />
            </div>
            <p className="note">Visitors still on site are never purged.</p>
            {retention && <Alert tone="success">{retention}</Alert>}
          </>
        )}
        <div className="row">
          <Button variant="primary" busy={busy} onClick={() => void save()}>Save settings</Button>
          {tab === 'retention' && <Button variant="danger" onClick={() => void runRetention()}>Run retention now (saved settings)</Button>}
        </div>
      </div>
    </Card>
  );
}

function SharePointStatus() {
  const toast = useToast();
  const st = useAsync(() => api<{ counts: Record<string, number>; failed: { id: string; fileName: string; folderName: string; error: string }[]; pendingDeletes: number }>('/admin/sharepoint'), []);
  if (!st.data) return null;
  const c = st.data.counts;
  return (
    <div className="stack" style={{ marginTop: 20 }}>
      <h3>SharePoint sync</h3>
      <div className="row">
        <Badge tone="green">{c.synced ?? 0} copied</Badge><Badge tone="amber">{c.pending ?? 0} waiting</Badge><Badge tone="red">{c.failed ?? 0} failed</Badge>
        {st.data.pendingDeletes > 0 && <Badge>{st.data.pendingDeletes} deletions queued</Badge>}
        {(c.failed ?? 0) > 0 && <Button size="sm" onClick={() => void api('/admin/sharepoint/retry', { body: {} }).then(() => { toast('Retrying failed uploads'); void st.reload(); })}>Retry failed</Button>}
      </div>
      {st.data.failed.slice(0, 10).map((f) => <div key={f.id} className="small"><span className="mono">{f.folderName}/{f.fileName}</span> — <span className="muted">{f.error}</span></div>)}
    </div>
  );
}

function NotificationSettings({ env }: { env: Env }) {
  const rules = useAsync(() => api<Rule[]>('/admin/notification-rules'), []);
  return (
    <div className="stack">
      {!env.emailDelivers && <Alert tone="warn" title={env.emailProvider === 'devlog' ? 'Development email logger active' : 'Email is disabled'}>Rules are saved and notifications are recorded, but no email leaves the server until Microsoft 365 (Graph) is configured.</Alert>}
      {rules.loading && !rules.data ? <Spinner /> : (
        <div className="grid grid-2">{(rules.data ?? []).map((r) => <RuleCard key={r.visitType} rule={r} onSaved={() => void rules.reload()} />)}</div>
      )}
      <Outbox />
    </div>
  );
}

function RuleCard({ rule, onSaved }: { rule: Rule; onSaved: () => void }) {
  const toast = useToast();
  const [r, setR] = useState({ ...rule, extra: rule.extraRecipients.join(', ') });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setErr('');
    try {
      const extraRecipients = r.extra.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
      await api(`/admin/notification-rules/${rule.visitType}`, { method: 'PUT', body: { enabled: r.enabled, notifyHost: r.notifyHost, notifyDepartment: r.notifyDepartment, notifyOnCheckout: r.notifyOnCheckout, extraRecipients } });
      toast(`${VISIT_TYPE_LONG[rule.visitType]} rule saved`);
      onSaved();
    } catch (e) { const ae = e as ApiError; setErr(Object.values(ae.fields)[0] ?? ae.message); } finally { setBusy(false); }
  };
  return (
    <Card title={VISIT_TYPE_LONG[rule.visitType]}>
      <div className="stack">
        <Toggle label="Send notifications for this visit type" checked={r.enabled} onChange={(v) => setR({ ...r, enabled: v })} />
        <Toggle label="Email the host / receiving employee" checked={r.notifyHost} onChange={(v) => setR({ ...r, notifyHost: v })} />
        <Toggle label="Email the department's notification address" checked={r.notifyDepartment} onChange={(v) => setR({ ...r, notifyDepartment: v })} />
        <Toggle label="Also notify when the visitor checks out" checked={r.notifyOnCheckout} onChange={(v) => setR({ ...r, notifyOnCheckout: v })} />
        <TextInput label="Always also send to" value={r.extra} onChange={(v) => setR({ ...r, extra: v })} placeholder="security@company.com, reception@company.com" hint="Comma-separated addresses or distribution lists." error={err || undefined} />
        <div><Button variant="brand" busy={busy} onClick={() => void save()}>Save rule</Button></div>
      </div>
    </Card>
  );
}

interface N { id: string; event: string; recipients: string[]; subject: string; status: string; attempts: number; lastError: string | null; createdAt: string; provider: string }
function Outbox() {
  const toast = useToast();
  const [status, setStatus] = useState('');
  const list = useAsync(() => api<N[]>(`/admin/notifications${qs({ status })}`), [status]);
  const retry = async (id: string) => {
    try { await api(`/admin/notifications/${id}/retry`, { body: {} }); toast('Queued for retry'); void list.reload(); } catch (e) { toast((e as ApiError).message, 'error'); }
  };
  return (
    <Card title="Recent notifications" actions={<Select label="Status" value={status} onChange={setStatus} placeholder="All" options={['pending', 'sent', 'failed', 'skipped'].map((s) => ({ value: s, label: s }))} />}>
      <div className="table-wrap"><table className="data">
        <thead><tr><th>When</th><th>Subject</th><th>To</th><th>Status</th><th /></tr></thead>
        <tbody>{(list.data ?? []).map((n) => (
          <tr key={n.id}>
            <td className="small nowrap">{dateTime(n.createdAt)}</td><td>{n.subject}</td><td className="small">{n.recipients.join(', ') || '—'}</td>
            <td><Badge tone={n.status === 'sent' ? 'green' : n.status === 'failed' ? 'red' : n.status === 'pending' ? 'amber' : 'neutral'}>{n.status}</Badge>{n.provider === 'devlog' && <div className="muted small">dev logger — not sent</div>}{n.lastError && <div className="muted small">{n.lastError}</div>}</td>
            <td>{(n.status === 'failed') && <Button size="sm" onClick={() => void retry(n.id)}>Retry</Button>}</td>
          </tr>
        ))}</tbody>
      </table></div>
    </Card>
  );
}

function Integrations({ env }: { env: Env }) {
  const row = (label: string, ok: boolean, value: string, note: string) => (
    <tr><td><strong>{label}</strong></td><td><Badge tone={ok ? 'green' : 'amber'}>{value}</Badge></td><td className="small muted">{note}</td></tr>
  );
  return (
    <Card title="Integration status">
      <p className="muted" style={{ marginTop: -6 }}>These are configured by your IT administrator through server environment variables, not in this screen.</p>
      <div className="table-wrap"><table className="data">
        <tbody>
          {row('Microsoft 365 email', env.emailProvider === 'graph', env.emailProvider === 'graph' ? 'Microsoft Graph' : env.emailProvider === 'devlog' ? 'Dev logger (not sending)' : 'Disabled', 'EMAIL_PROVIDER, M365_TENANT_ID, M365_CLIENT_ID, M365_CLIENT_SECRET, M365_SENDER_ADDRESS')}
          {row('SharePoint copy of folders', env.sharepointEnabled, env.sharepointEnabled ? `On — ${env.sharepointBasePath}` : 'Off', 'SHAREPOINT_ENABLED, SHAREPOINT_DRIVE_ID, SHAREPOINT_BASE_PATH (uses the Microsoft 365 app registration; needs Sites.Selected).')}
          {row('Identity verification', env.verificationEnabled, env.verificationEnabled ? env.verificationProvider : 'Not configured', 'Scanned IDs are labelled “scanned”, not “verified”. An approved UAE verification service can be added as an adapter.')}
          {row('Encryption key', !env.usingDevelopmentEncryptionKey, env.usingDevelopmentEncryptionKey ? 'Development key' : 'Configured', 'DATA_ENCRYPTION_KEY — protects ID hashes and any stored ID numbers.')}
          {row('Full ID storage gate', true, env.fullIdStorageAllowedByEnvironment ? 'Allowed' : 'Blocked', 'ALLOW_FULL_ID_STORAGE — must be true AND the admin setting enabled.')}
          {row('Database', env.database === 'pg', env.database === 'pg' ? 'PostgreSQL' : 'SQLite (development)', env.nodeEnv)}
        </tbody>
      </table></div>
      {env.sharepointEnabled && <SharePointStatus />}
    </Card>
  );
}
