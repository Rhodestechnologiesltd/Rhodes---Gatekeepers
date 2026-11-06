import type { IdStatus, VisitType } from './types';

export const VISIT_TYPE_LABEL: Record<VisitType, string> = {
  meeting: 'Meeting',
  delivery: 'Delivery / collection',
  customer: 'Customer',
  other: 'Other',
};
export const VISIT_TYPE_LONG: Record<VisitType, string> = {
  meeting: 'Meeting an employee',
  delivery: 'Delivery or collection of goods',
  customer: 'Customer — purchase or products',
  other: 'Other',
};
export const ID_STATUS_LABEL: Record<IdStatus, string> = {
  scanned: 'ID scanned',
  manual: 'ID entered manually',
  verified: 'ID verified',
  not_provided: 'No ID',
};

let zone = 'Asia/Dubai';
export function setTimezone(tz: string) {
  zone = tz;
}
export const getTimezone = () => zone;

const cache = new Map<string, Intl.DateTimeFormat>();
function fmt(opts: Intl.DateTimeFormatOptions) {
  const key = zone + JSON.stringify(opts);
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: zone, ...opts });
    cache.set(key, f);
  }
  return f;
}

export const time = (iso: string | null | undefined) => (iso ? fmt({ hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)) : '—');
export const date = (iso: string | null | undefined) => (iso ? fmt({ day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(iso)) : '—');
export const dateTime = (iso: string | null | undefined) => (iso ? `${date(iso)}, ${time(iso)}` : '—');

/** YYYY-MM-DD for "today" in the company timezone. */
export function todayLocal(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400_000);
  const parts = fmt({ year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function minutes(m: number | null | undefined): string {
  if (m === null || m === undefined) return '—';
  if (m >= 1440) return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return h ? `${h}h ${String(mm).padStart(2, '0')}m` : `${mm}m`;
}

export function elapsedSince(iso: string): string {
  return minutes(Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000)));
}

export const DURATION_NOTE =
  'Duration = time between visitor check-in and check-out at the gate. It is not a record of the actual meeting time with an employee. Visits without a check-out are excluded from duration totals.';

/** Visitor ID and Group ID as shown everywhere in the apps. */
export const visitorId = (ref: number | null | undefined) => (ref ? `V${ref}` : '—');
export const groupRef = (no: number | null | undefined) => (no ? `G${no}` : '—');

export const FILE_KIND_LABEL: Record<string, string> = {
  id_front: 'ID — front', id_back: 'ID — back', plate: 'Number plate', po: 'Purchase order', invoice: 'Invoice', document: 'Document',
};

export function bytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}
