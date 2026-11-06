import { useCallback, useState } from 'react';
import { api, qs } from '../lib/api';
import { useLiveEvents } from '../lib/auth';
import { date, DURATION_NOTE, elapsedSince, minutes, time, todayLocal, visitorId, VISIT_TYPE_LABEL } from '../lib/format';
import type { DurationStats, GroupRow, VisitSummaryRow } from '../lib/types';
import { Alert, Badge, Button, Card, Empty, Spinner, TextInput, useAsync } from '../components/ui';
import { Bars } from '../components/Bars';

interface DashboardData {
  timezone: string;
  today: string;
  range: { fromDate: string; toDate: string };
  onSite: VisitSummaryRow[];
  onSiteCount: number;
  notCheckedOut: VisitSummaryRow[];
  overdueAfterHours: number;
  todayStats: { totals: DurationStats; byType: GroupRow[] };
  selected: { totals: DurationStats; byType: GroupRow[]; byEmployee: GroupRow[]; byDepartment: GroupRow[]; recent: VisitSummaryRow[] };
}

export function DashboardPage() {
  const [from, setFrom] = useState(todayLocal(-6));
  const [to, setTo] = useState(todayLocal());
  const [applied, setApplied] = useState({ from, to });
  const d = useAsync(() => api<DashboardData>(`/dashboard${qs({ from: applied.from, to: applied.to })}`), [applied]);
  const reload = useCallback(() => void d.reload(), [d.reload]);
  useLiveEvents(reload);

  const preset = (days: number | 'month') => {
    const t = todayLocal();
    const f = days === 'month' ? `${t.slice(0, 8)}01` : todayLocal(-days);
    setFrom(f); setTo(t); setApplied({ from: f, to: t });
  };

  if (d.loading && !d.data) return <Spinner />;
  if (d.error) return <Alert tone="error">{d.error.message}</Alert>;
  const x = d.data!;
  const sel = x.selected;
  const rangeLabel = x.range.fromDate === x.range.toDate ? date(`${x.range.fromDate}T12:00:00Z`) : `${date(`${x.range.fromDate}T12:00:00Z`)} – ${date(`${x.range.toDate}T12:00:00Z`)}`;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p>Live view of the site · times in {x.timezone} <Badge tone="green">● Live updates</Badge></p>
        </div>
      </div>

      <div className="kpis">
        <div className="kpi accent"><div className="kpi-label">On site now</div><div className="kpi-value">{x.onSiteCount}</div><div className="kpi-sub">checked in, not checked out</div></div>
        <div className="kpi"><div className="kpi-label">Vehicles on site</div><div className="kpi-value">{new Set(x.onSite.filter((v) => v.visitType === 'delivery' && v.vehiclePlate).map((v) => v.groupId ?? v.id)).size}</div><div className="kpi-sub">deliveries & collections</div></div>
        <div className="kpi"><div className="kpi-label">Visitors today</div><div className="kpi-value">{x.todayStats.totals.visits}</div><div className="kpi-sub">{x.todayStats.totals.completed} checked out</div></div>
        <div className="kpi"><div className="kpi-label">Visitors · selected range</div><div className="kpi-value">{sel.totals.visits}</div><div className="kpi-sub">{rangeLabel}</div></div>
        <div className="kpi"><div className="kpi-label">Average gate duration</div><div className="kpi-value">{minutes(sel.totals.averageMinutes)}</div><div className="kpi-sub">total {minutes(sel.totals.totalMinutes)} · {sel.totals.completed} visits</div></div>
        <div className={`kpi ${x.notCheckedOut.length ? 'warn' : ''}`}><div className="kpi-label">Not checked out</div><div className="kpi-value">{x.notCheckedOut.length}</div><div className="kpi-sub">from earlier days or over {x.overdueAfterHours}h</div></div>
      </div>

      <Card title="Period">
        <div className="filters">
          <TextInput label="From" type="date" value={from} onChange={setFrom} max={to} />
          <TextInput label="To" type="date" value={to} onChange={setTo} min={from} />
          <Button variant="brand" onClick={() => setApplied({ from, to })}>Apply</Button>
          <Button onClick={() => preset(0)}>Today</Button>
          <Button onClick={() => preset(6)}>Last 7 days</Button>
          <Button onClick={() => preset('month')}>This month</Button>
        </div>
      </Card>

      {x.notCheckedOut.length > 0 && (
        <Card title={<>Visitors who have not checked out <Badge tone="amber">{x.notCheckedOut.length}</Badge></>}>
          <p className="muted small" style={{ marginTop: -6 }}>Checked in on an earlier day, or on site longer than {x.overdueAfterHours} hours. Confirm with the host; reception can record a corrected check-out from the Visits page.</p>
          <VisitTable rows={x.notCheckedOut} showDate />
        </Card>
      )}

      <div className="grid grid-2">
        <Card title="Currently on site">
          {x.onSite.length ? <VisitTable rows={x.onSite} /> : <Empty title="Nobody is on site" />}
        </Card>
        <Card title={`Visits by type · ${rangeLabel}`}>
          <Bars rows={sel.byType.map((t) => ({ label: t.label, value: t.visits }))} accent />
          <div className="table-wrap" style={{ marginTop: 16 }}><table className="data">
            <thead><tr><th>Type</th><th className="num">Visits</th><th className="num">Avg duration</th><th className="num">No check-out</th></tr></thead>
            <tbody>{sel.byType.map((t) => <tr key={t.key}><td>{t.label}</td><td className="num">{t.visits}</td><td className="num">{minutes(t.averageMinutes)}</td><td className="num">{t.missingCheckout}</td></tr>)}</tbody>
          </table></div>
        </Card>
      </div>

      <div className="grid grid-2">
        <Card title="Visits by department"><Bars rows={sel.byDepartment.map((g) => ({ label: g.label, value: g.visits }))} /></Card>
        <Card title="Visits by employee (top 15)">
          {sel.byEmployee.length ? (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Employee</th><th className="num">Visits</th><th className="num">Total</th><th className="num">Average</th></tr></thead>
              <tbody>{sel.byEmployee.map((g) => <tr key={g.key}><td>{g.label}</td><td className="num">{g.visits}</td><td className="num">{minutes(g.totalMinutes)}</td><td className="num">{minutes(g.averageMinutes)}</td></tr>)}</tbody>
            </table></div>
          ) : <Empty title="No hosted visits in this period" />}
        </Card>
      </div>

      <Card title={`Latest visits · ${rangeLabel}`}>
        {sel.recent.length ? <VisitTable rows={sel.recent} showDate showOut /> : <Empty title="No visits in this period" />}
      </Card>
      <p className="note">{DURATION_NOTE}</p>
    </div>
  );
}

