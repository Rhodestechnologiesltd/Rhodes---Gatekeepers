import { useState, type FormEvent } from 'react';
import type { ApiError } from '../../lib/api';
import { Alert, Button, TextInput } from '../../components/ui';
import { DEFAULT_SERVER_URL, useSession } from '../session';

function Shell({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div className="m-setup">
      <header className="m-setup-head">
        <img src="/brand/rhodes-logo-white.png" alt="Rhodes Technologies Ltd" />
        <div className="m-setup-product">Gatekeeper <span>· Gate tablet</span></div>
      </header>
      <main className="m-setup-body">
        <div className="m-setup-card">
          <h1>{title}</h1>
          <p className="muted" style={{ margin: '4px 0 18px' }}>{sub}</p>
          {children}
        </div>
      </main>
    </div>
  );
}

/** First launch: connect this tablet to the Gatekeeper server with a one-time code from an administrator. */
export function EnrollPage() {
  const { enroll } = useSession();
  const [server, setServer] = useState(DEFAULT_SERVER_URL);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await enroll(server, code);
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell title="Set up this tablet" sub="An administrator creates an enrolment code in the web app under Tablets.">
      <form className="stack" onSubmit={submit} noValidate>
        {error && <Alert tone="error">{error}</Alert>}
        <TextInput label="Server address" value={server} onChange={setServer} placeholder="https://gatekeeper.company.com" inputMode="url" autoCapitalize="none" autoCorrect="off" required />
        <TextInput label="Enrolment code" value={code} onChange={(v) => setCode(v.toUpperCase())} placeholder="ABCD-EFGH" autoCapitalize="characters" autoCorrect="off" required style={{ letterSpacing: '0.2em', fontSize: '1.3rem' }} />
        <Button variant="primary" size="lg" type="submit" busy={busy} disabled={!server || code.replace(/[^A-Z0-9]/g, '').length < 8}>Connect tablet</Button>
      </form>
    </Shell>
  );
}

export function MobileLoginPage() {
  const { login, device, forgetDevice } = useSession();
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
      const ae = err as ApiError;
      setError(ae.message);
      setPassword('');
      if (ae.code === 'DEVICE_NOT_ENROLLED') window.setTimeout(() => void forgetDevice(), 2500);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell title="Security sign-in" sub={device ? `${device.deviceName}` : ''}>
      <form className="stack" onSubmit={submit} noValidate>
        {error && <Alert tone="error">{error}</Alert>}
        <TextInput label="Username" value={username} onChange={setUsername} autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} required />
        <TextInput label="Password" type="password" value={password} onChange={setPassword} autoComplete="current-password" required />
        <Button variant="primary" size="lg" type="submit" busy={busy} disabled={!username || !password}>Sign in</Button>
        <p className="muted small" style={{ textAlign: 'center' }}>Connected to {device?.serverUrl.replace(/^https?:\/\//, '')}</p>
      </form>
    </Shell>
  );
}
