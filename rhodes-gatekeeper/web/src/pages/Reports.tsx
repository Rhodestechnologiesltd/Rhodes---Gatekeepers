import { useState } from 'react';
import { api, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, DURATION_NOTE, minutes, todayLocal, VISIT_TYPE_LABEL } from '../lib/format';
import type { Department, DurationStats, Employee, GroupRow } from '../lib/types';
import { Alert, Button, Card, Empty, Select, Spinner, TextInput, useAsync } from '../components/ui';
import { Bars } from '../components/Bars';

interface Summary {
  range: { fromDate: string; toDate: string };
  totals: DurationStats;
  byType: GroupRow[];
  byEmployee: GroupRow[];
  byDepartment: GroupRow[];
  durationDefinition: string;
}

export function ReportsPage() {
  const { can } = useAuth();
  const [mode, setMode] = useState<'month' | 'range'>('month');
  const [f, setF] = useState({ month: todayLocal().slice(0, 7), from: todayLocal(-30), to: todayLocal(), employeeId: '', departmentId: '', visitType: '' });
  const [applied, setApplied] = useState({ ...f, mode });
  const employees = useAsync(() => api<Employee[]>('/directory/employees'), []);
  const departments = useAsync(() => api<Department[]>('/directory/departments'), []);

  const query = qs({
    month: applied.mode === 'month' ? applied.month : undefined,
    from: applied.mode === 'range' ? applied.from : undefined,
    to: applied.mode === 'range' ? applied.to : undefined,
    employeeId: applied.employeeId, departmentId: applied.departmentId, visitType: applied.visitType,
  });
  const r = useAsync(() => api<Summary>(`/reports/summary${query}`), [query]);
  const s = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));
  const d = (x: string) => date(`${x}T12:00:00Z`);

  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>Reports</h1><p>Monthly and date-range visitor reports.</p></div>
        {can('report.export') && <a className="btn btn-primary" href={`/api/reports/export.csv${query}`} download>Export CSV</a>}
      </div>
      <Card>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={mode === 'month'} onClick={() => setMode('month')}>Monthly</button>
          <button role="tab" aria-selected={mode === 'range'} onClick={() => setMode('range')}>Date range</button>
        </div>
        <form className="filters" onSubmit={(e) => { e.preventDefault(); setApplied({ ...f, mode }); }}>
          {mode === 'month' ? <TextInput label="Month" type="month" value={f.month} onChange={s('month')} /> : (
            <><TextInput label="From" type="date" value={f.from} onChange={s('from')} /><TextInput label="To" type="date" value={f.to} onChange={s('to')} /></>
          )}
          <Select label="Employee" value={f.employeeId} onChange={s('employeeId')} placeholder="All employees" options={(employees.data ?? []).map((e) => ({ value: e.id, label: e.fullName }))} />
          <Select label="Department" value={f.departmentId} onChange={s('departmentId')} placeholder="All departments" options={(departments.data ?? []).map((x) => ({ value: x.id, label: x.name }))} />
          <Select label="Visit type" value={f.visitType} onChange={s('visitType')} placeholder="All types" options={Object.entries(VISIT_TYPE_LABEL).map(([value, label]) => ({ value, label }))} />
          <Button variant="brand" type="submit">Run report</Button>
        </form>
      </Card>

      {r.error && <Alert tone="error">{r.error.message}</Alert>}
      {r.loading && !r.data ? <Spinner /> : r.data && (
        <>
          <h2>{d(r.data.range.fromDate)} – {d(r.data.range.toDate)}</h2>
          <div className="kpis">
            <div className="kpi accent"><div className="kpi-label">Total visits</div><div className="kpi-value">{r.data.totals.visits}</div></div>
            <div className="kpi"><div className="kpi-label">With check-out</div><div className="kpi-value">{r.data.totals.completed}</div></div>
            <div className={`kpi ${r.data.totals.missingCheckout ? 'warn' : ''}`}><div className="kpi-label">Missing check-out</div><div className="kpi-value">{r.data.totals.missingCheckout}</div><div className="kpi-sub">excluded from durations</div></div>
            <div className="kpi"><div className="kpi-label">Total gate duration</div><div className="kpi-value">{minutes(r.data.totals.totalMinutes)}</div></div>
            <div className="kpi"><div className="kpi-label">Average gate duration</div><div className="kpi-value">{minutes(r.data.totals.averageMinutes)}</div></div>
          </div>
          <Alert tone="info">{DURATION_NOTE}</Alert>

          <Card title="By employee visited">
            {r.data.byEmployee.length ? <GroupTable rows={r.data.byEmployee} first="Employee" /> : <Empty title="No visits with a host in this period" />}
          </Card>
          <div className="grid grid-2">
            <Card title="By department">
              <Bars rows={r.data.byDepartment.map((g) => ({ label: g.label, value: g.visits }))} />
              <div style={{ marginTop: 16 }}><GroupTable rows={r.data.byDepartment} first="Department" compact /></div>
            </Card>
            <Card title="By visit type">
              <Bars rows={r.data.byType.map((g) => ({ label: g.label, value: g.visits }))} accent />
              <div style={{ marginTop: 16 }}><GroupTable rows={r.data.byType} first="Type" compact /></div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function GroupTable({ rows, first, compact }: { rows: GroupRow[]; first: string; compact?: boolean }) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead><tr><th>{first}</th><th className="num">Visits</th>{!compact && <th className="num">Checked out</th>}<th className="num">No check-out</th>{!compact && <th className="num">Total duration</th>}<th className="num">Average</th></tr></thead>
        <tbody>
          {rows.map((g) => (
            <tr key={g.key}>
              <td>{g.label}</td><td className="num">{g.visits}</td>{!compact && <td className="num">{g.completed}</td>}
              <td className="num">{g.missingCheckout || ''}</td>{!compact && <td className="num">{minutes(g.totalMinutes)}</td>}<td className="num">{minutes(g.averageMinutes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
