/**
 * Parsing of OCR text produced ON THE TABLET (Google ML Kit on Android/iOS) from photos of:
 *   - the Emirates ID card (front: printed fields; back: the 3-line machine-readable zone),
 *   - a vehicle number plate,
 *   - a purchase order / delivery note / invoice.
 *
 * OCR is imperfect. Everything here returns SUGGESTIONS for the guard to confirm; nothing is
 * accepted silently. MRZ check digits are the strongest signal and are always validated.
 * Raw OCR text of identity cards is never stored or logged.
 */
import { formatEmiratesId, luhnValid, parseIdScan, type ParsedIdScan } from './parse.js';

const DIGIT_FIX: Record<string, string> = { O: '0', Q: '0', D: '0', I: '1', L: '1', T: '1', Z: '2', S: '5', B: '8', G: '6' };
const toDigits = (s: string) => s.replace(/[OQDILTZSBG]/g, (c) => DIGIT_FIX[c] ?? c);

// ------------------------------------------------------------------ MRZ (card back)
/** Normalise characters OCR typically produces for the MRZ filler "<". */
function mrzChars(line: string): string {
  return line
    .toUpperCase()
    .replace(/[«‹<〈＜]/g, '<')
    .replace(/\s+/g, '')
    .replace(/[^A-Z0-9<]/g, '');
}

/**
 * The name line ends in filler "<<<<", which OCR often reads as "KKK" or "CCC". Everything after the first
 * "<" of the trailing run is filler; before it, only a repeated K/C run (2+) is treated as filler, so a
 * real final letter of a name (e.g. the E of SAMPLE) is kept.
 */
function fixTrailingFiller(line: string): string {
  const m = line.match(/([<KCE]+)$/);
  if (!m || !m[1].includes('<')) return line;
  const run = m[1];
  const firstLt = run.indexOf('<');
  const prefix = run.slice(0, firstLt);
  const rep = prefix.match(/(K{2,}|C{2,})$/)?.[0] ?? '';
  const keep = prefix.slice(0, prefix.length - rep.length);
  return line.slice(0, line.length - run.length) + keep + '<'.repeat(run.length - keep.length);
}

const pad30 = (s: string) => (s + '<'.repeat(30)).slice(0, 30);

/** Find the three TD1 lines in OCR text and repair the predictable errors. */
export function extractTd1(ocrText: string): string | null {
  const lines = ocrText
    .split(/\r?\n/)
    .map(mrzChars)
    .filter((l) => l.length >= 24 && l.length <= 34);
  for (let i = 0; i + 2 < lines.length; i++) {
    let [l1, l2, l3] = [lines[i], lines[i + 1], lines[i + 2]];
    if (!/^[IAC1][A-Z<0-9]/.test(l1) || !/^[0-9OQDILTZSBG]{6}/.test(l2) || !l3.includes('<')) continue;
    // Line 1: "I" + type char + issuer(3) + doc number(9) + check + optional(15)
    l1 = pad30(l1.replace(/^1/, 'I'));
    const uae = l1.slice(2, 5) === 'ARE';
    // Emirates ID card numbers are numeric; repair letter/digit confusions there and in the check digit.
    const docNo = uae ? toDigits(l1.slice(5, 14)) : l1.slice(5, 14);
    // Optional data on the Emirates ID: the 15-digit ID number, then filler.
    const opt = l1.slice(15, 30);
    const eid = toDigits(opt.slice(0, 15));
    const optFixed = /^784\d{12}$/.test(eid) ? eid : opt.replace(/[KCE](?=[<KCE]*$)/g, '<');
    l1 = l1.slice(0, 5) + docNo + toDigits(l1[14]) + optFixed;
    // Line 2: DOB(6)+c, sex, expiry(6)+c, nationality(3), optional(11), composite
    l2 = pad30(l2);
    const sexRaw = l2[7];
    const sex = sexRaw === 'H' ? 'M' : sexRaw === 'P' ? 'F' : sexRaw;
    l2 = toDigits(l2.slice(0, 7)) + sex + toDigits(l2.slice(8, 15)) + l2.slice(15, 18).replace(/0/g, 'O') + l2.slice(18, 29).replace(/[KCE](?=[<KCE]*$)/g, '<') + toDigits(l2[29]);
    // Line 3: names; trailing filler often read as K/C.
    l3 = pad30(fixTrailingFiller(l3.replace(/0/g, 'O')));
    return [l1, l2, l3].join('\n');
  }
  return null;
}