function VisitTable({ rows, showDate, showOut }: { rows: VisitSummaryRow[]; showDate?: boolean; showOut?: boolean }) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead><tr><th>Visitor ID</th><th>Visitor</th><th>Type</th><th>Host / dept.</th><th>In</th>{showOut ? <th>Out</th> : <th>On site</th>}{showOut && <th className="num">Duration</th>}</tr></thead>
        <tbody>
          {rows.map((v) => (
            <tr key={v.id}>
              <td className="mono">{visitorId(v.referenceNo)}</td>
              <td><strong>{v.visitorName}</strong>{v.company && <div className="muted small">{v.company}</div>}</td>
              <td>{VISIT_TYPE_LABEL[v.visitType]}</td>
              <td>{v.vehiclePlate && v.visitType === 'delivery' ? <span className="plate sm">{v.vehiclePlate}</span> : v.hostName ?? v.department ?? '—'}</td>
              <td className="nowrap">{showDate && <span className="muted small">{date(v.checkedInAt)} </span>}{time(v.checkedInAt)}</td>
              {showOut ? <td className="nowrap">{v.checkedOutAt ? time(v.checkedOutAt) : <Badge tone="amber">Not checked out</Badge>}{v.checkoutMethod === 'manual_correction' && <> <Badge>corrected</Badge></>}</td> : <td className="nowrap">{elapsedSince(v.checkedInAt)}</td>}
              {showOut && <td className="num">{minutes(v.durationMinutes)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
