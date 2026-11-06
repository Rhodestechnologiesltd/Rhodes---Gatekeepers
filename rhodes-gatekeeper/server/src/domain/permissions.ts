export const ROLES = ['guard', 'reception', 'manager', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'visit.create',
  'visit.checkout',
  'visit.view_onsite',
  'visit.view_all',
  'visit.edit',
  'visit.manual_checkout',
  'visitor.view_sensitive', // reveal a stored full ID number (only if storage is enabled)
  'directory.read', // look up employees/departments when checking someone in
  'directory.manage',
  'report.view',
  'report.export',
  'search.use',
  'files.upload', // gate tablet: ID images, plate photos, PO/invoice
  'files.view', // plate photos and PO/invoice documents
  'files.view_id', // identity-card images (always audited)
  'files.download', // download a whole visit folder as a ZIP (audited)
  'files.manage_sync', // SharePoint sync status / retry
  'device.manage', // enrol and revoke gate tablets
  'user.manage',
  'settings.manage',
  'audit.view',
  'retention.run',
  'scan.parse',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Security guard — gate tablet app only. */
const guard: Permission[] = ['visit.create', 'visit.checkout', 'visit.view_onsite', 'directory.read', 'scan.parse', 'files.upload'];

/** Receptionist — web app: records, dashboard, reports, search, non-identity documents. */
const reception: Permission[] = [
  'visit.view_onsite',
  'visit.view_all',
  'visit.edit',
  'visit.manual_checkout',
  'directory.read',
  'report.view',
  'report.export',
  'search.use',
  'files.view',
];

/** Manager — everything reception has, plus identity-card images, folder downloads and the audit log. */
const manager: Permission[] = [...reception, 'files.view_id', 'files.download', 'audit.view'];

/** Single source of truth for authorization. Enforced by the API; the UI only mirrors it. */
export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  guard: new Set(guard),
  reception: new Set(reception),
  manager: new Set(manager),
  admin: new Set(PERMISSIONS.filter((p) => !['visit.create', 'files.upload'].includes(p))),
};

/** Which client each role may sign in from. The gate is tablet-only; the web app is for office staff. */
export const ROLE_CLIENTS: Record<Role, ReadonlySet<'web' | 'mobile'>> = {
  guard: new Set(['mobile']),
  reception: new Set(['web']),
  manager: new Set(['web']),
  admin: new Set(['web']),
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLES as readonly string[]).includes(v);
}
