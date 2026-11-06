import { DateTime } from 'luxon';
import type { AppContext } from '../context.js';
import { summarizeDurations, type DurationStats } from '../domain/duration.js';
import { VISIT_TYPES, VISIT_TYPE_LABELS, type VisitDto, type VisitType } from '../domain/types.js';
import { badRequest } from '../errors.js';
import { listAllVisitsInRange, type VisitFilters } from './visits.js';

export const DURATION_DEFINITION =
  'Duration is the time between the visitor checking in and checking out at the gate. ' +
  'It is not a record of how long the visitor actually spent with an employee. ' +
  'Visits without a recorded check-out are counted but excluded from duration totals and averages.';

/** Convert local calendar dates (company timezone) to a UTC [from, to) range. */
export function localRange(fromDate: string, toDate: string, zone: string): { from: string; to: string } {
  const f = DateTime.fromISO(fromDate, { zone }).startOf('day');
  const t = DateTime.fromISO(toDate, { zone }).startOf('day').plus({ days: 1 });
  if (!f.isValid || !t.isValid) throw badRequest('Dates must be YYYY-MM-DD');
  if (t <= f) throw badRequest('End date must be on or after start date');
  if (t.diff(f, 'days').days > 400) throw badRequest('Date range is limited to 400 days');
  return { from: f.toUTC().toISO()!, to: t.toUTC().toISO()! };
}

export function monthRange(month: string, zone: string): { from: string; to: string; fromDate: string; toDate: string } {
  if (!/^\d{4}-\d{2}$/.test(month)) throw badRequest('Month must be YYYY-MM');
  const start = DateTime.fromISO(`${month}-01`, { zone }).startOf('month');
  if (!start.isValid) throw badRequest('Invalid month');
  const end = start.endOf('month');
  return {
    from: start.toUTC().toISO()!,
    to: start.plus({ months: 1 }).toUTC().toISO()!,
    fromDate: start.toISODate()!,
    toDate: end.toISODate()!,
  };
}

interface GroupRow extends DurationStats {
  key: string;
  label: string;
}

function groupBy(visits: VisitDto[], keyFn: (v: VisitDto) => { key: string; label: string } | null): GroupRow[] {
  const groups = new Map<string, { label: string; rows: VisitDto[] }>();
  for (const v of visits) {
    const k = keyFn(v);
    if (!k) continue;
    const g = groups.get(k.key) ?? { label: k.label, rows: [] };
    g.rows.push(v);
    groups.set(k.key, g);
  }
  return [...groups.entries()]
    .map(([key, g]) => ({ key, label: g.label, ...summarizeDurations(g.rows) }))
    .sort((a, b) => b.visits - a.visits || a.label.localeCompare(b.label));
}

export async function buildSummary(ctx: AppContext, filters: VisitFilters) {
  const visits = await listAllVisitsInRange(ctx, filters);
  const byType = VISIT_TYPES.map((t) => {
    const rows = visits.filter((v) => v.visitType === t);
    return { key: t, label: VISIT_TYPE_LABELS[t], ...summarizeDurations(rows) };
  });
  const byEmployee = groupBy(visits, (v) =>
    v.host?.name ? { key: v.host.employeeId ?? `text:${v.host.name.toLowerCase()}`, label: v.host.name } : null,
  );
  const byDepartment = groupBy(visits, (v) => (v.department ? { key: v.department.id, label: v.department.name } : { key: 'none', label: 'No department' }));
  return { visits, totals: summarizeDurations(visits), byType, byEmployee, byDepartment, durationDefinition: DURATION_DEFINITION };
}

export async function dashboard(ctx: AppContext, range?: { fromDate?: string; toDate?: string }) {
  const s = await ctx.settings.get();
  const zone = s.timezone;
  const today = DateTime.fromJSDate(ctx.now(), { zone }).toISODate()!;
  const todayRange = localRange(today, today, zone);
  const fromDate = range?.fromDate || today;
  const toDate = range?.toDate || today;
  const sel = localRange(fromDate, toDate, zone);

  const [onSite, todaySummary, rangeSummary] = await Promise.all([
    listAllVisitsInRange(ctx, { status: 'on_site' }),
    buildSummary(ctx, todayRange),
    buildSummary(ctx, sel),
  ]);
  const overdueCutoff = ctx.now().getTime() - s.overdueAfterHours * 3600_000;
  const startOfToday = Date.parse(todayRange.from);
  const strip = (v: VisitDto) => ({
    id: v.id, referenceNo: v.referenceNo, visitType: v.visitType, visitorName: v.visitor.fullName,
    company: v.visitor.company, hostName: v.host?.name ?? null, department: v.department?.name ?? null,
    badgeNumber: v.badgeNumber, checkedInAt: v.checkedInAt, checkedOutAt: v.checkedOutAt,
    durationMinutes: v.durationMinutes, idStatus: v.idStatus, checkoutMethod: v.checkoutMethod,
    vehiclePlate: v.vehiclePlate, groupId: v.group?.id ?? null, groupNo: v.group?.groupNo ?? null,
  });
  const notCheckedOut = onSite.filter((v) => Date.parse(v.checkedInAt) < startOfToday || Date.parse(v.checkedInAt) < overdueCutoff);

  return {
    timezone: zone,
    today,
    range: { fromDate, toDate },
    onSite: onSite.map(strip),
    onSiteCount: onSite.length,
    notCheckedOut: notCheckedOut.map(strip),
    overdueAfterHours: s.overdueAfterHours,
    todayStats: { totals: todaySummary.totals, byType: todaySummary.byType },
    selected: {
      totals: rangeSummary.totals,
      byType: rangeSummary.byType,
      byEmployee: rangeSummary.byEmployee.slice(0, 15),
      byDepartment: rangeSummary.byDepartment,
      recent: rangeSummary.visits.slice(-25).reverse().map(strip),
    },
    durationDefinition: DURATION_DEFINITION,
  };
}

// ------------------------------------------------------------------ CSV
/** Neutralise spreadsheet formula injection and quote per RFC 4180. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function visitsToCsv(visits: VisitDto[], zone: string): string {
  const fmt = (iso: string | null) => (iso ? DateTime.fromISO(iso).setZone(zone).toFormat('yyyy-MM-dd HH:mm') : '');
  const header = [
    'Reference', 'Visit type', 'Visitor', 'Company', 'Host / receiving employee', 'Department', 'Purpose',
    'Delivery company', 'Sales/order ref', 'ID status', `Checked in (${zone})`, `Checked out (${zone})`,
    'Gate duration (minutes)', 'Check-out status', 'Checked in by', 'Checked out by',
  ];
  const lines = [header.map(csvCell).join(',')];
  for (const v of visits) {
    const outStatus = !v.checkedOutAt ? 'NOT CHECKED OUT' : v.checkoutMethod === 'manual_correction' ? 'Corrected by staff' : 'Gate';
    lines.push(
      [
        v.referenceNo, VISIT_TYPE_LABELS[v.visitType as VisitType], v.visitor.fullName, v.visitor.company, v.host?.name,
        v.department?.name, v.purpose, v.deliveryCompany, v.salesReference, v.idStatus, fmt(v.checkedInAt),
        fmt(v.checkedOutAt), v.durationMinutes ?? '', outStatus, v.checkedInBy, v.checkedOutBy,
      ].map(csvCell).join(','),
    );
  }
  lines.push('');
  lines.push(csvCell(`Note: ${DURATION_DEFINITION}`));
  return '﻿' + lines.join('\r\n') + '\r\n';
}
