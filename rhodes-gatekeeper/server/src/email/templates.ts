import { DateTime } from 'luxon';
import { VISIT_TYPE_LABELS, type VisitDto } from '../domain/types.js';
import { formatMinutes } from '../domain/duration.js';

const esc = (s: string | null | undefined) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface TemplateContext {
  siteName: string;
  timezone: string;
  appBaseUrl: string;
  footer: string;
}

/**
 * Notification content. Deliberately excludes ID numbers, nationality, date of birth and phone.
 */
export function renderVisitEmail(
  event: 'visit.checked_in' | 'visit.checked_out',
  v: VisitDto,
  ctx: TemplateContext,
  people?: { name: string; ref: number; role: string; badge: string | null }[],
) {
  const t = (iso: string | null) =>
    iso ? DateTime.fromISO(iso).setZone(ctx.timezone).toFormat('dd LLL yyyy, HH:mm') : '—';
  const isIn = event === 'visit.checked_in';
  const who = v.visitor.fullName + (v.visitor.company ? ` (${v.visitor.company})` : '');
  const group = people && people.length > 1 ? people : null;
  const isVehicle = v.visitType === 'delivery';
  const subject = isIn
    ? group
      ? `${group.length} ${isVehicle ? 'people' : 'visitors'} arrived: ${v.visitor.fullName} +${group.length - 1} — ${VISIT_TYPE_LABELS[v.visitType]}${v.vehiclePlate ? ` · ${v.vehiclePlate}` : ''}`
      : `Visitor arrived: ${v.visitor.fullName} — ${VISIT_TYPE_LABELS[v.visitType]}${isVehicle && v.vehiclePlate ? ` · ${v.vehiclePlate}` : ''}`
    : `Visitor left: ${v.visitor.fullName}`;

  const roleLabel = (r: string) => (r === 'driver' ? ' (driver)' : r === 'helper' ? ' (helper)' : '');
  const rows: [string, string][] = group
    ? [
        ['Visitors', group.map((p) => `V${p.ref} ${p.name}${roleLabel(p.role)}${p.badge ? ` · badge ${p.badge}` : ''}`).join('\n')],
        ['Company', v.visitor.company ?? '—'],
        ['Visit type', VISIT_TYPE_LABELS[v.visitType]],
      ]
    : [
        ['Visitor', who],
        ['Visit type', VISIT_TYPE_LABELS[v.visitType]],
      ];
  if (v.group?.direction) rows.push(['Direction', v.group.direction === 'collection' ? 'Collection of goods' : 'Delivery of goods']);
  if (v.vehiclePlate) rows.push(['Vehicle', v.vehiclePlate]);
  if (v.group?.poNumber) rows.push(['PO number', v.group.poNumber]);
  if (v.group?.invoiceNumber) rows.push(['Invoice number', v.group.invoiceNumber]);
  if (v.host?.name) rows.push([v.visitType === 'delivery' ? 'Receiving' : 'Host', v.host.name]);
  if (v.department) rows.push(['Department', v.department.name]);
  if (v.deliveryCompany) rows.push(['Delivery company', v.deliveryCompany]);
  if (v.salesReference) rows.push(['Sales / order ref.', v.salesReference]);
  if (v.purpose) rows.push(['Purpose', v.purpose]);
  rows.push(['Checked in', t(v.checkedInAt)]);
  if (!isIn) {
    rows.push(['Checked out', t(v.checkedOutAt)]);
    rows.push(['Time on site (gate check-in to check-out)', formatMinutes(v.durationMinutes)]);
  }
  rows.push(group && v.group ? ['Group reference', `G${v.group.groupNo}`] : ['Visitor ID', `V${v.referenceNo}`]);

  const heading = isIn ? (group ? `${group.length} people have checked in at the gate` : 'A visitor has checked in at the gate') : 'A visitor has checked out at the gate';
  const html = `<!doctype html><html><body style="margin:0;background:#f3f5f6;font-family:Segoe UI,Arial,sans-serif;color:#1d2a30">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;overflow:hidden">
<tr><td style="background:#003b4a;padding:18px 24px;color:#ffffff;font-size:18px;font-weight:600">
<span style="display:inline-block;width:10px;height:10px;background:#D7282F;margin-right:8px"></span>Rhodes Gatekeeper · ${esc(ctx.siteName)}</td></tr>
<tr><td style="padding:24px"><p style="margin:0 0 16px;font-size:16px;font-weight:600">${esc(heading)}</p>
<table role="presentation" width="100%" cellpadding="6" cellspacing="0" style="font-size:14px;border-collapse:collapse">
${rows.map(([k, val]) => `<tr><td style="color:#636569;width:42%;border-bottom:1px solid #e6e9ea;vertical-align:top">${esc(k)}</td><td style="border-bottom:1px solid #e6e9ea">${esc(val).replace(/\n/g, '<br>')}</td></tr>`).join('')}
</table>
<p style="margin:20px 0 0;font-size:12px;color:#636569">${esc(ctx.footer)}</p></td></tr>
<tr><td style="height:4px;background:#D7282F"></td></tr></table></td></tr></table></body></html>`;

  const text = `${heading}\n\n${rows.map(([k, val]) => `${k}: ${val.replace(/\n/g, '\n  ')}`).join('\n')}\n\n${ctx.footer}\n`;
  return { subject, html, text };
}
