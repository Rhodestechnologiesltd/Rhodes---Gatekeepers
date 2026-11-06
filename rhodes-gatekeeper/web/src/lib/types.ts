export type Role = 'guard' | 'reception' | 'manager' | 'admin';
export type VisitType = 'meeting' | 'delivery' | 'customer' | 'other';
export type IdStatus = 'scanned' | 'manual' | 'verified' | 'not_provided';

export interface Me {
  user: { id: string; username: string; displayName: string; role: Role; mustChangePassword: boolean };
  permissions: string[];
  app: {
    companyName: string;
    siteName: string;
    timezone: string;
    requireIdDocument: boolean;
    privacyNotice: { enabled: boolean; requireAcknowledgement: boolean; text: string };
    visitTypes: { value: VisitType; label: string }[];
    emailMode: 'graph' | 'devlog' | 'disabled';
    verificationEnabled: boolean;
    nonProduction: boolean;
    capture: CaptureSettings;
    sharepointEnabled: boolean;
  };
}

export interface CaptureSettings {
  storeIdImages: boolean;
  requireIdImages: boolean;
  requirePlatePhotoForDelivery: boolean;
  requireDocumentForDelivery: boolean;
  maxGroupSize: number;
}

export interface Visit {
  id: string;
  referenceNo: number;
  visitType: VisitType;
  status: 'on_site' | 'checked_out';
  visitor: {
    id: string; fullName: string; company: string | null; phone: string | null; nationality: string | null;
    idDocumentType: string; idNumberMasked: string | null; idExpiryDate: string | null; hasStoredFullId: boolean; purged: boolean;
  };
  host: { employeeId: string | null; name: string | null } | null;
  department: { id: string; name: string } | null;
  purpose: string | null;
  deliveryCompany: string | null;
  salesReference: string | null;
  vehiclePlate: string | null;
  badgeNumber: string | null;
  notes: string | null;
  idStatus: IdStatus;
  idScanMethod: string | null;
  privacyNoticeAck: boolean;
  checkedInAt: string;
  checkedInBy: string | null;
  checkedOutAt: string | null;
  checkedOutBy: string | null;
  checkoutMethod: string | null;
  checkoutNote: string | null;
  durationMinutes: number | null;
  group: { id: string; groupNo: number; role: 'visitor' | 'driver' | 'helper'; position: number; folderName: string; direction: 'delivery' | 'collection' | null; poNumber: string | null; invoiceNumber: string | null } | null;
}

export interface Group {
  id: string; groupNo: number; visitType: VisitType; direction: 'delivery' | 'collection' | null;
  host: { employeeId: string | null; name: string | null } | null; department: { id: string; name: string } | null;
  purpose: string | null; deliveryCompany: string | null; salesReference: string | null; vehiclePlate: string | null;
  poNumber: string | null; invoiceNumber: string | null; notes: string | null; folderName: string; folderPath: string;
  purged: boolean; checkedInAt: string; checkedInBy: string | null; visitorCount: number; onSiteCount: number;
  fileCounts: Record<string, number>; leadName: string | null;
}

export type FileKind = 'id_front' | 'id_back' | 'plate' | 'po' | 'invoice' | 'document';
export interface StoredFile {
  id: string; groupId: string; visitId: string | null; kind: FileKind; isIdImage: boolean; fileName: string;
  folderName: string; folderPath: string; mime: string; sizeBytes: number; docNumber: string | null;
  sharepoint: string; uploadedBy: string | null; createdAt: string; visitorName?: string | null; visitorRef?: number | null;
}

export interface VisitSummaryRow {
  id: string; referenceNo: number; visitType: VisitType; visitorName: string; company: string | null; hostName: string | null;
  department: string | null; badgeNumber: string | null; checkedInAt: string; checkedOutAt: string | null;
  durationMinutes: number | null; idStatus: IdStatus; checkoutMethod: string | null;
  vehiclePlate: string | null; groupId: string | null; groupNo: number | null;
}

export interface OnSiteRow {
  id: string; referenceNo: number; visitType: VisitType; visitorName: string; company: string | null; idNumberMasked: string | null;
  hostName: string | null; department: string | null; deliveryCompany: string | null; badgeNumber: string | null;
  vehiclePlate: string | null; checkedInAt: string;
  groupId: string | null; groupNo: number | null; groupRole: 'visitor' | 'driver' | 'helper' | null; groupPosition: number | null;
}

export interface DurationStats { visits: number; completed: number; missingCheckout: number; totalMinutes: number; averageMinutes: number | null }
export interface GroupRow extends DurationStats { key: string; label: string }

export interface Employee { id: string; fullName: string; jobTitle: string | null; departmentId: string | null; departmentName: string | null; active: boolean; email?: string | null; phone?: string | null }
export interface Department { id: string; name: string; notificationEmail?: string | null; active?: boolean }

export interface ParsedScan {
  format: 'mrz_td1' | 'emirates_id_number' | 'unrecognized';
  documentType?: 'emirates_id' | 'other';
  idNumber?: string; documentNumber?: string; fullName?: string; nationality?: string; dateOfBirth?: string;
  sex?: string; expiryDate?: string; checksumsValid?: boolean; warnings: string[]; source?: string[];
}
export interface PlateSuggestion { plate: string; emirate?: string; code?: string; number: string }
export interface ScanLookup {
  previousVisitor: { fullName: string; company: string | null; phone: string | null } | null;
  onSiteVisit: { id: string; referenceNo: number; checkedInAt: string } | null;
}
