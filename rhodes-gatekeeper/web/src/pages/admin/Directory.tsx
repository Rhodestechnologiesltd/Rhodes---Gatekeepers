import { useState } from 'react';
import { api, ApiError, qs } from '../../lib/api';
import type { Department, Employee } from '../../lib/types';
import { Alert, Badge, Button, Card, Empty, Modal, Select, Spinner, TextInput, Toggle, useAsync, useToast } from '../../components/ui';

export function DirectoryPage() {
  const [tab, setTab] = useState<'employees' | 'departments'>('employees');
  return (
    <div className="stack">
      <div className="page-head"><div><h1>Employees & departments</h1><p>Hosts that guards can select, and where notification emails go.</p></div></div>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'employees'} onClick={() => setTab('employees')}>Employees</button>
        <button role="tab" aria-selected={tab === 'departments'} onClick={() => setTab('departments')}>Departments</button>
      </div>
      {tab === 'employees' ? <Employees /> : <Departments />}
    </div>
  );
}

function Employees() {
  const [q, setQ] = useState('');
  const list = useAsync(() => api<Employee[]>(`/admin/employees${qs({ q })}`), [q]);
  const deps = useAsync(() => api<Department[]>('/admin/departments'), []);
  const [editing, setEditing] = useState<Employee | 'new' | null>(null);
  return (
    <Card actions={<Button variant="primary" onClick={() => setEditing('new')}>Add employee</Button>} title={<input className="search" type="search" placeholder="Search employees" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search employees" style={{ maxWidth: 320 }} />}>
      {list.loading && !list.data ? <Spinner /> : !list.data?.length ? <Empty title="No employees yet">Add the people visitors come to see. Without an email address, the host cannot be notified.</Empty> : (
        <div className="table-wrap"><table className="data">
          <thead><tr><th>Name</th><th>Department</th><th>Email (notifications)</th><th>Status</th><th /></tr></thead>
          <tbody>{list.data.map((e) => (
            <tr key={e.id}>
              <td><strong>{e.fullName}</strong>{e.jobTitle && <div className="muted small">{e.jobTitle}</div>}</td>
              <td>{e.departmentName ?? '—'}</td>
              <td>{e.email ?? <Badge tone="amber">No email</Badge>}</td>
              <td>{e.active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}</td>
              <td className="right"><Button size="sm" onClick={() => setEditing(e)}>Edit</Button></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {editing && <EmployeeForm employee={editing === 'new' ? null : editing} departments={deps.data ?? []} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void list.reload(); }} />}
    </Card>
  );
}

function EmployeeForm({ employee, departments, onClose, onSaved }: { employee: Employee | null; departments: Department[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ fullName: employee?.fullName ?? '', email: employee?.email ?? '', phone: employee?.phone ?? '', jobTitle: employee?.jobTitle ?? '', departmentId: employee?.departmentId ?? '', active: employee?.active ?? true });
  const [err, setErr] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setErr('');
    try {
      await api(employee ? `/admin/employees/${employee.id}` : '/admin/employees', { method: employee ? 'PATCH' : 'POST', body: f });
      toast('Employee saved');
      onSaved();
    } catch (e) { setErr((e as ApiError).message); setFields((e as ApiError).fields); } finally { setBusy(false); }
  };
  return (
    <Modal title={employee ? 'Edit employee' : 'Add employee'} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={() => void save()}>Save</Button></>}>
      <div className="stack">
        {err && <Alert tone="error">{err}</Alert>}
        <TextInput label="Full name" value={f.fullName} onChange={(v) => setF({ ...f, fullName: v })} error={fields.fullName} required />
        <TextInput label="Work email" type="email" value={f.email} onChange={(v) => setF({ ...f, email: v })} error={fields.email} hint="Used to notify this person when they have a visitor." />
        <div className="form-grid">
          <TextInput label="Job title" value={f.jobTitle} onChange={(v) => setF({ ...f, jobTitle: v })} />
          <TextInput label="Phone" value={f.phone} onChange={(v) => setF({ ...f, phone: v })} />
        </div>
        <Select label="Department" value={f.departmentId} onChange={(v) => setF({ ...f, departmentId: v })} placeholder="— none —" options={departments.filter((d) => d.active || d.id === f.departmentId).map((d) => ({ value: d.id, label: d.name }))} />
        <Toggle label="Active (selectable at the gate)" checked={f.active} onChange={(v) => setF({ ...f, active: v })} />
      </div>
    </Modal>
  );
}

function Departments() {
  const list = useAsync(() => api<Department[]>('/admin/departments'), []);
  const [editing, setEditing] = useState<Department | 'new' | null>(null);
  return (
    <Card actions={<Button variant="primary" onClick={() => setEditing('new')}>Add department</Button>}>
      {list.loading && !list.data ? <Spinner /> : !list.data?.length ? <Empty title="No departments yet" /> : (
        <div className="table-wrap"><table className="data">
          <thead><tr><th>Department</th><th>Notification email / distribution list</th><th>Status</th><th /></tr></thead>
          <tbody>{list.data.map((d) => (
            <tr key={d.id}><td><strong>{d.name}</strong></td><td>{d.notificationEmail ?? '—'}</td><td>{d.active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}</td><td className="right"><Button size="sm" onClick={() => setEditing(d)}>Edit</Button></td></tr>
          ))}</tbody>
        </table></div>
      )}
      {editing && <DepartmentForm dep={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void list.reload(); }} />}
    </Card>
  );
}

function DepartmentForm({ dep, onClose, onSaved }: { dep: Department | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: dep?.name ?? '', notificationEmail: dep?.notificationEmail ?? '', active: dep?.active ?? true });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setErr('');
    try { await api(dep ? `/admin/departments/${dep.id}` : '/admin/departments', { method: dep ? 'PATCH' : 'POST', body: f }); onSaved(); }
    catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
  };
  return (
    <Modal title={dep ? 'Edit department' : 'Add department'} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={() => void save()}>Save</Button></>}>
      <div className="stack">
        {err && <Alert tone="error">{err}</Alert>}
        <TextInput label="Name" value={f.name} onChange={(v) => setF({ ...f, name: v })} required />
        <TextInput label="Notification email (optional)" type="email" value={f.notificationEmail} onChange={(v) => setF({ ...f, notificationEmail: v })} hint="Used when a notification rule is set to notify the department (e.g. deliveries)." />
        <Toggle label="Active" checked={f.active} onChange={(v) => setF({ ...f, active: v })} />
      </div>
    </Modal>
  );
}