// ------------------------------------------------------------------ card front
const EID_RE = /7\s*8\s*4[\s\-–.]*[\dOQDILTZSBG]{4}[\s\-–.]*[\dOQDILTZSBG]{7}[\s\-–.]*[\dOQDILTZSBG]/;

export interface FrontFields {
  idNumber?: string;
  fullName?: string;
  nationalityText?: string;
  expiryDate?: string;
  dateOfBirth?: string;
}

function labelValue(lines: string[], labels: RegExp): string | undefined {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(labels);
    if (!m) continue;
    const rest = lines[i].slice((m.index ?? 0) + m[0].length).replace(/^[\s:.\-]+/, '').trim();
    if (rest.length >= 2) return rest;
    const next = lines[i + 1]?.trim();
    if (next && /[A-Za-z]/.test(next)) return next;
  }
  return undefined;
}

function dmyToIso(s: string | undefined): string | undefined {
  const m = s?.match(/(\d{2})[/\-.](\d{2})[/\-.](\d{4})/);
  if (!m) return undefined;
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : undefined;
}

export function parseIdFront(ocrText: string): FrontFields {
  const lines = ocrText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out: FrontFields = {};
  const m = ocrText.toUpperCase().match(EID_RE);
  if (m) {
    const digits = toDigits(m[0].replace(/[^0-9A-Z]/g, ''));
    if (/^784\d{12}$/.test(digits)) out.idNumber = formatEmiratesId(digits);
  }
  const name = labelValue(lines, /\bName\b/i);
  if (name && /^[A-Za-z][A-Za-z .'\-]{1,80}$/.test(name)) out.fullName = name.replace(/\s+/g, ' ').toUpperCase();
  const nat = labelValue(lines, /\bNationality\b/i);
  if (nat && /^[A-Za-z][A-Za-z .\-]{1,60}$/.test(nat)) out.nationalityText = nat.toUpperCase();
  out.expiryDate = dmyToIso(labelValue(lines, /\bExpiry\s*Date\b|\bDate\s*of\s*Expiry\b/i));
  out.dateOfBirth = dmyToIso(labelValue(lines, /\bDate\s*of\s*Birth\b|\bBirth\s*Date\b/i));
  return out;
}

/** Combine front and back OCR into one scan result for the check-in form. */
export function parseIdOcr(front: string | undefined, back: string | undefined): ParsedIdScan & { source: string[] } {
  const warnings: string[] = [];
  const source: string[] = [];
  let mrz: ParsedIdScan | null = null;
  if (back) {
    const td1 = extractTd1(back);
    if (td1) {
      mrz = parseIdScan(td1);
      if (mrz.format === 'mrz_td1') source.push('mrz');
      else mrz = null;
    }
  }
  const f = front ? parseIdFront(front) : {};
  if (front && Object.keys(f).length) source.push('front');

  const result: ParsedIdScan & { source: string[] } = { format: 'unrecognized', warnings, source };
  if (mrz) {
    Object.assign(result, mrz, { warnings: [...mrz.warnings], source });
  }
  if (f.idNumber) {
    if (!result.idNumber) result.idNumber = f.idNumber;
    else if (result.idNumber !== f.idNumber) {
      result.warnings.push(`ID number on the front (${maskTail(f.idNumber)}) differs from the back (${maskTail(result.idNumber)}). Check the card.`);
    }
    if (!luhnValid(f.idNumber.replace(/-/g, ''))) result.warnings.push('ID number check digit does not validate — check the number.');
  }
  if (!result.fullName && f.fullName) result.fullName = f.fullName;
  if (!result.expiryDate && f.expiryDate) result.expiryDate = f.expiryDate;
  if (!result.dateOfBirth && f.dateOfBirth) result.dateOfBirth = f.dateOfBirth;
  if (result.idNumber || result.fullName) {
    if (result.format === 'unrecognized') result.format = 'emirates_id_number';
    result.documentType = result.documentType ?? 'emirates_id';
  }
  if (back && !mrz) result.warnings.push('Could not read the machine-readable lines on the back. Retake the photo in good light, or confirm the details by hand.');
  if (!result.idNumber && !result.fullName) result.warnings.push('No ID details were recognised. Retake the photos or enter the details manually.');
  if (result.expiryDate && result.expiryDate < new Date().toISOString().slice(0, 10) && !result.warnings.some((w) => /expir/i.test(w))) {
    result.warnings.push('The card expiry date has passed.');
  }
  return result;
}

const maskTail = (id: string) => `…${id.replace(/-/g, '').slice(-4)}`;

// ------------------------------------------------------------------ number plates
const EMIRATES: [RegExp, string][] = [
  [/\bDUBAI\b|\bDXB\b|دبي/i, 'DUBAI'],
  [/\bABU\s*DHABI\b|\bA\.?\s?D\b|أبوظبي|ابوظبي/i, 'ABU DHABI'],
  [/\bSHARJAH\b|\bSHJ\b|الشارقة/i, 'SHARJAH'],
  [/\bAJMAN\b|عجمان/i, 'AJMAN'],
  [/\bUMM\s*AL\s*QUWAIN\b|\bU\.?A\.?Q\b|أم القيوين/i, 'UMM AL QUWAIN'],
  [/\bRAS\s*AL\s*KHAIMAH\b|\bR\.?A\.?K\b|رأس الخيمة/i, 'RAS AL KHAIMAH'],
  [/\bFUJAIRAH\b|الفجيرة/i, 'FUJAIRAH'],
];

export interface PlateSuggestion {
  plate: string; // display, e.g. "DUBAI A 12345"
  emirate?: string;
  code?: string;
  number: string;
}

/** Normalised search key for a plate: uppercase letters and digits only. */
export function normalizePlate(p: string): string {
  return p.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function parsePlateText(ocrText: string): PlateSuggestion[] {
  const text = ocrText.toUpperCase().replace(/[|]/g, ' ');
  const emirate = EMIRATES.find(([re]) => re.test(ocrText))?.[1];
  const cleaned = text.replace(/[^A-Z0-9\s]/g, ' ').replace(/\b(UAE|U\.A\.E|DUBAI|DXB|ABU|DHABI|SHARJAH|AJMAN|FUJAIRAH|RAK|UAQ|UMM|AL|QUWAIN|RAS|KHAIMAH|SHJ)\b/g, ' ');
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  const found: PlateSuggestion[] = [];
  const push = (code: string | undefined, number: string) => {
    const plate = [emirate, code, number].filter(Boolean).join(' ');
    if (!found.some((f) => f.plate === plate)) found.push({ plate, emirate, code, number });
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const joined = t.match(/^([A-Z]{1,2}|\d{1,2})(\d{3,5})$/); // e.g. "A12345"
    if (/^[A-Z]{1,2}$/.test(t) && /^\d{1,5}$/.test(tokens[i + 1] ?? '')) push(t, tokens[i + 1]);
    else if (/^\d{1,2}$/.test(t) && /^\d{2,5}$/.test(tokens[i + 1] ?? '')) push(t, tokens[i + 1]);
    else if (joined && /[A-Z]/.test(joined[1])) push(joined[1], joined[2]);
    else if (/^\d{3,5}$/.test(t) && !found.length) push(undefined, t);
  }
  return found.slice(0, 5);
}

// ------------------------------------------------------------------ PO / invoice
export interface DocumentSuggestion {
  poNumber?: string;
  invoiceNumber?: string;
  kind?: 'po' | 'invoice';
}

export function parseDocumentText(ocrText: string): DocumentSuggestion {
  const t = ocrText.replace(/\r/g, '');
  // Take the first labelled value that actually contains a digit (a label may be followed by another label).
  const grab = (re: RegExp) => {
    for (const m of t.matchAll(re)) {
      const v = m[1]?.replace(/[.,;:]+$/, '').toUpperCase();
      if (v && /\d/.test(v)) return v;
    }
    return undefined;
  };
  const poNumber = grab(/(?:\bP\.?[ \t]?O\.?|PURCHASE[ \t]+ORDER|\bLPO)[ \t]*(?:NO\.?|NUMBER|NUM|#|REF\.?)?[ \t]*[:#\-]?[ \t]*([A-Z0-9][A-Z0-9\-\/]{2,24})/gi);
  const invoiceNumber = grab(/(?:TAX[ \t]+INVOICE|INVOICE|\bINV)[ \t]*(?:NO\.?|NUMBER|NUM|#|REF\.?)?[ \t]*[:#\-]?[ \t]*([A-Z0-9][A-Z0-9\-\/]{2,24})/gi);
  const out: DocumentSuggestion = { poNumber, invoiceNumber };
  out.kind = /INVOICE/i.test(t) && !/PURCHASE\s+ORDER/i.test(t) ? 'invoice' : out.poNumber ? 'po' : out.invoiceNumber ? 'invoice' : undefined;
  return out;
}
