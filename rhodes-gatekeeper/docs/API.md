# Rhodes Gatekeeper — API reference

Base path `/api`. JSON in and out. Every `POST`/`PUT`/`PATCH` must include `X-Requested-With: RhodesGatekeeper`.

Two kinds of session:
* **Web app** (reception, manager, admin): cookie `rg_session` from `POST /auth/login`.
* **Gate tablet** (guard): `Authorization: Bearer <token>` from `POST /auth/mobile/login`, which requires an
  enrolled device (`X-Device-Id`, `X-Device-Secret`). Cookies are never accepted as tablet sessions and vice versa.

Errors: `{ "error": { "code": "VALIDATION_ERROR", "message": "…", "details": { "fields": { "purpose": "…" } } } }`
Common codes: `UNAUTHORIZED` 401 · `FORBIDDEN` 403 · `PASSWORD_CHANGE_REQUIRED` 403 · `CSRF` 403 ·
`NOT_FOUND` 404 · `ALREADY_ON_SITE` 409 · `ALREADY_CHECKED_OUT` 409 · `LAST_ADMIN` 409 · `ACCOUNT_LOCKED` 423 · `RATE_LIMITED` 429.

Dates in query strings (`from`, `to`) are **local calendar dates in the company timezone** (`YYYY-MM-DD`);
`month` is `YYYY-MM`. All timestamps in responses are UTC ISO-8601.

## Authentication

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/auth/login` | public (rate-limited) | `{username, password}` → sets cookie; returns user + permissions |
| POST | `/auth/logout` | any | revokes the session |
| GET | `/auth/me` | signed in | user, permissions, public app settings (site, timezone, privacy notice, visit types, email mode) |
| POST | `/auth/change-password` | signed in | `{currentPassword, newPassword}` |
| POST | `/device/enroll` | public (rate-limited) | `{code, platform, appVersion}` → `{deviceId, deviceSecret, deviceName}` (code is single use, 24 h) |
| POST | `/auth/mobile/login` | enrolled device | `{username, password}` + device headers → `{token, user, permissions}` — guards only |
| GET | `/health` | public | `{status:"ok"}` when the database answers |

## Gate (guard, tablet app)

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/visit-groups` | `visit.create` | **Group check-in** (one or more people). 201 / 200 on idempotent replay. Returns `{group, visits[], warnings, required}` |
| POST | `/visit-groups/:id/files` | `files.upload` | `{kind: id_front\|id_back\|plate\|po\|invoice\|document, visitId?, dataBase64, docNumber?, ocrText?}` — within 24 h of check-in; identical bytes are de-duplicated |
| GET | `/visit-groups/:id` | `files.upload` | group + file names (to resume uploads); no file contents |
| POST | `/visit-groups/:id/check-out` | `visit.checkout` | check out everyone still on site in the group |
| POST | `/scan/parse-ocr` | `scan.parse` | `{front?, back?}` OCR text of the ID photos → suggested fields + on-site / repeat-visitor lookup |
| POST | `/scan/parse-plate` | `scan.parse` | `{text}` → plate suggestions |
| POST | `/scan/parse-document` | `scan.parse` | `{text}` → `{poNumber?, invoiceNumber?, kind?}` |

Group body: `{idempotencyKey, visitType, direction?, visitors: [{fullName, company?, phone?, nationality?, badgeNumber?, role?, id:{documentType, status, method?, number?, expiryDate?}}], hostEmployeeId?, hostName?, departmentId?, purpose?, deliveryCompany?, salesReference?, vehiclePlate?, poNumber?, invoiceNumber?, notes?, privacyNoticeAck}`.
Deliveries require `vehiclePlate`. The first visitor of a delivery is the driver.

