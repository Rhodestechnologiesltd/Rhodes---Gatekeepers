import { useEffect, useState } from 'react';
import { HashRouter, NavLink, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { Button, Spinner, ToastProvider } from '../components/ui';
import { MobileSessionProvider, useSession } from './session';
import { EnrollPage, MobileLoginPage } from './pages/Setup';
import { GateHome } from './pages/GateHome';
import { GroupCheckIn } from './pages/GroupCheckIn';
import { OnSitePage } from './pages/OnSite';
import { processQueue, subscribeUploads } from './uploads';

function UploadBadge() {
  const [s, setS] = useState({ pending: 0, failed: 0 });
  useEffect(() => subscribeUploads((x) => setS({ pending: x.pending, failed: x.failed })), []);
  if (!s.pending) return null;
  return (
    <button type="button" className={`upload-badge ${s.failed ? 'warn' : ''}`} onClick={() => void processQueue()} title="Photos waiting to upload — tap to retry">
      <span className="spinner" aria-hidden /> {s.pending} photo{s.pending > 1 ? 's' : ''} uploading
    </button>
  );
}

function MobileLayout() {
  const { me, device, logout } = useSession();
  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <NavLink to="/" className="brand" aria-label="Home">
            <img src="/brand/rhodes-logo-white.png" alt="Rhodes Technologies Ltd" />
            <span className="brand-divider" aria-hidden />
            <span className="brand-product">Gatekeeper<small>{device?.deviceName ?? me?.app.siteName}</small></span>
          </NavLink>
          <nav className="nav" aria-label="Main">
            <NavLink to="/" end>Gate</NavLink>
            <NavLink to="/check-in">Check in</NavLink>
            <NavLink to="/on-site">On site</NavLink>
          </nav>
          <div className="user-menu">
            <UploadBadge />
            <div className="user-chip">{me?.user.displayName}<small>Security</small></div>
            <Button variant="ghost" size="sm" onClick={() => void logout()}>Sign out</Button>
          </div>
        </div>
      </header>
      <main className="page" id="main"><Outlet /></main>
    </>
  );
}

function Routed() {
  const { stage } = useSession();
  if (stage === 'loading') return <Spinner />;
  if (stage === 'enroll') return <EnrollPage />;
  if (stage === 'login') return <MobileLoginPage />;
  return (
    <Routes>
      <Route element={<MobileLayout />}>
        <Route index element={<GateHome />} />
        <Route path="check-in" element={<GroupCheckIn />} />
        <Route path="on-site" element={<OnSitePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

/** The gate tablet app (Android / iOS via Capacitor). Hash routing works from the app's local files. */
export function MobileApp() {
  return (
    <HashRouter>
      <MobileSessionProvider>
        <ToastProvider>
          <Routed />
        </ToastProvider>
      </MobileSessionProvider>
    </HashRouter>
  );
}
