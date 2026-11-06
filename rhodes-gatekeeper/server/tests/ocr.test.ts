import { describe, expect, it } from 'vitest';
import { extractTd1, normalizePlate, parseDocumentText, parseIdFront, parseIdOcr, parsePlateText } from '../src/scanning/ocr.js';
import { buildTd1, demoEmiratesId } from './helpers.js';

const EID = demoEmiratesId(321);
const mrz = buildTd1({ docNumber: '123456789', eid: EID.replace(/-/g, ''), dob: '900215', sex: 'F', expiry: '310630', nationality: 'ARE', surname: 'EXAMPLE', given: 'NADIA SAMPLE' });

/** Simulate typical OCR damage: spaces, «/K for <, O for 0 in numeric fields, surrounding noise. */
function ocrDamage(s: string): string {
  const [l1, l2, l3] = s.split('\n');
  return [
    'UNITED ARAB EMIRATES',
    'Card Number 123456789',
    l1.replace(/<</g, '«<').replace(/0/g, 'O').replace(/(.{5})/, '$1 '),
    l2.replace(/0/, 'O').replace(/<</, 'KK'),
    l3.replace(/<<<<<<$/, 'KKK<<<'),
    'Signature',
  ].join('\n');
}

describe('Emirates ID OCR — back (MRZ)', () => {
  it('finds and repairs the TD1 lines in noisy OCR text', () => {
    expect(extractTd1(ocrDamage(mrz))).toBe(mrz);
  });

  it('parses repaired MRZ with valid check digits', () => {
    const r = parseIdOcr(undefined, ocrDamage(mrz));
    expect(r.source).toEqual(['mrz']);
    expect(r.checksumsValid).toBe(true);
    expect(r.idNumber).toBe(EID);
    expect(r.fullName).toBe('NADIA SAMPLE EXAMPLE');
    expect(r.expiryDate).toBe('2031-06-30');
    expect(r.warnings).toEqual([]);
  });

  it('flags a misread that check digits catch rather than accepting it', () => {
    const bad = mrz.split('\n');
    bad[1] = '9003150' + bad[1].slice(7); // wrong birth date, stale check digit
    const r = parseIdOcr(undefined, bad.join('\n'));
    expect(r.checksumsValid).toBe(false);
    expect(r.warnings.join(' ')).toMatch(/check digits/i);
  });

  it('asks for a retake when no MRZ is found', () => {
    const r = parseIdOcr(undefined, 'blurry photo text');
    expect(r.idNumber).toBeUndefined();
    expect(r.warnings.join(' ')).toMatch(/Retake/);
  });
});

describe('Emirates ID OCR — front', () => {
  const front = [
    'UNITED ARAB EMIRATES',
    'FEDERAL AUTHORITY FOR IDENTITY',
    `ID Number ${EID.replace(/0/g, 'O')}`,
    'Name: Nadia Sample Example',
    'Date of Birth 15/02/1990',
    'Nationality: United Arab Emirates',
    'Expiry Date 30/06/2031',
  ].join('\n');

  it('reads the printed ID number (repairing O/0), name, nationality and dates', () => {
    expect(parseIdFront(front)).toEqual({
      idNumber: EID, fullName: 'NADIA SAMPLE EXAMPLE', nationalityText: 'UNITED ARAB EMIRATES', expiryDate: '2031-06-30', dateOfBirth: '1990-02-15',
    });
  });

  it('combines front + back and warns if the two ID numbers disagree', () => {
    const ok = parseIdOcr(front, mrz);
    expect(ok.source).toEqual(['mrz', 'front']);
    expect(ok.warnings).toEqual([]);
    const other = front.replace(EID.replace(/0/g, 'O'), demoEmiratesId(999));
    expect(parseIdOcr(other, mrz).warnings.join(' ')).toMatch(/differs/);
  });

  it('works from the front alone', () => {
    const r = parseIdOcr(front, undefined);
    expect(r.idNumber).toBe(EID);
    expect(r.fullName).toBe('NADIA SAMPLE EXAMPLE');
  });
});

describe('number plate OCR', () => {
  it('suggests Dubai letter-code plates', () => {
    expect(parsePlateText('DUBAI\nA 12345\nU.A.E')[0]).toMatchObject({ plate: 'DUBAI A 12345', emirate: 'DUBAI', code: 'A', number: '12345' });
  });
  it('suggests Abu Dhabi / Sharjah numeric-code plates', () => {
    expect(parsePlateText('ABU DHABI 1 54321')[0].plate).toBe('ABU DHABI 1 54321');
    expect(parsePlateText('SHARJAH\n3 | 4567')[0].plate).toBe('SHARJAH 3 4567');
  });
  it('handles code and number read as one token', () => {
    expect(parsePlateText('DXB AA12345')[0].plate).toBe('DUBAI AA 12345');
  });
  it('normalises plates for search', () => {
    expect(normalizePlate('Dubai A-12345')).toBe('DUBAIA12345');
  });
});

describe('PO / invoice OCR', () => {
  it('finds a purchase order number', () => {
    expect(parseDocumentText('ACME DAIRY\nPURCHASE ORDER\nPO No: 45001234\nDate 01/11/2026')).toMatchObject({ poNumber: '45001234', kind: 'po' });
  });
  it('finds a tax invoice number', () => {
    expect(parseDocumentText('TAX INVOICE\nInvoice No. INV-2026-0099\nTotal AED 1,200')).toMatchObject({ invoiceNumber: 'INV-2026-0099', kind: 'invoice' });
  });
  it('ignores labels without a number', () => {
    expect(parseDocumentText('Please quote the PO reference on all invoices').poNumber).toBeUndefined();
  });
});
