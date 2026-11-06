import crypto from 'node:crypto';
import { DateTime } from 'luxon';
import type { AppContext } from '../context.js';
import { hashPassword, maskIdNumber } from '../security/crypto.js';
import { formatEmiratesId } from '../scanning/parse.js';
import type { VisitType } from '../domain/types.js';
import { fileBaseName, groupFolder } from '../files/naming.js';
import { normalizePlate } from '../scanning/ocr.js';
import { createDevice } from '../services/devices.js';

/**
 * DEMO DATA ONLY — every name, company, email and ID number below is fictional.
 * Emails use the reserved example.com domain. Demo ID numbers use the impossible year block "0000",
 * so they cannot belong to a real card holder.
 */
export const DEMO_PASSWORD = 'Gatekeeper-Demo-2026';

function luhnDigit(partial: string): string {
  for (let d = 0; d <= 9; d++) {
    const s = partial + d;
    let sum = 0;
    let dbl = false;
    for (let i = s.length - 1; i >= 0; i--) {
      let n = s.charCodeAt(i) - 48;
      if (dbl) { n *= 2; if (n > 9) n -= 9; }
      sum += n;
      dbl = !dbl;
    }
    if (sum % 10 === 0) return String(d);
  }
  return '0';
}
export function demoEmiratesId(n: number): string {
  const partial = `7840000${String(n).padStart(7, '0')}`;
  return formatEmiratesId(partial + luhnDigit(partial));
}

