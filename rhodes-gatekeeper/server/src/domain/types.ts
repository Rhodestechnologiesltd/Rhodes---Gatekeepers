import type { Role } from './permissions.js';

export const VISIT_TYPES = ['meeting', 'delivery', 'customer', 'other'] as const;
export type VisitType = (typeof VISIT_TYPES)[number];

export const VISIT_TYPE_LABELS: Record<VisitType, string> = {
  meeting: 'Meeting an employee',
  delivery: 'Delivery / collection',
  customer: 'Customer (purchase / products)',
  other: 'Other',
};

export type VisitStatus = 'on_site' | 'checked_out';
/** "scanned" = data read from the card. It does NOT mean authenticity/validity was verified. */
export type IdStatus = 'scanned' | 'manual' | 'verified' | 'not_provided';
export type IdScanMethod = 'camera_barcode' | 'hardware_reader' | 'manual';
export type IdDocumentType = 'emirates_id' | 'passport' | 'other' | 'none';

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  mustChangePassword: boolean;
}

export interface VisitDto {
  id: string;
  referenceNo: number;
  visitType: VisitType;
  status: VisitStatus;
  visitor: {
    id: string;
    fullName: string;
    company: string | null;
    phone: string | null;
    nationality: string | null;
    idDocumentType: IdDocumentType;
    idNumberMasked: string | null;
    idExpiryDate: string | null;
    hasStoredFullId: boolean;
    purged: boolean;
  };
  host: { employeeId: string | null; name: string | null; email?: string | null } | null;
  department: { id: string; name: string } | null;
  purpose: string | null;
  deliveryCompany: string | null;
  salesReference: string | null;
  vehiclePlate: string | null;
  badgeNumber: string | null;
  notes: string | null;
  idStatus: IdStatus;
  idScanMethod: IdScanMethod | null;
  privacyNoticeAck: boolean;
  checkedInAt: string;
  checkedInBy: string | null;
  checkedOutAt: string | null;
  checkedOutBy: string | null;
  checkoutMethod: string | null;
  checkoutNote: string | null;
  durationMinutes: number | null;
  group: {
    id: string;
    groupNo: number;
    role: 'visitor' | 'driver' | 'helper';
    position: number;
    folderName: string;
    direction: 'delivery' | 'collection' | null;
    poNumber: string | null;
    invoiceNumber: string | null;
  } | null;
}
