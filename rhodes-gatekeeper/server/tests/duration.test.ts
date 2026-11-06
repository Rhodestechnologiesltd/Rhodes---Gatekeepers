import { describe, expect, it } from 'vitest';
import { formatMinutes, summarizeDurations, visitDurationMinutes } from '../src/domain/duration.js';
import { csvCell, localRange, monthRange } from '../src/services/reports.js';

describe('visit duration', () => {
  it('is check-out minus check-in, rounded to minutes', () => {
    expect(visitDurationMinutes('2026-10-01T08:00:00Z', '2026-10-01T09:29:40Z')).toBe(90);
  });
  it('is null when there is no check-out or the times are inconsistent', () => {
    expect(visitDurationMinutes('2026-10-01T08:00:00Z', null)).toBeNull();
    expect(visitDurationMinutes('2026-10-01T08:00:00Z', '2026-10-01T07:00:00Z')).toBeNull();
  });
  it('excludes visits without check-out from totals and averages, but counts them', () => {
    const s = summarizeDurations([
      { checkedInAt: '2026-10-01T08:00:00Z', checkedOutAt: '2026-10-01T08:30:00Z' },
      { checkedInAt: '2026-10-01T09:00:00Z', checkedOutAt: '2026-10-01T10:30:00Z' },
      { checkedInAt: '2026-10-01T11:00:00Z', checkedOutAt: null },
    ]);
    expect(s).toEqual({ visits: 3, completed: 2, missingCheckout: 1, totalMinutes: 120, averageMinutes: 60 });
  });
  it('average is null when nothing is complete', () => {
    expect(summarizeDurations([{ checkedInAt: '2026-10-01T08:00:00Z', checkedOutAt: null }]).averageMinutes).toBeNull();
  });
  it('formats minutes', () => {
    expect(formatMinutes(125)).toBe('2h 05m');
    expect(formatMinutes(9)).toBe('9m');
    expect(formatMinutes(null)).toBe('—');
  });
});

describe('timezone-aware ranges', () => {
  it('converts local calendar days in Asia/Dubai (UTC+4) to UTC', () => {
    expect(localRange('2026-10-27', '2026-10-27', 'Asia/Dubai')).toEqual({ from: '2026-10-26T20:00:00.000Z', to: '2026-10-27T20:00:00.000Z' });
  });
  it('builds month ranges in the company timezone', () => {
    const r = monthRange('2026-02', 'Asia/Dubai');
    expect(r.from).toBe('2026-01-31T20:00:00.000Z');
    expect(r.to).toBe('2026-02-28T20:00:00.000Z');
    expect(r.toDate).toBe('2026-02-28');
  });
  it('rejects bad ranges', () => {
    expect(() => localRange('2026-10-27', '2026-10-01', 'Asia/Dubai')).toThrow();
    expect(() => monthRange('2026-13', 'Asia/Dubai')).toThrow();
  });
});

describe('CSV safety', () => {
  it('neutralises formula injection and quotes', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+971')).toBe("'+971");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell(null)).toBe('');
  });
});
