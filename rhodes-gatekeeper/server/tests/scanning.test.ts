import { describe, expect, it } from 'vitest';
import { luhnValid, parseIdScan } from '../src/scanning/parse.js';
import { maskIdNumber } from '../src/security/crypto.js';
import { buildTd1, demoEmiratesId } from './helpers.js';

const EID = demoEmiratesId(123).replace(/-/g, ''); // fictional, 0000 year block

describe('Emirates ID scan parsing', () => {
  it('parses a TD1 MRZ and only returns fields present in the data', () => {
    const mrz = buildTd1({ docNumber: 'X12345678', eid: EID, dob: '900215', sex: 'F', expiry: '310630', nationality: 'ARE', surname: 'EXAMPLE', given: 'SAMPLE TEST' });
    const r = parseIdScan(mrz);
    expect(r.format).toBe('mrz_td1');
    expect(r.checksumsValid).toBe(true);
    expect(r.idNumber).toBe(demoEmiratesId(123));
    expect(r.fullName).toBe('SAMPLE TEST EXAMPLE');
    expect(r.nationality).toBe('ARE');
    expect(r.dateOfBirth).toBe('1990-02-15');
    expect(r.expiryDate).toBe('2031-06-30');
    expect(r.sex).toBe('F');
    expect(r.warnings).toEqual([]);
  });

  it('accepts a 90-character MRZ with no line breaks', () => {
    const mrz = buildTd1({ docNumber: 'X12345678', eid: EID, dob: '900215', sex: 'M', expiry: '310630', nationality: 'ARE', surname: 'EXAMPLE', given: 'TEST' });
    expect(parseIdScan(mrz.replace(/\n/g, '')).format).toBe('mrz_td1');
  });

  it('flags MRZ check-digit failures instead of silently accepting them', () => {
    const mrz = buildTd1({ docNumber: 'X12345678', eid: EID, dob: '900215', sex: 'M', expiry: '310630', nationality: 'ARE', surname: 'EXAMPLE', given: 'TEST' });
    const lines = mrz.split('\n');
    lines[1] = '9002160' + lines[1].slice(7); // corrupt the DOB but keep its old check digit
    const r = parseIdScan(lines.join('\n'));
    expect(r.checksumsValid).toBe(false);
    expect(r.warnings.join(' ')).toMatch(/check digits/i);
  });

  it('warns when the card has expired', () => {
    const mrz = buildTd1({ docNumber: 'X12345678', eid: EID, dob: '900215', sex: 'M', expiry: '200101', nationality: 'ARE', surname: 'EXAMPLE', given: 'TEST' });
    expect(parseIdScan(mrz).warnings.join(' ')).toMatch(/expir/i);
  });

  it('parses a bare Emirates ID number with or without dashes', () => {
    expect(parseIdScan(EID).idNumber).toBe(demoEmiratesId(123));
    expect(parseIdScan(demoEmiratesId(123)).format).toBe('emirates_id_number');
    expect(parseIdScan(demoEmiratesId(123)).fullName).toBeUndefined(); // not in the data → not invented
  });

  it('warns (not blocks) on a bad Emirates ID check digit', () => {
    const bad = EID.slice(0, 14) + ((Number(EID[14]) + 1) % 10);
    const r = parseIdScan(bad);
    expect(r.format).toBe('emirates_id_number');
    expect(r.warnings.length).toBe(1);
  });

  it('reports unrecognised data without guessing', () => {
    const r = parseIdScan('hello world');
    expect(r.format).toBe('unrecognized');
    expect(r.idNumber).toBeUndefined();
  });

  it('Luhn and masking helpers', () => {
    expect(luhnValid(EID)).toBe(true);
    expect(maskIdNumber(demoEmiratesId(123))).toMatch(/^784-\*{4}-\*{5}\d{2}-\d$/);
    expect(maskIdNumber('AB1234567')).toBe('*****4567');
  });
});
