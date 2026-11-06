import { useId, useMemo, useState } from 'react';
import type { Employee } from '../lib/types';
import { Button, Field } from './ui';

/** Large-touch employee search with a free-text fallback for hosts not in the directory. */
export function EmployeePicker({
  employees, value, freeText, onChange, label, error, required, allowFreeText = true,
}: {
  employees: Employee[];
  value: string;
  freeText: string;
  onChange: (v: { employeeId: string; freeText: string }) => void;
  label: string;
  error?: string;
  required?: boolean;
  allowFreeText?: boolean;
}) {
  const id = useId();
  const [q, setQ] = useState('');
  const [manual, setManual] = useState(!!freeText && !value);
  const selected = employees.find((e) => e.id === value);
  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    const list = t ? employees.filter((e) => `${e.fullName} ${e.departmentName ?? ''} ${e.jobTitle ?? ''}`.toLowerCase().includes(t)) : employees;
    return list.slice(0, 40);
  }, [q, employees]);

  if (manual) {
    return (
      <Field label={`${label} (not in directory)`} error={error} required={required} htmlFor={id}>
        <input id={id} value={freeText} onChange={(e) => onChange({ employeeId: '', freeText: e.target.value })} placeholder="Type the person's name" aria-invalid={!!error} />
        <Button type="button" variant="ghost" size="sm" onClick={() => { setManual(false); onChange({ employeeId: '', freeText: '' }); }}>← Choose from directory</Button>
      </Field>
    );
  }
  if (selected) {
    return (
      <Field label={label} error={error} required={required}>
        <div className="selected-chip">
          <div><strong>{selected.fullName}</strong><div className="muted small">{[selected.jobTitle, selected.departmentName].filter(Boolean).join(' · ')}</div></div>
          <Button type="button" size="sm" onClick={() => onChange({ employeeId: '', freeText: '' })}>Change</Button>
        </div>
      </Field>
    );
  }
  return (
    <Field label={label} error={error} required={required} htmlFor={id}>
      <input id={id} className="search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search employee name or department" aria-invalid={!!error} autoComplete="off" />
      <div className="picker-list" role="listbox" aria-label="Employees">
        {matches.map((e) => (
          <button type="button" role="option" aria-selected={false} key={e.id} onClick={() => onChange({ employeeId: e.id, freeText: '' })}>
            <span>{e.fullName}</span>
            <span className="muted small">{e.departmentName ?? ''}</span>
          </button>
        ))}
        {matches.length === 0 && <div className="empty small">No matching employees</div>}
      </div>
      {allowFreeText && <Button type="button" variant="ghost" size="sm" onClick={() => setManual(true)}>Person not listed? Type a name</Button>}
    </Field>
  );
}
