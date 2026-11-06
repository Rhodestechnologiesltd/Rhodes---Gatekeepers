import type { Knex } from 'knex';

type Migration = { up: (k: Knex) => Promise<void>; down: (k: Knex) => Promise<void> };

const ts = (t: Knex.CreateTableBuilder, name: string) => t.timestamp(name, { useTz: true });

/**
 * Schema migrations. Add new migrations with a higher numeric prefix; never edit an applied one.
 * Works on PostgreSQL (production) and SQLite (development/tests).
 */
export const migrations: Record<string, Migration> = {
  '0001_initial_schema': {
    async up(k) {
      await k.schema.createTable('departments', (t) => {
        t.string('id', 36).primary();
        t.string('name', 120).notNullable().unique();
        t.string('notification_email', 254).nullable(); // e.g. a department distribution list
        t.boolean('active').notNullable().defaultTo(true);
        ts(t, 'created_at').notNullable();
        ts(t, 'updated_at').notNullable();
      });

      await k.schema.createTable('employees', (t) => {
        t.string('id', 36).primary();
        t.string('full_name', 160).notNullable();
        t.string('email', 254).nullable();
        t.string('phone', 40).nullable();
        t.string('job_title', 120).nullable();
        t.string('department_id', 36).nullable().references('id').inTable('departments').onDelete('SET NULL');
        t.boolean('active').notNullable().defaultTo(true);
        ts(t, 'created_at').notNullable();
        ts(t, 'updated_at').notNullable();
        t.index(['full_name']);
        t.index(['department_id']);
      });

      await k.schema.createTable('users', (t) => {
        t.string('id', 36).primary();
        t.string('username', 80).notNullable().unique();
        t.string('display_name', 160).notNullable();
        t.string('email', 254).nullable();
        t.string('role', 20).notNullable(); // guard | reception | admin
        t.string('password_hash', 255).notNullable();
        t.boolean('active').notNullable().defaultTo(true);
        t.boolean('must_change_password').notNullable().defaultTo(false);
        t.integer('failed_logins').notNullable().defaultTo(0);
        ts(t, 'locked_until').nullable();
        ts(t, 'last_login_at').nullable();
        ts(t, 'created_at').notNullable();
        ts(t, 'updated_at').notNullable();
      });

      await k.schema.createTable('sessions', (t) => {
        t.string('id', 64).primary(); // SHA-256 of the session token; raw token never stored
        t.string('user_id', 36).notNullable().references('id').inTable('users').onDelete('CASCADE');
        ts(t, 'created_at').notNullable();
        ts(t, 'expires_at').notNullable();
        ts(t, 'last_seen_at').notNullable();
        t.string('user_agent', 255).nullable();
        t.index(['user_id']);
        t.index(['expires_at']);
      });

      await k.schema.createTable('visitors', (t) => {
        t.string('id', 36).primary();
        t.string('full_name', 160).notNullable();
        t.string('nationality', 3).nullable(); // ISO 3166 alpha-3 as given by the document
        t.string('company', 160).nullable();
        t.string('phone', 40).nullable();
        t.string('id_document_type', 20).notNullable().defaultTo('none'); // emirates_id | passport | other | none
        t.string('id_number_masked', 40).nullable();
        t.string('id_number_hash', 64).nullable(); // HMAC-SHA256, for repeat-visitor lookup only
        t.text('id_number_encrypted').nullable(); // AES-256-GCM; only when explicitly enabled
        t.string('id_expiry_date', 10).nullable(); // YYYY-MM-DD as printed/encoded on the card
        t.boolean('purged').notNullable().defaultTo(false);
        ts(t, 'created_at').notNullable();
        ts(t, 'updated_at').notNullable();
        t.index(['id_number_hash']);
        t.index(['full_name']);
      });

      await k.schema.createTable('visits', (t) => {
        t.string('id', 36).primary();
        t.integer('reference_no').notNullable().unique(); // human-friendly badge/reference number
        t.string('visitor_id', 36).notNullable().references('id').inTable('visitors').onDelete('CASCADE');
        t.string('visit_type', 20).notNullable(); // meeting | delivery | customer | other
        t.string('status', 20).notNullable(); // on_site | checked_out
        t.string('host_employee_id', 36).nullable().references('id').inTable('employees').onDelete('SET NULL');
        t.string('host_name_text', 160).nullable(); // free text when host is not in the directory
        t.string('department_id', 36).nullable().references('id').inTable('departments').onDelete('SET NULL');
        t.string('purpose', 500).nullable();
        t.string('delivery_company', 160).nullable();
        t.string('sales_reference', 80).nullable();
        t.string('vehicle_plate', 40).nullable();
        t.string('badge_number', 40).nullable();
        t.string('notes', 1000).nullable();
        t.string('id_status', 20).notNullable(); // scanned | manual | verified | not_provided
        t.string('id_scan_method', 30).nullable(); // camera_barcode | hardware_reader | manual
        t.string('id_verification_ref', 120).nullable();
        t.boolean('privacy_notice_ack').notNullable().defaultTo(false);
        ts(t, 'checked_in_at').notNullable();
        t.string('checked_in_by', 36).nullable().references('id').inTable('users').onDelete('SET NULL');
        ts(t, 'checked_out_at').nullable();
        t.string('checked_out_by', 36).nullable().references('id').inTable('users').onDelete('SET NULL');
        t.string('checkout_method', 30).nullable(); // gate | manual_correction
        t.string('checkout_note', 500).nullable();
        t.string('idempotency_key', 64).notNullable().unique();
        ts(t, 'created_at').notNullable();
        ts(t, 'updated_at').notNullable();
        t.index(['status']);
        t.index(['checked_in_at']);
        t.index(['host_employee_id']);
        t.index(['department_id']);
        t.index(['visit_type']);
      });

      await k.schema.createTable('notification_rules', (t) => {
        t.string('visit_type', 20).primary();
        t.boolean('enabled').notNullable().defaultTo(true);
        t.boolean('notify_host').notNullable().defaultTo(true);
        t.boolean('notify_department').notNullable().defaultTo(false);
        t.text('extra_recipients').notNullable().defaultTo('[]'); // JSON array of emails / distribution lists
        t.boolean('notify_on_checkout').notNullable().defaultTo(false);
        ts(t, 'updated_at').notNullable();
      });

      await k.schema.createTable('notifications', (t) => {
        t.string('id', 36).primary();
        t.string('visit_id', 36).nullable().references('id').inTable('visits').onDelete('SET NULL');
        t.string('event', 30).notNullable(); // visit.checked_in | visit.checked_out
        t.text('recipients').notNullable(); // JSON array
        t.string('subject', 255).notNullable();
        t.text('body_html').notNullable();
        t.text('body_text').notNullable();
        t.string('status', 20).notNullable(); // pending | sent | failed | skipped
        t.string('provider', 20).nullable();
        t.integer('attempts').notNullable().defaultTo(0);
        t.string('last_error', 500).nullable();
        ts(t, 'next_attempt_at').nullable();
        ts(t, 'created_at').notNullable();
        ts(t, 'sent_at').nullable();
        t.index(['status', 'next_attempt_at']);
      });

      await k.schema.createTable('settings', (t) => {
        t.string('key', 80).primary();
        t.text('value').notNullable(); // JSON
        ts(t, 'updated_at').notNullable();
        t.string('updated_by', 36).nullable();
      });

      await k.schema.createTable('audit_logs', (t) => {
        t.string('id', 36).primary();
        ts(t, 'at').notNullable();
        t.string('actor_user_id', 36).nullable();
        t.string('actor_username', 80).nullable();
        t.string('action', 60).notNullable();
        t.string('entity_type', 40).nullable();
        t.string('entity_id', 36).nullable();
        t.text('details').nullable(); // JSON — never contains ID numbers
        t.string('ip', 64).nullable();
        t.index(['at']);
        t.index(['action']);
        t.index(['entity_type', 'entity_id']);
      });
    },
    async down(k) {
      for (const tbl of [
        'audit_logs', 'settings', 'notifications', 'notification_rules', 'visits',
        'visitors', 'sessions', 'users', 'employees', 'departments',
      ]) {
        await k.schema.dropTableIfExists(tbl);
      }
    },
  },

  /** Group visits, per-visit folders of captured files, and enrolled gate tablets. */
  '0002_groups_files_devices': {
    async up(k) {
      await k.schema.createTable('visit_groups', (t) => {
        t.string('id', 36).primary();
        t.integer('group_no').notNullable().unique();
        t.string('visit_type', 20).notNullable();
        t.string('direction', 20).nullable(); // delivery | collection (delivery visits only)
        t.string('host_employee_id', 36).nullable().references('id').inTable('employees').onDelete('SET NULL');
        t.string('host_name_text', 160).nullable();
        t.string('department_id', 36).nullable().references('id').inTable('departments').onDelete('SET NULL');
        t.string('purpose', 500).nullable();
        t.string('delivery_company', 160).nullable();
        t.string('sales_reference', 80).nullable();
        t.string('vehicle_plate', 40).nullable(); // as confirmed by the guard, e.g. "DUBAI A 12345"
        t.string('vehicle_plate_norm', 40).nullable(); // search key, e.g. "DUBAIA12345"
        t.string('po_number', 80).nullable();
        t.string('invoice_number', 80).nullable();
        t.string('notes', 1000).nullable();
        t.string('folder_name', 200).notNullable();
        t.string('folder_path', 300).notNullable(); // relative: Visitors/2026/11/<folder_name>
        t.string('sp_folder_item_id', 120).nullable();
        t.boolean('purged').notNullable().defaultTo(false);
        ts(t, 'checked_in_at').notNullable();
        t.string('checked_in_by', 36).nullable().references('id').inTable('users').onDelete('SET NULL');
        t.string('device_id', 36).nullable();
        t.string('idempotency_key', 64).notNullable().unique();
        ts(t, 'created_at').notNullable();
        ts(t, 'updated_at').notNullable();
        t.index(['checked_in_at']);
        t.index(['vehicle_plate_norm']);
        t.index(['po_number']);
        t.index(['invoice_number']);
        t.index(['folder_name']);
      });

      await k.schema.alterTable('visits', (t) => {
        t.string('group_id', 36).nullable().references('id').inTable('visit_groups').onDelete('CASCADE');
        t.string('group_role', 20).nullable(); // visitor | driver | helper
        t.integer('group_position').nullable(); // 1 = lead visitor / driver
        t.index(['group_id']);
      });

      await k.schema.createTable('files', (t) => {
        t.string('id', 36).primary();
        t.string('group_id', 36).notNullable().references('id').inTable('visit_groups').onDelete('CASCADE');
        t.string('visit_id', 36).nullable().references('id').inTable('visits').onDelete('SET NULL');
        t.string('kind', 20).notNullable(); // id_front | id_back | plate | po | invoice | document
        t.string('file_name', 200).notNullable(); // auto-generated, unique in the folder
        t.string('storage_path', 400).notNullable(); // relative path of the encrypted blob
        t.string('mime', 60).notNullable();
        t.integer('size_bytes').notNullable();
        t.string('sha256', 64).notNullable();
        t.string('doc_number', 80).nullable(); // PO / invoice number for documents
        t.text('ocr_text').nullable(); // documents only — never for identity cards
        t.string('sp_status', 20).notNullable().defaultTo('disabled'); // disabled | pending | synced | failed | pending_delete | deleted
        t.string('sp_item_id', 120).nullable();
        t.integer('sp_attempts').notNullable().defaultTo(0);
        t.string('sp_error', 500).nullable();
        ts(t, 'sp_next_attempt_at').nullable();
        ts(t, 'sp_synced_at').nullable();
        ts(t, 'deleted_at').nullable();
        t.string('uploaded_by', 36).nullable().references('id').inTable('users').onDelete('SET NULL');
        ts(t, 'created_at').notNullable();
        t.index(['group_id']);
        t.index(['visit_id']);
        t.index(['kind']);
        t.index(['doc_number']);
        t.index(['file_name']);
        t.index(['sp_status', 'sp_next_attempt_at']);
      });

      // SharePoint items (files or folders) waiting to be deleted after retention.
      await k.schema.createTable('sp_deletions', (t) => {
        t.string('id', 36).primary();
        t.string('item_id', 120).notNullable();
        t.integer('attempts').notNullable().defaultTo(0);
        t.string('last_error', 500).nullable();
        ts(t, 'next_attempt_at').notNullable();
        ts(t, 'created_at').notNullable();
      });

      await k.schema.createTable('devices', (t) => {
        t.string('id', 36).primary();
        t.string('name', 120).notNullable();
        t.string('enrollment_code_hash', 64).nullable();
        ts(t, 'enrollment_expires_at').nullable();
        t.string('secret_hash', 64).nullable();
        t.string('platform', 20).nullable();
        t.string('app_version', 40).nullable();
        ts(t, 'enrolled_at').nullable();
        ts(t, 'last_seen_at').nullable();
        ts(t, 'revoked_at').nullable();
        t.string('created_by', 36).nullable();
        ts(t, 'created_at').notNullable();
      });

      await k.schema.alterTable('sessions', (t) => {
        t.string('client', 10).notNullable().defaultTo('web'); // web | mobile
        t.string('device_id', 36).nullable();
      });
    },
    async down(k) {
      await k.schema.alterTable('sessions', (t) => {
        t.dropColumn('client');
        t.dropColumn('device_id');
      });
      await k.schema.dropTableIfExists('devices');
      await k.schema.dropTableIfExists('sp_deletions');
      await k.schema.dropTableIfExists('files');
      await k.schema.alterTable('visits', (t) => {
        t.dropIndex(['group_id']);
        t.dropForeign(['group_id']);
        t.dropColumn('group_id');
        t.dropColumn('group_role');
        t.dropColumn('group_position');
      });
      await k.schema.dropTableIfExists('visit_groups');
    },
  },
};
