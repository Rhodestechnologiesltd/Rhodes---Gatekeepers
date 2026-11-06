import { DateTime } from 'luxon';

/**
 * Automatic folder and file names.
 *
 *  Visitors / 2026 / 11 / NADIA-SAMPLE-EXAMPLE_2026-11-04_1430
 *      V1262_NADIA-SAMPLE-EXAMPLE_EID-front.jpg
 *      V1262_NADIA-SAMPLE-EXAMPLE_EID-back.jpg
 *      V1263_SAM-VISITOR_EID-front.jpg …
 *
 *  Vehicles / 2026 / 11 / DUBAI-A-12345_2026-11-04_0915
 *      DUBAI-A-12345_plate_1.jpg
 *      DUBAI-A-12345_PO-45001234_1.jpg
 *      DUBAI-A-12345_INVOICE-INV-9981_1.pdf
 *      V1270_DRIVER_JOHN-DRIVER_EID-front.jpg …
 *
 * Names are safe for Windows, macOS, Linux and SharePoint (no  " * : < > ? / \ | # % ~ & { } ).
 */
export function safeName(s: string, max = 60): string {
  const cleaned = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip Latin accents (é → E); other scripts keep their marks
    .normalize('NFC')
    .toUpperCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return cleaned || 'UNKNOWN';
}

export function stamp(iso: string, zone: string): { date: string; time: string; year: string; month: string } {
  const d = DateTime.fromISO(iso).setZone(zone);
  return { date: d.toFormat('yyyy-MM-dd'), time: d.toFormat('HHmm'), year: d.toFormat('yyyy'), month: d.toFormat('MM') };
}

export function groupFolder(opts: {
  visitType: string;
  plate?: string | null;
  leadName: string;
  checkedInAt: string;
  zone: string;
}): { top: 'Vehicles' | 'Visitors'; name: string; relDir: (suffix?: string) => string } {
  const s = stamp(opts.checkedInAt, opts.zone);
  const isVehicle = opts.visitType === 'delivery' && !!opts.plate;
  const base = isVehicle ? `${safeName(opts.plate!, 40)}_${s.date}_${s.time}` : `${safeName(opts.leadName, 60)}_${s.date}_${s.time}`;
  const top = isVehicle ? 'Vehicles' : 'Visitors';
  return { top, name: base, relDir: (suffix = '') => `${top}/${s.year}/${s.month}/${base}${suffix}` };
}

export type FileKind = 'id_front' | 'id_back' | 'plate' | 'po' | 'invoice' | 'document';
export const ID_KINDS: ReadonlySet<FileKind> = new Set(['id_front', 'id_back']);

export function fileBaseName(opts: {
  kind: FileKind;
  ext: string;
  index: number; // 1-based sequence within the folder for this kind/person
  visitorRef?: number;
  visitorName?: string;
  role?: string | null;
  docType?: string; // emirates_id | passport | other
  plate?: string | null;
  docNumber?: string | null;
}): string {
  const plate = opts.plate ? safeName(opts.plate, 40) : null;
  const who = opts.visitorRef ? `V${opts.visitorRef}${opts.role && opts.role !== 'visitor' ? `_${safeName(opts.role, 10)}` : ''}_${safeName(opts.visitorName ?? '', 50)}` : null;
  const idLabel = opts.docType === 'passport' ? 'PASSPORT' : opts.docType === 'other' ? 'ID' : 'EID';
  const n = opts.index > 1 ? `-${opts.index}` : '';
  switch (opts.kind) {
    case 'id_front':
      return `${who ?? 'VISITOR'}_${idLabel}-front${n}.${opts.ext}`;
    case 'id_back':
      return `${who ?? 'VISITOR'}_${idLabel}-back${n}.${opts.ext}`;
    case 'plate':
      return `${plate ?? 'VEHICLE'}_plate_${opts.index}.${opts.ext}`;
    case 'po':
      return `${plate ?? who ?? 'VISIT'}_PO${opts.docNumber ? `-${safeName(opts.docNumber, 30).replace(/^L?PO-?(?=.)/, '')}` : ''}_${opts.index}.${opts.ext}`;
    case 'invoice':
      return `${plate ?? who ?? 'VISIT'}_INVOICE${opts.docNumber ? `-${safeName(opts.docNumber, 30).replace(/^INVOICE-?(?=.)/, '')}` : ''}_${opts.index}.${opts.ext}`;
    default:
      return `${plate ?? who ?? 'VISIT'}_document_${opts.index}.${opts.ext}`;
  }
}
