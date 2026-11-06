import { useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { Alert, Badge, Button, Card, Empty, Modal, Spinner, TextInput, useAsync, useToast } from '../../components/ui';

interface Device { id: string; name: string; status: 'active' | 'awaiting_enrollment' | 'code_expired' | 'revoked'; platform: string | null; appVersion: string | null; enrolledAt: string | null; lastSeenAt: string | null; enrollmentExpiresAt: string | null }

export function DevicesPage() {
  const toast = useToast();
  const list = useAsync(() => api<Device[]>('/admin/devices'), []);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState<{ name: string; code: string } | null>(null);
  const [err, setErr] = useState('');

  const create = async () => {
    setErr('');
    try {
      const r = await api<{ device: Device; enrollmentCode: string }>('/admin/devices', { body: { name } });
      setAdding(false);
      setName('');
      setCode({ name: r.device.name, code: r.enrollmentCode });
      void list.reload();
    } catch (e) { setErr((e as ApiError).message); }
  };
  const newCode = async (d: Device) => {
    if (d.status === 'active' && !window.confirm(`Issue a new code for "${d.name}"? The tablet will be signed out and must be set up again.`)) return;
    const r = await api<{ device: Device; enrollmentCode: string }>(`/admin/devices/${d.id}/new-code`, { body: {} });
    setCode({ name: d.name, code: r.enrollmentCode });
    void list.reload();
  };
  const revoke = async (d: Device) => {
    if (!window.confirm(`Revoke "${d.name}"? Anyone signed in on it is signed out immediately.`)) return;
    await api(`/admin/devices/${d.id}/revoke`, { body: {} });
    toast('Tablet revoked');
    void list.reload();
  };

  const status = (s: Device['status']) =>
    s === 'active' ? <Badge tone="green">Active</Badge> : s === 'awaiting_enrollment' ? <Badge tone="amber">Waiting for set-up</Badge> : s === 'revoked' ? <Badge>Revoked</Badge> : <Badge>Code expired</Badge>;

  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>Gate tablets</h1><p>Security guards can only sign in on tablets enrolled here. Lost or replaced tablet? Revoke it.</p></div>
        <Button variant="primary" onClick={() => setAdding(true)}>Add tablet</Button>
      </div>
      <Card>
        {list.loading && !list.data ? <Spinner /> : !list.data?.length ? <Empty title="No tablets yet">Add a tablet, then enter the code in the Rhodes Gatekeeper app on it.</Empty> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Name</th><th>Status</th><th>Platform</th><th>Enrolled</th><th>Last used</th><th /></tr></thead>
            <tbody>{list.data.map((d) => (
              <tr key={d.id}>
                <td><strong>{d.name}</strong></td>
                <td>{status(d.status)}{d.status === 'awaiting_enrollment' && <div className="muted small">code valid until {dateTime(d.enrollmentExpiresAt)}</div>}</td>
                <td className="small">{d.platform ?? '—'}{d.appVersion ? ` · v${d.appVersion}` : ''}</td>
                <td className="small nowrap">{dateTime(d.enrolledAt)}</td>
                <td className="small nowrap">{dateTime(d.lastSeenAt)}</td>
                <td className="right"><div className="row" style={{ justifyContent: 'flex-end' }}>
                  <Button size="sm" onClick={() => void newCode(d)}>{d.status === 'active' ? 'Re-enrol' : 'New code'}</Button>
                  {d.status !== 'revoked' && <Button size="sm" variant="danger" onClick={() => void revoke(d)}>Revoke</Button>}
                </div></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      {adding && (
        <Modal title="Add a gate tablet" onClose={() => setAdding(false)} footer={<><Button onClick={() => setAdding(false)}>Cancel</Button><Button variant="primary" disabled={!name.trim()} onClick={() => void create()}>Create code</Button></>}>
          <div className="stack">
            {err && <Alert tone="error">{err}</Alert>}
            <TextInput label="Tablet name" value={name} onChange={setName} placeholder="e.g. Main gate — tablet 1" required />
          </div>
        </Modal>
      )}
      {code && (
        <Modal title={`Enrolment code — ${code.name}`} onClose={() => setCode(null)} footer={<Button variant="primary" onClick={() => setCode(null)}>Done</Button>}>
          <div className="stack" style={{ textAlign: 'center' }}>
            <div className="ref-big mono" style={{ letterSpacing: '0.15em' }}>{code.code}</div>
            <p>On the tablet, open <strong>Rhodes Gatekeeper</strong>, enter this server's address and the code above.</p>
            <p className="muted small">Single use, valid for 24 hours. It will not be shown again.</p>
          </div>
        </Modal>
      )}
    </div>
  );
}
