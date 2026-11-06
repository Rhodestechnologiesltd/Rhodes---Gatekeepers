/**
 * Visit duration = time between visitor CHECK-IN and CHECK-OUT at the gate.
 * It is NOT a measure of how long a visitor actually spent with an employee.
 */
export function visitDurationMinutes(checkedInAt: string, checkedOutAt: string | null | undefined): number | null {
  if (!checkedOutAt) return null;
  const start = Date.parse(checkedInAt);
  const end = Date.parse(checkedOutAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return Math.round((end - start) / 60000);
}

export interface DurationStats {
  visits: number;
  completed: number; // visits with a recorded check-out
  missingCheckout: number; // visits without a check-out (excluded from duration totals)
  totalMinutes: number;
  averageMinutes: number | null;
}

export function summarizeDurations(rows: { checkedInAt: string; checkedOutAt: string | null }[]): DurationStats {
  let completed = 0;
  let total = 0;
  for (const r of rows) {
    const m = visitDurationMinutes(r.checkedInAt, r.checkedOutAt);
    if (m !== null) {
      completed++;
      total += m;
    }
  }
  return {
    visits: rows.length,
    completed,
    missingCheckout: rows.length - completed,
    totalMinutes: total,
    averageMinutes: completed ? Math.round(total / completed) : null,
  };
}

export function formatMinutes(m: number | null): string {
  if (m === null) return '—';
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return h ? `${h}h ${String(mm).padStart(2, '0')}m` : `${mm}m`;
}
