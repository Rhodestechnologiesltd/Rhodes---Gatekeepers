import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { IconSearch } from './icons';
import { useAuth } from '../lib/auth';
import { Button } from './ui';

export function Layout() {
  const { me, can, logout } = useAuth();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  if (!me) return null;
  const links: [string, string, boolean][] = [
    ['/dashboard', 'Dashboard', can('report.view')],
    ['/visits', 'Visits', can('visit.view_all')],
    ['/folders', 'Folders', can('files.view')],
    ['/reports', 'Reports', can('report.view')],
    ['/admin/users', 'Users', can('user.manage')],
    ['/admin/directory', 'Employees', can('directory.manage')],
    ['/admin/devices', 'Tablets', can('device.manage')],
    ['/admin/settings', 'Settings', can('settings.manage')],
    ['/admin/audit', 'Audit', can('audit.view')],
  ];
  return (
    <>
      <a href="#main" className="sr-only">Skip to content</a>
      <header className="topbar">
        <div className="topbar-inner web-header">
          <NavLink to="/" className="brand" aria-label="Rhodes Gatekeeper home">
            <img src="/brand/rhodes-logo-white.png" alt="Rhodes Technologies Ltd" />
            <span className="brand-divider" aria-hidden />
            <span className="brand-product">Gatekeeper<small>{me.app.siteName}</small></span>
          </NavLink>
          <nav className="nav" aria-label="Main">
            {links.filter(([, , ok]) => ok).map(([to, label]) => (
              <NavLink key={to} to={to} end={to === '/gate'}>{label}</NavLink>
            ))}
          </nav>
          {can('search.use') && (
            <form className="top-search" role="search" onSubmit={(e) => { e.preventDefault(); if (q.trim()) { nav(`/search?q=${encodeURIComponent(q.trim())}`); setQ(''); } }}>
              <IconSearch width={18} height={18} aria-hidden />
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, ID, plate, PO…" aria-label="Search visitors, IDs, plates and files" />
            </form>
          )}
          <div className="user-menu">
            <div className="user-chip">{me.user.displayName}<small>{me.user.role}</small></div>
            <Button variant="ghost" size="sm" onClick={() => void logout()}>Sign out</Button>
          </div>
        </div>
      </header>
      {me.app.emailMode !== 'graph' && can('settings.manage') && (
        <div className="env-banner">
          {me.app.emailMode === 'devlog'
            ? 'Non-production mode: notification emails are logged, not sent. Configure Microsoft 365 before go-live.'
            : 'Email notifications are disabled.'}
        </div>
      )}
      <main className="page" id="main">
        <Outlet />
        <div className="footer-note">Rhodes Gatekeeper · Rhodes Technologies Ltd — Securing your business</div>
      </main>
    </>
  );
}
