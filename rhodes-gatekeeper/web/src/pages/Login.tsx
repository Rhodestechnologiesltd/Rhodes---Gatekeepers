import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, Button, Card, TextInput, useToast } from '../components/ui';

export function LoginPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(username, password);
    } catch (err) {
      setError((err as ApiError).message);
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <aside className="login-side">
        <img src="/brand/rhodes-logo-white.png" alt="Rhodes Technologies Ltd — Securing your business" />
        <div>
          <h1>Rhodes Gatekeeper<span /></h1>
          <p>Register every arrival, notify the right people and know who is on site — from the gate tablet to the reception dashboard.</p>
        </div>
        <p className="small" style={{ opacity: 0.6 }}>Authorised personnel only. Activity is logged.</p>
      </aside>
      <div className="login-form">
        <form onSubmit={submit} noValidate>
          <img className="login-mobile-logo" src="/brand/rhodes-logo.png" alt="Rhodes Technologies Ltd" />
          <div>
            <h1>Sign in</h1>
            <p className="muted" style={{ margin: '4px 0 0' }}>Use the account issued by your administrator.</p>
          </div>
          {error && <Alert tone="error">{error}</Alert>}
          <TextInput label="Username" value={username} onChange={setUsername} autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} required />
          <TextInput label="Password" type="password" value={password} onChange={setPassword} autoComplete="current-password" required />
          <Button variant="primary" size="lg" type="submit" busy={busy} disabled={!username || !password}>Sign in</Button>
        </form>
      </div>
    </div>
  );
}

export function ChangePasswordPage({ forced }: { forced?: boolean }) {
  const { refresh, logout } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) return setError('The new passwords do not match');
    setBusy(true);
    setError('');
    try {
      await api('/auth/change-password', { body: { currentPassword: current, newPassword: next } });
      toast('Password changed');
      await refresh();
      if (!forced) nav('/');
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  const form = (
    <form onSubmit={submit} className="stack" style={{ maxWidth: 440 }}>
      {forced && <Alert tone="info" title="Set a new password">Your password was set by an administrator. Choose your own password to continue.</Alert>}
      {error && <Alert tone="error">{error}</Alert>}
      <TextInput label="Current password" type="password" value={current} onChange={setCurrent} autoComplete="current-password" required />
      <TextInput label="New password" type="password" value={next} onChange={setNext} autoComplete="new-password" hint="At least 10 characters, with letters and numbers." required />
      <TextInput label="Confirm new password" type="password" value={confirm} onChange={setConfirm} autoComplete="new-password" required />
      <div className="row">
        <Button variant="primary" type="submit" busy={busy}>Change password</Button>
        {forced && <Button type="button" variant="ghost" onClick={() => void logout()}>Sign out</Button>}
      </div>
    </form>
  );
  if (!forced) return <Card title="Change password">{form}</Card>;
  return (
    <div className="login-form" style={{ minHeight: '100vh' }}>
      <div className="stack" style={{ width: 'min(440px, 100%)' }}>
        <img src="/brand/rhodes-logo.png" alt="Rhodes Technologies Ltd" style={{ width: 240 }} />
        {form}
      </div>
    </div>
  );
}
