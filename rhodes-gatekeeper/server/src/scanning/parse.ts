/**
 * Emirates ID scan parsing.
 *
 * The tablet (camera barcode scanning) or a hardware reader (keyboard-wedge / HID) delivers a RAW STRING.
 * This module turns that string into whatever fields it ACTUALLY contains. Fields that are not present
 * in the scanned data are left undefined — nothing is guessed.
 *
 * Supported input formats:
 *  1. ICAO 9303 TD1 machine-readable zone (3 lines × 30 chars), as output by MRZ/document readers.
 *     Check digits are validated; a failed check is reported as a warning, not silently accepted.
 *  2. A bare Emirates ID number (15 digits starting 784, with or without dashes), as encoded by some
 *     card barcodes or typed by a reader.
 *
 * IMPORTANT: Parsing a card proves only that the data was read. It does NOT verify that the card is
 * authentic, unaltered, unexpired or belongs to the person presenting it. Verification, if the company
 * licenses a service for it, belongs in an IdentityVerifier adapter (see verification.ts).
 *
 * Other reader output formats (e.g. a vendor SDK's JSON) can be supported by adding a parser to PARSERS.
 */

export interface ParsedIdScan {
  format: 'mrz_td1' | 'emirates_id_number' | 'unrecognized';
  documentType?: 'emirates_id' | 'other';
  idNumber?: string; // Emirates ID number (784-YYYY-NNNNNNN-C) when present
  documentNumber?: string; // card/document serial from the MRZ
  fullName?: string;
  nationality?: string; // ISO 3166-1 alpha-3 as encoded
  dateOfBirth?: string; // YYYY-MM-DD — returned to the form for the guard's eyes, not stored by default
  sex?: 'M' | 'F' | 'X';
  expiryDate?: string; // YYYY-MM-DD
  issuingState?: string;
  checksumsValid?: boolean;
  warnings: string[];
}

type Parser = (raw: string) => ParsedIdScan | null;

// ---------------- helpers ----------------
const MRZ_WEIGHTS = [7, 3, 1];
function mrzCharValue(c: string): number {
  if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48;
  if (c >= 'A' && c <= 'Z') return c.charCodeAt(0) - 55;
  return 0; // '<'
}
export function mrzCheckDigit(s: string): number {
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += mrzCharValue(s[i]) * MRZ_WEIGHTS[i % 3];
  return sum % 10;
}
function checkOk(field: string, digit: string): boolean {
  if (digit === '<') return /^<*$/.test(field);
  return mrzCheckDigit(field) === Number(digit);
}

/** Luhn check — Emirates ID numbers use a Luhn check digit. Used only to WARN, never to block. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

export function formatEmiratesId(digits15: string): string {
  return `${digits15.slice(0, 3)}-${digits15.slice(3, 7)}-${digits15.slice(7, 14)}-${digits15.slice(14)}`;
}

/** YYMMDD → YYYY-MM-DD. Expiry dates are always 20xx; birth dates pick the century that is not in the future. */
function mrzDate(yymmdd: string, kind: 'birth' | 'expiry', now = new Date()): string | undefined {
  if (!/^\d{6}$/.test(yymmdd)) return undefined;
  const yy = Number(yymmdd.slice(0, 2));
  const mm = yymmdd.slice(2, 4);
  const dd = yymmdd.slice(4, 6);
  let year = 2000 + yy;
  if (kind === 'birth' && year > now.getUTCFullYear()) year -= 100;
  const iso = `${year}-${mm}-${dd}`;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) return undefined;
  return iso;
}

function cleanName(s: string): string {
  return s.replace(/<+/g, ' ').replace(/\s+/g, ' ').trim();
}

// ---------------- parsers ----------------
const parseTd1: Parser = (raw) => {
  const lines = raw
    .toUpperCase()
    .split(/[\r\n]+/)
    .map((l) => l.replace(/\s/g, ''))
    .filter(Boolean);
  // Some readers emit the 90 characters without line breaks.
  if (lines.length === 1 && lines[0].length === 90) {
    lines.splice(0, 1, lines[0].slice(0, 30), lines[0].slice(30, 60), lines[0].slice(60));
  }
  if (lines.length !== 3 || lines.some((l) => l.length !== 30) || !/^[A-Z0-9<]+$/.test(lines.join(''))) return null;
  const [l1, l2, l3] = lines;
  if (!/^[AIC]/.test(l1)) return null;

  const warnings: string[] = [];
  const issuingState = l1.slice(2, 5).replace(/</g, '');
  const docNumber = l1.slice(5, 14);
  const docCheck = l1[14];
  const optional1 = l1.slice(15, 30);
  const dob = l2.slice(0, 6);
  const dobCheck = l2[6];
  const sex = l2[7];
  const expiry = l2.slice(8, 14);
  const expiryCheck = l2[14];
  const nationality = l2.slice(15, 18).replace(/</g, '');
  const optional2 = l2.slice(18, 29);
  const composite = l2[29];

  const checks = [
    checkOk(docNumber, docCheck),
    checkOk(dob, dobCheck),
    checkOk(expiry, expiryCheck),
    checkOk(l1.slice(5, 30) + l2.slice(0, 7) + l2.slice(8, 15) + optional2, composite),
  ];
  const checksumsValid = checks.every(Boolean);
  if (!checksumsValid) warnings.push('MRZ check digits do not match — the scan may be misread. Re-scan or enter manually.');

  const [surname, given = ''] = l3.split('<<');
  const fullName = cleanName(`${cleanName(given)} ${cleanName(surname)}`);

  const eid = optional1.match(/784\d{12}/)?.[0];
  if (issuingState === 'ARE' && !eid) warnings.push('Emirates ID number not found in the MRZ optional data.');
  if (eid && !luhnValid(eid)) warnings.push('Emirates ID number check digit does not validate.');

  const expiryIso = mrzDate(expiry, 'expiry');
  if (expiryIso && expiryIso < new Date().toISOString().slice(0, 10)) warnings.push('The card expiry date has passed.');

  return {
    format: 'mrz_td1',
    documentType: issuingState === 'ARE' ? 'emirates_id' : 'other',
    idNumber: eid ? formatEmiratesId(eid) : undefined,
    documentNumber: docNumber.replace(/</g, '') || undefined,
    fullName: fullName || undefined,
    nationality: nationality || undefined,
    dateOfBirth: mrzDate(dob, 'birth'),
    sex: sex === 'M' || sex === 'F' ? sex : sex === '<' ? 'X' : undefined,
    expiryDate: expiryIso,
    issuingState: issuingState || undefined,
    checksumsValid,
    warnings,
  };
};

const parseEidNumber: Parser = (raw) => {
  const digits = raw.trim().replace(/[\s-]/g, '');
  if (!/^784\d{12}$/.test(digits)) return null;
  const warnings: string[] = [];
  if (!luhnValid(digits)) warnings.push('Emirates ID number check digit does not validate — please re-scan or check the number.');
  return { format: 'emirates_id_number', documentType: 'emirates_id', idNumber: formatEmiratesId(digits), warnings };
};

const PARSERS: Parser[] = [parseTd1, parseEidNumber];

export function parseIdScan(raw: string): ParsedIdScan {
  const input = (raw ?? '').slice(0, 2000);
  for (const p of PARSERS) {
    const r = p(input);
    if (r) return r;
  }
  return {
    format: 'unrecognized',
    warnings: ['The scanned data was not recognised as an Emirates ID MRZ or ID number. Enter the details manually.'],
  };
}