## Gate — single-visitor and shared endpoints

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/scan/parse` | `scan.parse` | `{raw}` → `{parsed, lookup, verificationAvailable}`. Raw data is not stored or logged |
| POST | `/scan/lookup` | `scan.parse` | `{idNumber}` → previous visitor details / open visit for manual entry |
| GET | `/directory/employees?q=` | `directory.read` | active employees (no contact details) |
| GET | `/directory/departments` | `directory.read` | active departments |
| POST | `/visits` | `visit.create` | check-in (body below). 201 created · 200 idempotent replay |
| GET | `/visits/on-site` | `visit.view_onsite` | open visits, masked IDs only |
| POST | `/visits/:id/check-out` | `visit.checkout` | `{note?}` |
| GET | `/events` | `visit.view_onsite` | Server-Sent Events `visit` → `{type, visitId, at}` (no personal data) |

Check-in body:

```json
{
  "idempotencyKey": "uuid generated once per check-in form",
  "visitType": "meeting | delivery | customer | other",
  "visitor": { "fullName": "…", "company": "…", "phone": "…", "nationality": "ARE" },
  "id": { "documentType": "emirates_id | passport | other | none", "status": "scanned | manual | not_provided",
          "method": "camera_barcode | hardware_reader | manual", "number": "784-…", "expiryDate": "YYYY-MM-DD" },
  "hostEmployeeId": "uuid", "hostName": "free text if not in directory", "departmentId": "uuid",
  "purpose": "…", "deliveryCompany": "…", "salesReference": "…",
  "vehiclePlate": "…", "badgeNumber": "…", "notes": "…", "privacyNoticeAck": true
}
```

Rules: meeting → host + purpose; delivery → deliveryCompany + purpose + (host or department);
customer → nothing extra; other → purpose. ID number required unless `status = not_provided`
(which site policy may forbid). Emirates ID numbers must match `784` + 12 digits.

## Staff (reception and admin)

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/visits?from&to&month&status&visitType&employeeId&departmentId&q&limit&offset` | `visit.view_all` | `{items, total}` |
| GET | `/visits/:id` | `visit.view_all` | full record (masked ID) |
| PATCH | `/visits/:id` | `visit.edit` | visitor name/company/phone, host, department, purpose, references, badge, plate, notes. ID fields are not editable |
| POST | `/visits/:id/manual-check-out` | `visit.manual_checkout` | `{checkedOutAt (ISO), reason}` — flagged `manual_correction` |
| GET | `/visits/:id/notifications` | `visit.view_all` | email delivery status |
| POST | `/visits/:id/reveal-id` | `visitor.view_sensitive` (admin) | `{reason}`; only if a full number was stored; audited |
| GET | `/dashboard?from&to` | `report.view` | on-site, today, selected range, by type/department/employee, not checked out |
| GET | `/reports/summary?month` or `?from&to` + `employeeId, departmentId, visitType` | `report.view` | totals and groupings with duration stats |
| GET | `/reports/export.csv` (same filters) | `report.export` | CSV download; audited |
| GET | `/search?q=` | `search.use` | visits, folders and files — names, V/G IDs, full ID number (hash match, audited), plate, PO/invoice, file names, document text |
| GET | `/folders?from&to&q&type=visitors\|vehicles` | `files.view` | visit folders |
| GET | `/folders/:id` | `files.view` | group, people, files, `canViewIdImages`, `canDownload` |
| GET | `/folders/:id/download.zip` | `files.download` (manager, admin) | ZIP of the folder; ID images only if allowed; audited |
| GET | `/files/:id/content` | `files.view`; ID images need `files.view_id` | decrypted file; ID image views audited |

## Administration (admin)

| Method | Path | Permission |
|---|---|---|
| GET/POST | `/admin/users` · PATCH `/admin/users/:id` | `user.manage` |
| GET/POST | `/admin/departments` · PATCH `/admin/departments/:id` | `directory.manage` |
| GET/POST | `/admin/employees?q` · PATCH `/admin/employees/:id` | `directory.manage` |
| GET/PUT | `/admin/settings` | `settings.manage` |
| GET | `/admin/notification-rules` · PUT `/admin/notification-rules/:visitType` | `settings.manage` |
| GET | `/admin/notifications?status` · POST `/admin/notifications/:id/retry` | `settings.manage` |
| GET | `/admin/audit?action&entityId&limit&offset` | `audit.view` |
| POST | `/admin/retention/run` | `retention.run` |
| GET/POST | `/admin/devices` · POST `/admin/devices/:id/new-code` · POST `/admin/devices/:id/revoke` | `device.manage` |
| GET | `/admin/sharepoint` · POST `/admin/sharepoint/retry` | `files.manage_sync` |

The authoritative role → permission matrix is `server/src/domain/permissions.ts`; the test
`server/tests/permissions.test.ts` asserts the expected status code for every role on representative endpoints.
