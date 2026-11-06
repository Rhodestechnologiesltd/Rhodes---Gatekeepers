import { Link } from 'react-router-dom';
import { elapsedSince, time, visitorId, VISIT_TYPE_LABEL } from '../../lib/format';
import { Card, Empty } from '../../components/ui';
import { IconIn, IconOut, IconTruck } from '../../components/icons';
import { useSession } from '../session';
import { useOnSite } from './OnSite';

export function GateHome() {
  const { me } = useSession();
  const onSite = useOnSite();
  const rows = onSite.data ?? [];
  const vehicles = new Set(rows.filter((r) => r.vehiclePlate && r.visitType === 'delivery').map((r) => r.groupId ?? r.id)).size;
  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>{me?.app.siteName}</h1><p>Hello {me?.user.displayName}. Register every person and vehicle entering the site.</p></div>
      </div>
      <div className="gate-hero">
        <Link to="/check-in" className="gate-tile">
          <IconIn />
          <span className="big">New check-in</span>
          <span className="sub">One visitor, a group, or a truck — photograph each Emirates ID</span>
        </Link>
        <Link to="/on-site" className="gate-tile teal">
          <span className="count" aria-label={`${rows.length} people on site`}>{onSite.loading && !onSite.data ? '…' : rows.length}</span>
          <IconOut />
          <span className="big">Check out</span>
          <span className="sub">People on site{vehicles ? ` · ${vehicles} vehicle${vehicles > 1 ? 's' : ''}` : ''}</span>
        </Link>
      </div>
      <Card title="Most recent arrivals still on site" actions={<Link to="/on-site" className="btn btn-sm btn-secondary">View all</Link>}>
        {rows.length === 0 ? <Empty title="Nobody is on site" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Visitor ID</th><th>Name</th><th>Type</th><th>Host / vehicle</th><th>In</th><th>On site</th></tr></thead>
              <tbody>
                {[...rows].sort((a, b) => b.checkedInAt.localeCompare(a.checkedInAt)).slice(0, 8).map((v) => (
                  <tr key={v.id}>
                    <td className="mono">{visitorId(v.referenceNo)}</td>
                    <td><strong>{v.visitorName}</strong>{v.company && <div className="muted small">{v.company}</div>}</td>
                    <td>{v.visitType === 'delivery' ? <span className="row" style={{ gap: 4 }}><IconTruck width={16} height={16} /> {v.groupRole}</span> : VISIT_TYPE_LABEL[v.visitType]}</td>
                    <td>{v.vehiclePlate ?? v.hostName ?? '—'}</td>
                    <td className="nowrap">{time(v.checkedInAt)}</td>
                    <td className="nowrap">{elapsedSince(v.checkedInAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
