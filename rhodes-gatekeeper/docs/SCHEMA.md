# Rhodes Gatekeeper — database schema

Defined as code in `server/src/db/migrations.ts` (Knex; runs on PostgreSQL and SQLite). Migrations run
automatically at start-up and with `npm --prefix server run migrate`. Add new migrations with a higher
prefix; never edit one that has been applied. Primary keys are UUID strings; timestamps are
`timestamptz` stored in UTC.

```
departments ─┐
             ├─< employees ─┐
             │              │ host_employee_id
users ───────┼──────────────┼─< visits >── visitors   (one visitor row per visit: a snapshot)
  (checked_in_by / out_by)  │      │
             └──────────────┘      └─< notifications
settings · notification_rules · sessions · audit_logs
```

| Table | Purpose | Notable columns |
|---|---|---|
| `departments` | Company departments | `name` (unique), `notification_email` (e.g. distribution list), `active` |
| `employees` | People who can host visitors | `full_name`, `email` (for notifications), `department_id`, `active` |
| `users` | App accounts | `username`, `role` (guard/reception/manager/admin), `password_hash` (scrypt), `must_change_password`, `failed_logins`, `locked_until` |
| `sessions` | Signed-in sessions | `id` = SHA-256 of the token (raw token never stored), `client` (web/mobile), `device_id`, `expires_at` (sliding) |
| `visitors` | Person details captured for one visit | `full_name`, `company`, `phone`, `nationality`, `id_document_type`, `id_number_masked`, `id_number_hash` (HMAC), `id_number_encrypted` (NULL unless approved), `id_expiry_date`, `purged` |
| `visits` | One person's visit (Visitor ID = `V` + `reference_no`) | `group_id`, `group_role` (visitor/driver/helper), `group_position`, `reference_no` (unique), `visit_type`, `status`, host/department, `purpose`, `delivery_company`, `sales_reference`, `vehicle_plate`, `badge_number`, `id_status`, `id_scan_method`, `privacy_notice_ack`, `checked_in_at/by`, `checked_out_at/by`, `checkout_method` (gate / manual_correction), `checkout_note`, `idempotency_key` (unique) |
| `notification_rules` | Per visit type email routing | `enabled`, `notify_host`, `notify_department`, `extra_recipients` (JSON), `notify_on_checkout` |
| `notifications` | Transactional email outbox | `recipients`, `subject`, bodies, `status` (pending/sent/failed/skipped), `attempts`, `last_error`, `next_attempt_at`, `provider` |
| `settings` | Admin-editable configuration (JSON) | company/site, timezone, ID policy, privacy notice, overdue hours, retention, email footer |
| `visit_groups` | One arrival (a person, a group, or a vehicle crew) and its folder | `group_no` (G-ID), `visit_type`, `direction`, host, `vehicle_plate` + `vehicle_plate_norm` (search key), `po_number`, `invoice_number`, `folder_name`, `folder_path`, `sp_folder_item_id`, `purged` |
| `files` | Captured photos and documents | `group_id`, `visit_id` (for ID images), `kind`, auto-generated `file_name`, `storage_path` (encrypted blob), `mime`, `sha256`, `doc_number`, `ocr_text` (documents only), `sp_status` / `sp_item_id` (SharePoint copy), `deleted_at` |
| `devices` | Enrolled gate tablets | `enrollment_code_hash` (single use, 24 h), `secret_hash`, `platform`, `last_seen_at`, `revoked_at` |
| `sp_deletions` | SharePoint items to delete after retention | `item_id`, attempts, next attempt |
| `audit_logs` | Security audit trail | `at`, actor, `action`, entity, `details` (JSON, no ID numbers/values of edited fields), `ip` |

## What is deliberately *not* stored

* Raw scan strings and the OCR text of ID cards, dates of birth.
* ID card **images** are stored only while *Settings → Save photos of identity cards* is on (default on, as requested), encrypted (AES-256-GCM, key derived from `DATA_ENCRYPTION_KEY`), and deleted after the ID-image retention period.
* Full ID numbers — unless `ALLOW_FULL_ID_STORAGE=true` **and** the admin setting is enabled; then AES-256-GCM
  encrypted with a key derived (HKDF) from `DATA_ENCRYPTION_KEY`.
* Plain session tokens or passwords.

## Indexes

`visits(status)`, `visits(checked_in_at)`, `visits(host_employee_id)`, `visits(department_id)`,
`visits(visit_type)`, `visitors(id_number_hash)`, `visitors(full_name)`, `employees(full_name)`,
`notifications(status, next_attempt_at)`, `audit_logs(at)`, `audit_logs(action)`, `sessions(expires_at)`.