let seedState = 42;
const rand = () => ((seedState = (seedState * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T,>(a: T[]): T => a[Math.floor(rand() * a.length)];

export async function seedDemo(ctx: AppContext): Promise<{ users: string[]; enrollmentCode: string }> {
  if (ctx.config.isProduction) throw new Error('Refusing to load demo data in production');
  const db = ctx.db;
  const existing = await db('users').count({ n: '*' }).first();
  if (Number(existing?.n) > 0) throw new Error('Database already has users — demo seed only runs on an empty database');
  const now = new Date().toISOString();
  const zone = (await ctx.settings.get()).timezone;

  const deps = ['Production', 'Quality Assurance', 'Warehouse & Logistics', 'Sales', 'Finance', 'Maintenance', 'Human Resources'];
  const depIds: Record<string, string> = {};
  for (const name of deps) {
    const id = crypto.randomUUID();
    depIds[name] = id;
    const slug = name.toLowerCase().replace(/[^a-z]+/g, '-').replace(/-$/, '');
    await db('departments').insert({ id, name, notification_email: name === 'Warehouse & Logistics' ? `${slug}@example.com` : null, active: true, created_at: now, updated_at: now });
  }

  const employees: [string, string, string][] = [
    ['Layla Demo', 'Production', 'Production Manager'],
    ['Omar Sample', 'Quality Assurance', 'QA Lead'],
    ['Priya Placeholder', 'Sales', 'Key Account Manager'],
    ['Daniel Testcase', 'Warehouse & Logistics', 'Stores Supervisor'],
    ['Fatima Fictional', 'Finance', 'Accounts Officer'],
    ['Chen Example', 'Maintenance', 'Maintenance Engineer'],
    ['Noura Mockup', 'Human Resources', 'HR Coordinator'],
    ['Rahul Specimen', 'Sales', 'Sales Executive'],
  ];
  const empIds: { id: string; dep: string }[] = [];
  for (const [fullName, dep, title] of employees) {
    const id = crypto.randomUUID();
    empIds.push({ id, dep });
    await db('employees').insert({
      id, full_name: fullName, email: `${fullName.toLowerCase().replace(/\s+/g, '.')}@example.com`, phone: null, job_title: title,
      department_id: depIds[dep], active: true, created_at: now, updated_at: now,
    });
  }

  const pw = await hashPassword(DEMO_PASSWORD);
  const users = [
    ['admin', 'Demo Administrator', 'admin'],
    ['reception', 'Demo Reception', 'reception'],
    ['manager', 'Demo Manager', 'manager'],
    ['guard', 'Demo Gate Guard', 'guard'],
  ] as const;
  const userIds: Record<string, string> = {};
  for (const [username, displayName, role] of users) {
    const id = crypto.randomUUID();
    userIds[role] = id;
    await db('users').insert({ id, username, display_name: displayName, email: null, role, password_hash: pw, active: true, must_change_password: false, failed_logins: 0, created_at: now, updated_at: now });
  }

  const visitorNames = ['Sam Visitor', 'Jordan Guest', 'Taylor Caller', 'Morgan Delivery', 'Casey Buyer', 'Riley Contractor', 'Avery Auditor', 'Quinn Courier', 'Jamie Trader', 'Drew Inspector', 'Robin Supplier', 'Charlie Client'];
  const companies = ['Example Dairy Supplies LLC', 'Sample Packaging Co.', 'Demo Cold Chain Logistics', 'Placeholder Retail Group', 'Fictional Flavours Trading', 'Test Equipment Services'];
  const couriers = ['Demo Express', 'Sample Freight', 'Example Couriers'];
  const types: VisitType[] = ['meeting', 'meeting', 'delivery', 'delivery', 'delivery', 'customer', 'customer', 'other'];

  const plates = ['DUBAI A 12345', 'DUBAI K 4471', 'SHARJAH 3 88210', 'ABU DHABI 1 54321', 'AJMAN B 9076', 'DUBAI AA 31057'];
  let ref = 1000;
  let groupNo = 1000;
  let idSeq = 1;
  const usedFolders = new Set<string>();
  const today = DateTime.now().setZone(zone).startOf('day');
  for (let dayOffset = 45; dayOffset >= 0; dayOffset--) {
    const day = today.minus({ days: dayOffset });
    if (day.weekday === 5 && rand() < 0.7) continue; // quieter Fridays
    const count = dayOffset === 0 ? 6 : 2 + Math.floor(rand() * 6);
    for (let i = 0; i < count; i++) {
      const type = pick(types);
      const inAt = day.plus({ hours: 7 + rand() * 9, minutes: Math.floor(rand() * 60) });
      if (inAt.toJSDate() > new Date()) continue;
      const durationMin = type === 'delivery' ? 15 + rand() * 50 : 30 + rand() * 120;
      let outAt: DateTime | null = inAt.plus({ minutes: durationMin });
      if (outAt.toJSDate() > new Date()) outAt = null;
      if (dayOffset === 1 && i === 0) outAt = null; // a forgotten check-out from yesterday
      if (dayOffset > 1 && rand() < 0.03) outAt = null;

      // Group size: meetings/customers sometimes come in groups; trucks have a driver + 0–2 helpers.
      const size = type === 'delivery' ? 1 + Math.floor(rand() * 3) : rand() < 0.25 ? 2 + Math.floor(rand() * 3) : 1;
      const emp = pick(empIds);
      const ts = inAt.toUTC().toISO()!;
      const plate = type === 'delivery' ? pick(plates) : null;
      const company = type === 'delivery' ? pick(couriers) : pick(companies);
      const names = Array.from({ length: size }, (_, k) => (type === 'delivery' && k === 0 ? pick(['Quinn Courier', 'Morgan Delivery', 'Drew Driver']) : pick(visitorNames)));
      const folder = groupFolder({ visitType: type, plate, leadName: names[0], checkedInAt: ts, zone });
      let folderName = folder.name;
      let folderPath = folder.relDir();
      for (let n = 2; usedFolders.has(folderPath); n++) { folderName = `${folder.name}_${n}`; folderPath = folder.relDir(`_${n}`); }
      usedFolders.add(folderPath);
      const hostId = type === 'meeting' || (type === 'customer' && rand() < 0.5) || (type === 'delivery' && rand() < 0.5) ? emp.id : null;
      const purpose = type === 'meeting' ? pick(['Supplier review', 'Quarterly meeting', 'Equipment demo', 'Interview']) : type === 'delivery' ? pick(['Packaging materials', 'Raw milk', 'Spare parts', 'Finished goods collection']) : type === 'customer' ? pick(['Product tasting', 'Bulk order discussion', null]) : 'Site inspection';
      const poNumber = type === 'delivery' && rand() < 0.8 ? `PO-${45000000 + Math.floor(rand() * 9999)}` : null;
      const groupId = crypto.randomUUID();
      await db('visit_groups').insert({
        id: groupId, group_no: ++groupNo, visit_type: type, direction: type === 'delivery' ? (purpose === 'Finished goods collection' ? 'collection' : 'delivery') : null,
        host_employee_id: hostId, host_name_text: null, department_id: type === 'delivery' ? depIds['Warehouse & Logistics'] : null,
        purpose, delivery_company: type === 'delivery' ? company : null, sales_reference: null,
        vehicle_plate: plate, vehicle_plate_norm: plate ? normalizePlate(plate) : null, po_number: poNumber, invoice_number: null, notes: null,
        folder_name: folderName, folder_path: folderPath, purged: false, checked_in_at: ts, checked_in_by: userIds.guard,
        idempotency_key: crypto.randomUUID(), created_at: ts, updated_at: ts,
      });
      for (let k = 0; k < size; k++) {
        const hasId = rand() < 0.92;
        const idNumber = hasId ? demoEmiratesId(idSeq++) : null;
        const visitorId = crypto.randomUUID();
        await db('visitors').insert({
          id: visitorId, full_name: names[k], nationality: null, company,
          phone: null, id_document_type: hasId ? 'emirates_id' : 'none', id_number_masked: maskIdNumber(idNumber),
          id_number_hash: idNumber ? ctx.ids.hash(idNumber) : null, id_number_encrypted: null,
          id_expiry_date: hasId ? '2029-12-31' : null, purged: false, created_at: ts, updated_at: ts,
        });
        await db('visits').insert({
          id: crypto.randomUUID(), reference_no: ++ref, visitor_id: visitorId, visit_type: type, status: outAt ? 'checked_out' : 'on_site',
          host_employee_id: hostId, host_name_text: null,
          department_id: type === 'delivery' ? depIds['Warehouse & Logistics'] : null,
          purpose, delivery_company: type === 'delivery' ? company : null,
          sales_reference: type === 'customer' && rand() < 0.5 ? `SO-${10000 + Math.floor(rand() * 9000)}` : null,
          vehicle_plate: plate, badge_number: String(100 + (ref % 50)), notes: null,
          id_status: hasId ? 'scanned' : 'not_provided', id_scan_method: hasId ? 'camera_ocr' : null, id_verification_ref: null,
          privacy_notice_ack: true, checked_in_at: ts, checked_in_by: userIds.guard,
          checked_out_at: outAt ? outAt.toUTC().toISO() : null, checked_out_by: outAt ? userIds.guard : null,
          checkout_method: outAt ? 'gate' : null, checkout_note: null, idempotency_key: crypto.randomUUID(),
          group_id: groupId, group_role: type === 'delivery' ? (k === 0 ? 'driver' : 'helper') : 'visitor', group_position: k + 1,
          created_at: ts, updated_at: ts,
        });
      }
      // Demo documents for vehicle visits (clearly marked DEMO; no identity-card images are generated).
      if (type === 'delivery' && poNumber && dayOffset < 10) {
        const pdf = demoPdf([`DEMO PURCHASE ORDER - FICTIONAL`, `PO No: ${poNumber}`, `Supplier: ${company}`, `Vehicle: ${plate}`]);
        const fileName = fileBaseName({ kind: 'po', ext: 'pdf', index: 1, plate, docNumber: poNumber });
        await ctx.files.put(`${folderPath}/${fileName}`, pdf);
        await db('files').insert({
          id: crypto.randomUUID(), group_id: groupId, visit_id: null, kind: 'po', file_name: fileName, storage_path: `${folderPath}/${fileName}`,
          mime: 'application/pdf', size_bytes: pdf.length, sha256: crypto.createHash('sha256').update(pdf).digest('hex'), doc_number: poNumber,
          ocr_text: `DEMO PURCHASE ORDER ${poNumber} ${company}`, sp_status: 'disabled', sp_attempts: 0, uploaded_by: userIds.guard, created_at: ts,
        });
      }
    }
  }

  // A demo gate tablet with an enrolment code (valid 24 h).
  const { enrollmentCode } = await createDevice(ctx, { id: userIds.admin, username: 'admin' }, { name: 'Main gate tablet (demo)' });
  return { users: users.map((u) => u[0]), enrollmentCode };
}

/** Minimal one-page PDF with a few lines of text (demo documents only). */
function demoPdf(lines: string[]): Buffer {
  const esc = (t: string) => t.replace(/[\\()]/g, (c) => `\\${c}`);
  const text = lines.map((l, i) => `BT /F1 ${i === 0 ? 18 : 13} Tf 60 ${760 - i * 28} Td (${esc(l)}) Tj ET`).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
