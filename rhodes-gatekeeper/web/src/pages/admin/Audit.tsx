import { useState } from 'react';
import { api, qs } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { Alert, Button, Card, Empty, Select, Spinner, useAsync } from '../../components/ui';

interface Entry { id: string; at: string; actorUsername: string | null; action: string; entityType: string | null; entityId: string | null; details: Record<string, unknown> | null; ip: string | null }

const ACTIONS = [
  'auth.login', 'auth.login_failed', 'auth.login_locked', 'auth.logout', 'auth.password_changed',
  'visit.check_in', 'visit.check_out', 'visit.update', 'visit.manual_checkout', 'visitor.view_sensitive',
  'report.export', 'user.create', 'user.update', 'employee.save', 'department.save', 'settings.update',
  'notification_rule.update', 'notification.retry', 'retention.run',
];
const PAGE = 100;

export function AuditPage() {
  const [action, setAction] = useState('');
  const [offset, setOffset] = useState(0);
  const list = useAsync(() => api<Entry[]>(`/admin/audit${qs({ action, limit: PAGE, offset })}`), [action, offset]);
  return (
    <div className="stack">
      <div className="page-head"><div><h1>Audit log</h1><p>Sign-ins, record changes, exports and access to sensitive data. ID numbers are never written here.</p></div></div>
      <Card actions={<Select label="Action" value={action} onChange={(v) => { setAction(v); setOffset(0); }} placeholder="All actions" options={ACTIONS.map((a) => ({ value: a, label: a }))} />}>
        {list.error && <Alert tone="error">{list.error.message}</Alert>}
        {list.loading && !list.data ? <Spinner /> : !list.data?.length ? <Empty title="No entries" /> : (
          <>
            <div className="table-wrap"><table className="data">
              <thead><tr><th>When</th><th>User</th><th>Action</th><th>Record</th><th>Details</th><th>IP</th></tr></thead>
              <tbody>{list.data.map((e) => (
                <tr key={e.id}>
                  <td className="small nowrap">{dateTime(e.at)}</td>
                  <td>{e.actorUsername ?? 'system'}</td>
                  <td className="mono">{e.action}</td>
                  <td className="small">{e.entityType}{e.entityId ? <div className="muted mono">{e.entityId.slice(0, 8)}</div> : null}</td>
                  <td className="small mono" style={{ maxWidth: 360, overflowWrap: 'anywhere' }}>{e.details ? JSON.stringify(e.details) : ''}</td>
                  <td className="small mono">{e.ip ?? ''}</td>
                </tr>
              ))}</tbody>
            </table></div>
            <div className="pager">
              <span className="muted">Showing {offset + 1}–{offset + list.data.length}</span>
              <div className="row"><Button size="sm" disabled={offset === 0} onClick={() => setOffset(offset - PAGE)}>Newer</Button><Button size="sm" disabled={list.data.length < PAGE} onClick={() => setOffset(offset + PAGE)}>Older</Button></div>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
