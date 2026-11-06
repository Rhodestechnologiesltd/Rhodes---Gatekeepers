import { useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateTime } from '../../lib/format';
import type { Role } from '../../lib/types';
import { Alert, Badge, Button, Card, Modal, Select, Spinner, TextInput, Toggle, useAsync, useToast } from '../../components/ui';

interface User { id: string; username: string; displayName: string; email: string | null; role: Role; active: boolean; mustChangePassword: boolean; lockedUntil: string | null; lastLoginAt: string | null }

const ROLE_OPTIONS = [
  { value: 'guard', label: 'Security guard — gate tablet app only' },
  { value: 'reception', label: 'Reception — records, reports, search, documents' },
  { value: 'manager', label: 'Manager — reception + ID card images, folder downloads, audit log' },
  { value: 'admin', label: 'Administrator — users, settings, everything' },
];

export function UsersPage() {
  const users = useAsync(() => api<User[]>('/admin/users'), []);
  const [editing, setEditing] = useState<User | 'new' | null>(null);
  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>Users</h1><p>Accounts for guards, reception staff and administrators.</p></div>
        <Button variant="primary" onClick={() => setEditing('new')}>Add user</Button>
      </div>
      <Card>
        {users.loading && !users.data ? <Spinner /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th>Last sign-in</th><th /></tr></thead>
            <tbody>{(users.data ?? []).map((u) => (
              <tr key={u.id}>
                <td><strong>{u.displayName}</strong>{u.email && <div className="muted small">{u.email}</div>}</td>
                <td className="mono">{u.username}</td>
                <td><Badge tone={u.role === 'admin' ? 'red' : u.role === 'reception' || u.role === 'manager' ? 'teal' : 'neutral'}>{u.role}</Badge></td>
                <td>{u.active ? <Badge tone="green">Active</Badge> : <Badge>Disabled</Badge>} {u.lockedUntil && Date.parse(u.lockedUntil) > Date.now() && <Badge tone="amber">Locked</Badge>} {u.mustChangePassword && <Badge tone="amber">Must change password</Badge>}</td>
                <td className="small nowrap">{dateTime(u.lastLoginAt)}</td>
                <td className="right"><Button size="sm" onClick={() => setEditing(u)}>Edit</Button></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      {editing && <UserForm user={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void users.reload(); }} />}
    </div>
  );
}

function UserForm({ user, onClose, onSaved }: { user: User | null; onClose: () => void; onSaved: () => void }) {
  const { me } = useAuth();
  const toast = useToast();
  const [f, setF] = useState({ username: user?.username ?? '', displayName: user?.displayName ?? '', email: user?.email ?? '', role: user?.role ?? 'guard', active: user?.active ?? true, password: '' });
  const [err, setErr] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const isSelf = user?.id === me?.user.id;

  const save = async () => {
    setBusy(true); setErr(''); setFields({});
    try {
      if (user) {
        const body: Record<string, unknown> = { displayName: f.displayName, email: f.email, role: f.role, active: f.active };
        if (f.password) body.password = f.password;
        await api(`/admin/users/${user.id}`, { method: 'PATCH', body });
      } else {
        await api('/admin/users', { body: { username: f.username, displayName: f.displayName, email: f.email, role: f.role, password: f.password } });
      }
      toast(user ? 'User updated' : 'User created — they will be asked to change the password at first sign-in');
      onSaved();
    } catch (e) { setErr((e as ApiError).message); setFields((e as ApiError).fields); } finally { setBusy(false); }
  };

  return (
    <Modal title={user ? `Edit ${user.displayName}` : 'Add user'} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={() => void save()}>Save</Button></>}>
      <div className="stack">
        {err && <Alert tone="error">{err}</Alert>}
        <TextInput label="Username" value={f.username} onChange={(v) => setF({ ...f, username: v.toLowerCase() })} readOnly={!!user} error={fields.username} required autoCapitalize="none" />
        <TextInput label="Display name" value={f.displayName} onChange={(v) => setF({ ...f, displayName: v })} error={fields.displayName} required />
        <TextInput label="Email (optional)" type="email" value={f.email} onChange={(v) => setF({ ...f, email: v })} error={fields.email} />
        <Select label="Role" value={f.role} onChange={(v) => setF({ ...f, role: v as Role })} options={ROLE_OPTIONS} hint={isSelf ? 'You cannot change your own role.' : undefined} />
        {user && !isSelf && <Toggle label="Account active" checked={f.active} onChange={(v) => setF({ ...f, active: v })} hint="Disabling signs the user out everywhere." />}
        <TextInput label={user ? 'Reset password (leave blank to keep)' : 'Temporary password'} type="password" value={f.password} onChange={(v) => setF({ ...f, password: v })} error={fields.password} autoComplete="new-password" hint="At least 10 characters with letters and numbers. The user must change it at next sign-in." required={!user} />
      </div>
    </Modal>
  );
}
