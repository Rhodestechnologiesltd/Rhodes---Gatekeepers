import { useState } from 'react';
import { api, ApiError, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, dateTime, groupRef, ID_STATUS_LABEL, minutes, time, todayLocal, visitorId, VISIT_TYPE_LABEL, VISIT_TYPE_LONG } from '../lib/format';
import { Link } from 'react-router-dom';
import type { Department, Employee, Visit } from '../lib/types';
import { Alert, Badge, Button, Card, Empty, Modal, Select, Spinner, TextInput, useAsync, useToast } from '../components/ui';

const PAGE = 50;

export function VisitsPage() {
  const [filters, setFilters] = useState({ from: todayLocal(-30), to: todayLocal(), visitType: '', status: '', q: '' });
  const [applied, setApplied] = useState(filters);
  const [offset, setOffset] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useAsync(() => api<{ items: Visit[]; total: number }>(`/visits${qs({ ...applied, limit: PAGE, offset })}`), [applied, offset]);
  const setF = (k: keyof typeof filters) => (v: string) => setFilters((f) => ({ ...f, [k]: v }));

  return (
    <div className="stack">
      <div className="page-head"><div><h1>Visits</h1><p>Search, review and correct visitor records.</p></div></div>
      <Card>
        <form className="filters" onSubmit={(e) => { e.preventDefault(); setOffset(0); setApplied(filters); }}>
          <div className="field grow"><label htmlFor="vq">Search</label><input id="vq" className="search" type="search" value={filters.q} onChange={(e) => setF('q')(e.target.value)} placeholder="Name, company, courier, pass or Visitor ID" /></div>
          <TextInput label="From" type="date" value={filters.from} onChange={setF('from')} />
          <TextInput label="To" type="date" value={filters.to} onChange={setF('to')} />
          <Select label="Type" value={filters.visitType} onChange={setF('visitType')} placeholder="All types" options={Object.entries(VISIT_TYPE_LABEL).map(([value, label]) => ({ value, label }))} />
          <Select label="Status" value={filters.status} onChange={setF('status')} placeholder="Any status" options={[{ value: 'on_site', label: 'On site' }, { value: 'checked_out', label: 'Checked out' }]} />
          <Button variant="brand" type="submit">Search</Button>
        </form>
      </Card>
      <Card>
        {list.error && <Alert tone="error">{list.error.message}</Alert>}
        {list.loading && !list.data ? <Spinner /> : !list.data?.items.length ? <Empty title="No visits found">Try a wider date range.</Empty> : (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Visitor ID</th><th>Date</th><th>Visitor</th><th>Type</th><th>Host / vehicle</th><th>In</th><th>Out</th><th className="num">Duration</th><th>ID</th></tr></thead>
                <tbody>
                  {list.data.items.map((v) => (
                    <tr key={v.id} className="clickable" onClick={() => setOpenId(v.id)} onKeyDown={(e) => e.key === 'Enter' && setOpenId(v.id)} tabIndex={0}>
                      <td className="mono">{visitorId(v.referenceNo)}{v.group && <div className="muted small">{groupRef(v.group.groupNo)}</div>}</td>
                      <td className="nowrap">{date(v.checkedInAt)}</td>
                      <td><strong>{v.visitor.fullName}</strong>{(v.visitor.company || v.deliveryCompany) && <div className="muted small">{v.visitor.company ?? v.deliveryCompany}</div>}</td>
                      <td>{VISIT_TYPE_LABEL[v.visitType]}</td>
                      <td>{v.visitType === 'delivery' && v.vehiclePlate ? <span className="plate sm">{v.vehiclePlate}</span> : v.host?.name ?? v.department?.name ?? '—'}</td>
                      <td className="nowrap">{time(v.checkedInAt)}</td>
                      <td className="nowrap">{v.status === 'on_site' ? <Badge tone="red">On site</Badge> : <>{time(v.checkedOutAt)}{v.checkoutMethod === 'manual_correction' && <> <Badge>corrected</Badge></>}</>}</td>
                      <td className="num">{minutes(v.durationMinutes)}</td>
                      <td><Badge tone={v.idStatus === 'verified' ? 'green' : v.idStatus === 'scanned' ? 'teal' : v.idStatus === 'manual' ? 'amber' : 'neutral'}>{ID_STATUS_LABEL[v.idStatus]}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pager">
              <span className="muted">{offset + 1}–{offset + list.data.items.length} of {list.data.total}</span>
              <div className="row">
                <Button size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</Button>
                <Button size="sm" disabled={offset + PAGE >= list.data.total} onClick={() => setOffset(offset + PAGE)}>Next</Button>
              </div>
            </div>
          </>
        )}
      </Card>
      {openId && <VisitDetail id={openId} onClose={() => setOpenId(null)} onChanged={() => void list.reload()} />}
    </div>
  );
}

interface NotificationRow { id: string; event: string; recipients: string[]; status: string; attempts: number; lastError: string | null; createdAt: string; sentAt: string | null; provider: string }

function VisitDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const v = useAsync(() => api<Visit>(`/visits/${id}`), [id]);
  const notes = useAsync(() => api<NotificationRow[]>(`/visits/${id}/notifications`), [id]);
  const [mode, setMode] = useState<'view' | 'edit' | 'checkout' | 'reveal'>('view');

  return (
    <Modal title={v.data ? `Visitor ${visitorId(v.data.referenceNo)}${v.data.group ? ` · group ${groupRef(v.data.group.groupNo)}` : ''}` : 'Visit'} onClose={onClose} wide>
      {v.loading && !v.data ? <Spinner /> : v.error ? <Alert tone="error">{v.error.message}</Alert> : (() => {
        const x = v.data!;
        if (mode === 'edit') return <EditVisit visit={x} onCancel={() => setMode('view')} onSaved={(nv) => { v.setData(nv); setMode('view'); onChanged(); toast('Visit updated'); }} />;
        if (mode === 'checkout') return <ManualCheckout visit={x} onCancel={() => setMode('view')} onSaved={(nv) => { v.setData(nv); setMode('view'); onChanged(); toast('Check-out recorded'); }} />;
        if (mode === 'reveal') return <RevealId visitId={x.id} onDone={() => setMode('view')} />;
        return (
          <div className="stack">
            {x.visitor.purged && <Alert tone="info">Personal data for this visit was anonymised under the retention policy.</Alert>}
            <div className="row">
              {can('visit.edit') && !x.visitor.purged && <Button onClick={() => setMode('edit')}>Edit details</Button>}
              {can('visit.manual_checkout') && x.status === 'on_site' && <Button variant="danger" onClick={() => setMode('checkout')}>Record missed check-out</Button>}
              {can('visitor.view_sensitive') && x.visitor.hasStoredFullId && <Button variant="ghost" onClick={() => setMode('reveal')}>View full ID number</Button>}
              {x.group && can('files.view') && <Link className="btn btn-brand" to={`/folders/${x.group.id}`}>Open folder</Link>}
            </div>
            <div className="grid grid-2">
              <div>
                <h3 className="section-title">Visitor</h3>
                <dl className="details" style={{ marginTop: 12 }}>
                  <dt>Name</dt><dd>{x.visitor.fullName}</dd>
                  <dt>Company</dt><dd>{x.visitor.company ?? '—'}</dd>
                  <dt>Mobile</dt><dd>{x.visitor.phone ?? '—'}</dd>
                  <dt>Nationality</dt><dd>{x.visitor.nationality ?? '—'}</dd>
                  <dt>ID</dt><dd><span className="mono">{x.visitor.idNumberMasked ?? '—'}</span> <Badge tone={x.idStatus === 'scanned' ? 'teal' : 'neutral'}>{ID_STATUS_LABEL[x.idStatus]}</Badge></dd>
                  <dt>ID expiry</dt><dd>{x.visitor.idExpiryDate ?? '—'}</dd>
                  <dt>Privacy notice</dt><dd>{x.privacyNoticeAck ? 'Acknowledged' : 'Not recorded'}</dd>
                </dl>
              </div>
              <div>
                <h3 className="section-title">Visit</h3>
                <dl className="details" style={{ marginTop: 12 }}>
                  <dt>Type</dt><dd>{VISIT_TYPE_LONG[x.visitType]}</dd>
                  <dt>{x.visitType === 'delivery' ? 'Receiving' : 'Host'}</dt><dd>{x.host?.name ?? '—'}</dd>
                  <dt>Department</dt><dd>{x.department?.name ?? '—'}</dd>
                  {x.deliveryCompany && <><dt>Delivery company</dt><dd>{x.deliveryCompany}</dd></>}
                  <dt>Purpose</dt><dd>{x.purpose ?? '—'}</dd>
                  {x.salesReference && <><dt>Sales / order ref</dt><dd>{x.salesReference}</dd></>}
                  <dt>Pass / vehicle</dt><dd>{x.badgeNumber ?? '—'} / {x.vehiclePlate ?? '—'}</dd>
                  {x.group && <><dt>Role in group</dt><dd>{x.group.role} · {groupRef(x.group.groupNo)}</dd></>}
                  {x.group?.poNumber && <><dt>PO / invoice</dt><dd className="mono">{[x.group.poNumber, x.group.invoiceNumber].filter(Boolean).join(' / ')}</dd></>}
                  {x.notes && <><dt>Notes</dt><dd>{x.notes}</dd></>}
                </dl>
              </div>
            </div>
            <div>
              <h3 className="section-title">Times</h3>
              <dl className="details" style={{ marginTop: 12 }}>
                <dt>Checked in</dt><dd>{dateTime(x.checkedInAt)} by {x.checkedInBy ?? '—'}</dd>
                <dt>Checked out</dt><dd>{x.checkedOutAt ? <>{dateTime(x.checkedOutAt)} by {x.checkedOutBy ?? '—'} {x.checkoutMethod === 'manual_correction' && <Badge tone="amber">Corrected by staff</Badge>}</> : <Badge tone="red">Still on site</Badge>}</dd>
                {x.checkoutNote && <><dt>Check-out note</dt><dd>{x.checkoutNote}</dd></>}
                <dt>Gate duration</dt><dd>{minutes(x.durationMinutes)}</dd>
              </dl>
            </div>
            <div>
              <h3 className="section-title">Notifications</h3>
              {notes.data?.length ? (
                <table className="data" style={{ marginTop: 8 }}>
                  <thead><tr><th>Event</th><th>Recipients</th><th>Status</th><th>When</th></tr></thead>
                  <tbody>{notes.data.map((n) => (
                    <tr key={n.id}><td>{n.event === 'visit.checked_in' ? 'Arrival' : 'Departure'}</td><td className="small">{n.recipients.join(', ') || '—'}</td>
                      <td><Badge tone={n.status === 'sent' ? 'green' : n.status === 'failed' ? 'red' : n.status === 'pending' ? 'amber' : 'neutral'}>{n.status}{n.provider === 'devlog' && n.status === 'sent' ? ' (dev log)' : ''}</Badge>{n.lastError && <div className="muted small">{n.lastError}</div>}</td>
                      <td className="small nowrap">{dateTime(n.sentAt ?? n.createdAt)}</td></tr>
                  ))}</tbody>
                </table>
              ) : <p className="muted small">No notifications were generated.</p>}
            </div>
          </div>
        );
      })()}
    </Modal>
  );
}

function EditVisit({ visit, onCancel, onSaved }: { visit: Visit; onCancel: () => void; onSaved: (v: Visit) => void }) {
  const employees = useAsync(() => api<Employee[]>('/directory/employees'), []);
  const departments = useAsync(() => api<Department[]>('/directory/departments'), []);
  const [f, setF] = useState({
    fullName: visit.visitor.fullName, company: visit.visitor.company ?? '', phone: visit.visitor.phone ?? '',
    hostEmployeeId: visit.host?.employeeId ?? '', hostName: visit.host?.employeeId ? '' : visit.host?.name ?? '',
    departmentId: visit.department?.id ?? '', purpose: visit.purpose ?? '', deliveryCompany: visit.deliveryCompany ?? '',
    salesReference: visit.salesReference ?? '', badgeNumber: visit.badgeNumber ?? '', vehiclePlate: visit.vehiclePlate ?? '', notes: visit.notes ?? '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const s = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));
  const save = async () => {
    setBusy(true); setErr(''); setErrors({});
    try {
      const { fullName, company, phone, ...rest } = f;
      onSaved(await api<Visit>(`/visits/${visit.id}`, { method: 'PATCH', body: { visitor: { fullName, company, phone }, ...rest, hostName: rest.hostEmployeeId ? '' : rest.hostName } }));
    } catch (e) { setErr((e as ApiError).message); setErrors((e as ApiError).fields); } finally { setBusy(false); }
  };
  return (
    <div className="stack">
      {err && <Alert tone="error">{err}</Alert>}
      <div className="form-grid">
        <TextInput label="Visitor name" value={f.fullName} onChange={s('fullName')} error={errors['visitor.fullName']} required />
        <TextInput label="Company" value={f.company} onChange={s('company')} />
        <TextInput label="Mobile" value={f.phone} onChange={s('phone')} />
        <Select label="Host employee" value={f.hostEmployeeId} onChange={s('hostEmployeeId')} placeholder="— none / free text —" options={(employees.data ?? []).map((e) => ({ value: e.id, label: e.fullName }))} />
        {!f.hostEmployeeId && <TextInput label="Host name (free text)" value={f.hostName} onChange={s('hostName')} />}
        <Select label="Department" value={f.departmentId} onChange={s('departmentId')} placeholder="— from host —" options={(departments.data ?? []).map((d) => ({ value: d.id, label: d.name }))} />
        <TextInput label="Purpose" value={f.purpose} onChange={s('purpose')} />
        {visit.visitType === 'delivery' && <TextInput label="Delivery company" value={f.deliveryCompany} onChange={s('deliveryCompany')} />}
        <TextInput label="Sales / order ref" value={f.salesReference} onChange={s('salesReference')} />
        <TextInput label="Badge" value={f.badgeNumber} onChange={s('badgeNumber')} />
        <TextInput label="Vehicle plate" value={f.vehiclePlate} onChange={s('vehiclePlate')} />
        <div className="span-2"><TextInput label="Notes" value={f.notes} onChange={s('notes')} /></div>
      </div>
      <p className="note">ID details cannot be edited after check-in. Changes are recorded in the audit log.</p>
      <div className="row"><Button variant="primary" busy={busy} onClick={() => void save()}>Save changes</Button><Button onClick={onCancel}>Cancel</Button></div>
    </div>
  );
}

function toLocalInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function ManualCheckout({ visit, onCancel, onSaved }: { visit: Visit; onCancel: () => void; onSaved: (v: Visit) => void }) {
  const [when, setWhen] = useState(toLocalInput(new Date()));
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setErr('');
    try {
      onSaved(await api<Visit>(`/visits/${visit.id}/manual-check-out`, { body: { checkedOutAt: new Date(when).toISOString(), reason } }));
    } catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
  };
  return (
    <div className="stack">
      <Alert tone="warn" title="Correcting a missed check-out">The visit will be marked “corrected by staff” in reports, with your name and the reason.</Alert>
      <p className="muted small" style={{ margin: 0 }}>Checked in {dateTime(visit.checkedInAt)}. Time below is in this device's local time.</p>
      <TextInput label="Actual departure time" type="datetime-local" value={when} onChange={setWhen} required />
      <TextInput label="Reason" value={reason} onChange={setReason} placeholder="e.g. Left with host via loading bay; confirmed by phone" required />
      {err && <Alert tone="error">{err}</Alert>}
      <div className="row"><Button variant="primary" busy={busy} disabled={reason.trim().length < 3} onClick={() => void save()}>Record check-out</Button><Button onClick={onCancel}>Cancel</Button></div>
    </div>
  );
}

function RevealId({ visitId, onDone }: { visitId: string; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [value, setValue] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const reveal = async () => {
    try { setValue((await api<{ idNumber: string }>(`/visits/${visitId}/reveal-id`, { body: { reason } })).idNumber); } catch (e) { setErr((e as ApiError).message); }
  };
  return (
    <div className="stack">
      <Alert tone="warn">Viewing a full ID number is recorded in the audit log with your name and reason.</Alert>
      {value ? <div className="ref-big mono" style={{ fontSize: '1.6rem' }}>{value}</div> : <TextInput label="Reason for access" value={reason} onChange={setReason} required />}
      {err && <Alert tone="error">{err}</Alert>}
      <div className="row">{!value && <Button variant="primary" disabled={reason.trim().length < 3} onClick={() => void reveal()}>Show ID number</Button>}<Button onClick={onDone}>{value ? 'Hide' : 'Cancel'}</Button></div>
    </div>
  );
}
