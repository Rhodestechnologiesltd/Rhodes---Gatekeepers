import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
import { Layout } from './components/Layout';
import { Spinner, ToastProvider } from './components/ui';
import { LoginPage, ChangePasswordPage } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { VisitsPage } from './pages/Visits';
import { ReportsPage } from './pages/Reports';
import { SearchPage } from './pages/Search';
import { FolderPage, FoldersPage } from './pages/Folders';
import { UsersPage } from './pages/admin/Users';
import { DirectoryPage } from './pages/admin/Directory';
import { SettingsPage } from './pages/admin/Settings';
import { AuditPage } from './pages/admin/Audit';
import { DevicesPage } from './pages/admin/Devices';

function Guard({ perm, children }: { perm: string; children: ReactNode }) {
  const { can } = useAuth();
  return can(perm) ? <>{children}</> : <Navigate to="/" replace />;
}

function Home() {
  const { can } = useAuth();
  if (can('report.view')) return <Navigate to="/dashboard" replace />;
  if (can('user.manage')) return <Navigate to="/admin/users" replace />;
  return <Navigate to="/visits" replace />;
}

function Routed() {
  const { me, loading } = useAuth();
  if (loading) return <Spinner />;
  if (!me) return <LoginPage />;
  if (me.user.mustChangePassword) return <ChangePasswordPage forced />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="dashboard" element={<Guard perm="report.view"><DashboardPage /></Guard>} />
        <Route path="visits" element={<Guard perm="visit.view_all"><VisitsPage /></Guard>} />
        <Route path="search" element={<Guard perm="search.use"><SearchPage /></Guard>} />
        <Route path="folders" element={<Guard perm="files.view"><FoldersPage /></Guard>} />
        <Route path="folders/:id" element={<Guard perm="files.view"><FolderPage /></Guard>} />
        <Route path="reports" element={<Guard perm="report.view"><ReportsPage /></Guard>} />
        <Route path="admin/users" element={<Guard perm="user.manage"><UsersPage /></Guard>} />
        <Route path="admin/directory" element={<Guard perm="directory.manage"><DirectoryPage /></Guard>} />
        <Route path="admin/devices" element={<Guard perm="device.manage"><DevicesPage /></Guard>} />
        <Route path="admin/settings" element={<Guard perm="settings.manage"><SettingsPage /></Guard>} />
        <Route path="admin/audit" element={<Guard perm="audit.view"><AuditPage /></Guard>} />
        <Route path="account/password" element={<ChangePasswordPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

/** Office web app — reception, managers and administrators. The gate runs on the tablet app. */
export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <Routed />
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
