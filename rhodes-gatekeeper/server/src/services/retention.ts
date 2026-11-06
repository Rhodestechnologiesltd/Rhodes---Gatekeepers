import type { AppContext } from '../context.js';
import type { AuditActor } from './audit.js';
import { nowIso } from '../db/knex.js';
import { deleteFiles, queueSpDeletion } from './files.js';

/**
 * Applies the company's configured retention policy.
 *  - ID-card images older than `idImageDays` are deleted (disk + SharePoint), even if the visit is kept.
 *  - anonymize: visitor personal data on old finished visits is removed and the visit folder's files are
 *    deleted; visit type, times, host, department, vehicle plate and PO/invoice numbers are kept so
 *    historical counts and durations remain available.
 *  - delete: old visits, their visitors, groups and files are deleted entirely.
 * Also prunes old audit logs, notification bodies and expired sessions. Visitors still on site are never purged.
 */
export async function runRetention(ctx: AppContext, actor: AuditActor, opts: { force?: boolean } = {}) {
  const s = await ctx.settings.get();
  const result = {
    visitorsAffected: 0, filesDeleted: 0, idImagesDeleted: 0, auditLogsDeleted: 0, notificationsDeleted: 0, sessionsDeleted: 0,
    mode: s.retention.mode, ran: false,
  };

  result.sessionsDeleted = await ctx.db('sessions').where('expires_at', '<', nowIso()).del();
  if (!s.retention.enabled && !opts.force) return result;
  result.ran = true;

  const now = ctx.now().getTime();
  const days = (n: number) => new Date(now - n * 86400_000).toISOString();
  const visitorCutoff = days(s.retention.visitorDataDays);

  // 1. Identity-card images past their own (usually shorter) period.
  const oldIds = await ctx.db('files as f').join('visit_groups as g', 'g.id', 'f.group_id')
    .whereIn('f.kind', ['id_front', 'id_back']).whereNull('f.deleted_at').where('g.checked_in_at', '<', days(s.retention.idImageDays))
    .whereNotExists(ctx.db('visits').whereRaw('visits.group_id = g.id').where('status', 'on_site'))
    .pluck('f.id');
  result.idImagesDeleted = await deleteFiles(ctx, oldIds, 'retention: identity image period');

  // 2. Groups whose visits are all finished and older than the visitor-data period.
  const oldGroups: { id: string; folder_path: string; sp_folder_item_id: string | null }[] = await ctx.db('visit_groups as g')
    .where('g.checked_in_at', '<', visitorCutoff).where('g.purged', false)
    .whereNotExists(ctx.db('visits').whereRaw('visits.group_id = g.id').where('status', 'on_site'))
    .select('g.id', 'g.folder_path', 'g.sp_folder_item_id');
  for (const g of oldGroups) {
    const fileIds = await ctx.db('files').where({ group_id: g.id }).whereNull('deleted_at').pluck('id');
    result.filesDeleted += await deleteFiles(ctx, fileIds, 'retention: visitor data period');
    await ctx.files.removeDir(g.folder_path).catch(() => undefined);
    if (g.sp_folder_item_id) await queueSpDeletion(ctx, g.sp_folder_item_id);
  }

  await ctx.db.transaction(async (trx) => {
    const old = trx('visits').select('visitor_id').where('checked_in_at', '<', visitorCutoff).andWhere('status', 'checked_out');
    if (s.retention.mode === 'delete') {
      const ids = (await old).map((r: { visitor_id: string }) => r.visitor_id);
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        await trx('notifications').whereIn('visit_id', trx('visits').select('id').whereIn('visitor_id', chunk)).del();
        await trx('visits').whereIn('visitor_id', chunk).del();
        result.visitorsAffected += await trx('visitors').whereIn('id', chunk).del();
      }
      for (const g of oldGroups) {
        if (!(await trx('visits').where({ group_id: g.id }).first())) await trx('visit_groups').where({ id: g.id }).del();
      }
    } else {
      result.visitorsAffected = await trx('visitors')
        .whereIn('id', old)
        .andWhere('purged', false)
        .update({
          full_name: 'Anonymised visitor', company: null, phone: null, nationality: null,
          id_number_masked: null, id_number_hash: null, id_number_encrypted: null, id_expiry_date: null,
          purged: true, updated_at: nowIso(),
        });
      await trx('visits')
        .whereIn('visitor_id', trx('visitors').select('id').where('purged', true))
        .update({ notes: null, badge_number: null });
      await trx('notifications')
        .whereIn('visit_id', trx('visits').select('id').whereIn('visitor_id', trx('visitors').select('id').where('purged', true)))
        .del();
      // Folder names contain the lead visitor's name — replace with a neutral one.
      for (const g of oldGroups) {
        const row = await trx('visit_groups').where({ id: g.id }).first();
        await trx('visit_groups').where({ id: g.id }).update({
          purged: true, notes: null, sp_folder_item_id: null,
          folder_name: row.visit_type === 'delivery' && row.vehicle_plate ? row.folder_name : `ANONYMISED_G${row.group_no}`,
          updated_at: nowIso(),
        });
      }
    }
    result.notificationsDeleted += await trx('notifications').where('created_at', '<', days(s.retention.notificationDays)).del();
    result.auditLogsDeleted = await trx('audit_logs').where('at', '<', days(s.retention.auditLogDays)).del();
    await ctx.audit.log(actor, 'retention.run', { type: 'system' }, { ...result }, trx);
  });
  return result;
}
