# Rhodes Gatekeeper

Visitor and vehicle management for the gate of an ice cream manufacturing site.
Built by Rhodes Technologies Ltd — *Securing your business*.

| App | Who uses it | Where |
|---|---|---|
| **Gate tablet app** (Android + iOS) | Security guards | Enrolled tablets at the gate. Check people and vehicles in and out, photograph Emirates IDs, number plates and POs/invoices. |
| **Web app** | Reception, managers, administrators | Office browsers. Dashboard, reports, visit records, folders, search, administration. **Not used at the gate.** |

Both apps talk to one server (Node.js + PostgreSQL). Brand colours: red `#D7282F`, teal `#003b4a`, grey `#636569`.

Screenshots: [`docs/screenshots/`](docs/screenshots/).

---

## 1. What it does

### At the gate (tablet app)
1. **Choose the visit type:** meeting, delivery/collection, customer, or other.
2. **Add each person.** Photograph the **front** and **back** of the Emirates ID. The text is read **on the tablet** (Google ML Kit OCR), and the form fills itself:
   * name, ID number, nationality and card expiry, taken from the 3-line machine-readable zone on the back (check digits are validated) and from the printed front;
   * a returning visitor's company and phone number;
   * a warning if the card has expired, if the scan doesn't validate, or if the person is **already on site**, with a one-tap "check out previous".

   The guard confirms or corrects the details and enters the visitor pass number. **Groups:** add as many people as needed (default limit 25). **Each person gets their own Visitor ID** (e.g. `V1295`); the group gets a Group ID (`G1184`).
3. **Vehicles (deliveries and collections)** — driver first, then helpers, the same way. Then:
   * choose delivering or collecting;
   * photograph the **number plate**; the plate is read and suggested (e.g. `DUBAI A 12345`) for the guard to confirm;
   * photograph the **purchase order and/or invoice**; the PO or invoice number is read and suggested.
4. **Host, department and purpose**, privacy notice acknowledgement, then **Check in**.
5. Photos upload into the visit's **folder**. If the network drops or the app is closed, they stay queued on the tablet and resume automatically.
6. **Check out:** one person at a time, or **"Check out all"** for a group or truck crew.

### Folders (automatic names)
```
Visitors/2026/11/NADIA-SAMPLE-EXAMPLE_2026-11-04_1748/
    V1295_NADIA-SAMPLE-EXAMPLE_EID-front.jpg
    V1295_NADIA-SAMPLE-EXAMPLE_EID-back.jpg
    V1296_SAM-VISITOR_EID-front.jpg
    V1296_SAM-VISITOR_EID-back.jpg
Vehicles/2026/11/DUBAI-A-12345_2026-11-04_1748/
    DUBAI-A-12345_plate_1.jpg
    DUBAI-A-12345_PO-45009876_1.jpg
    DUBAI-A-12345_INVOICE-INV-77_1.pdf
    V1297_DRIVER_JOHN-TEST-DRIVER_EID-front.jpg
    V1297_DRIVER_JOHN-TEST-DRIVER_EID-back.jpg
```
* **Visitor folders** are named after the lead visitor; **vehicle folders** after the number plate. Both include the date and time in the company timezone.
* Retakes are numbered (`EID-front-2`). Two arrivals in the same minute get `_2`.
* Names are safe for Windows, macOS and SharePoint.
* Files are stored **encrypted** on the server (AES-256-GCM) and, if enabled, **copied to SharePoint** with the same folder structure.

### Search (web app)
One box, in the header of every page, finds:
* visitor **names**, companies, delivery companies and pass numbers;
* **Visitor ID** (`V1295`) and **Group ID** (`G1184`);
* a full **Emirates ID number**, matched by keyed hash because numbers are not stored in clear; this search is audited;
* **number plates**, ignoring spaces and dashes (`dubai a-12345` works);
* **PO and invoice numbers**;
* **folder and file names**, and the text of photographed POs and invoices.

### Web app pages
* **Dashboard** (live): on site now, vehicles on site, visitors today and in a chosen range, visitors who haven't checked out, and visits by type, department and employee.
* **Visits**: search, edit, record a missed check-out, open the folder.
* **Folders**: browse by date or type, see photos, download the whole folder as a ZIP.
* **Reports**: monthly or date range, filtered by employee, department and type, with CSV export.
* **Admin**: users, employees and departments, **gate tablets**, settings, audit log.

---

## 2. Roles

| | Guard | Reception | Manager | Admin |
|---|:-:|:-:|:-:|:-:|
| Signs in on | **tablet only** | web only | web only | web only |
| Check in / out, photograph IDs, plates, documents | ✅ | | | |
| Visit records, dashboard, reports, CSV, search | | ✅ | ✅ | ✅ |
| See plate photos and PO/invoice documents | | ✅ | ✅ | ✅ |
| **Open ID card photos** (every view audited) | | | ✅ | ✅ |
| Download a folder as ZIP (audited) | | | ✅ | ✅ |
| Audit log | | | ✅ | ✅ |
| Users, employees, tablets, settings, retention, SharePoint status | | | | ✅ |

All of this is enforced by the server on every request (`server/src/domain/permissions.ts`).
* A guard cannot sign in on the web.
* Office staff cannot sign in on a tablet.
* A tablet must be **enrolled** by an administrator first, and **revoking** it signs it out immediately.

---

## 3. Running it on your Mac

You need **Node.js 22** (from https://nodejs.org) and the Terminal app.

```bash
cd ~/Downloads/rhodes-gatekeeper
npm run install:all
cp .env.example .env
npm run seed          # fictional demo data — prints a tablet enrolment code
npm run build
npm start             # web app at http://localhost:8080
```

Demo accounts, all with the password `Gatekeeper-Demo-2026`:
* **admin**
* **manager**
* **reception**
* **guard** (tablet only)

### Try the tablet app in a browser (no phone needed)
In a **second** Terminal tab:
```bash
cd ~/Downloads/rhodes-gatekeeper
npm run dev:tablet    # tablet app at http://localhost:5174
```
1. Open http://localhost:5174.
2. Enter `http://localhost:8080` as the server, plus the enrolment code that `npm run seed` printed. To get a new code: in the web app, sign in as admin → **Tablets** → **Add tablet**.
3. Sign in as **guard**.

In a browser, "take photo" opens a file picker, and OCR runs with Tesseract.js inside the page. On real tablets it uses the camera and Google ML Kit.

---

## 4. Building the Android and iOS apps (on your Mac)

The tablet app is built with **Capacitor**. The native projects are already in `web/android` and `web/ios`.

### Before you start
* **Android:** install [Android Studio](https://developer.android.com/studio). Open it once so it installs the Android SDK.
* **iOS:** install **Xcode** from the Mac App Store. Open it once, accept the licence, and sign in with your Apple Developer account (Xcode → Settings → Accounts).
  Also install **CocoaPods**, which Google's ML Kit OCR library needs: `brew install cocoapods` (or `sudo gem install cocoapods`).

### Set the server address baked into the app (optional)
Guards can type the server address at first launch. To pre-fill it, create `web/.env.production.local`:
```
VITE_SERVER_URL=https://gatekeeper.yourcompany.com
```

### Android
```bash
npm run android
```
This builds the app bundle, copies it into the Android project and opens Android Studio.
1. Connect a tablet with USB debugging on, or start an emulator, then press **Run ▶**.
2. For an installable file: **Build → Generate Signed App Bundle / APK…** Create a keystore, keep it safe, and choose **APK** to side-load or **AAB** for Google Play / Managed Google Play.

### iOS (iPad)
```bash
npm run ios
```
This opens Xcode.
1. Select the **App** target → **Signing & Capabilities** and choose your **Team**. Change the Bundle Identifier if `mu.rhodes.gatekeeper` is taken.
2. Pick a **connected iPad** and press **Run ▶**.
   > Google ML Kit (the on-device OCR) does not run in the iOS Simulator on Apple-silicon Macs. Use a real iPad to test scanning. In the simulator the rest of the app works, and the guard types the details.
3. For distribution: **Product → Archive**, then **Distribute App** for TestFlight, App Store, or Ad Hoc / Enterprise via MDM.

### After code changes
Run `npm run android` or `npm run ios` again. This rebuilds and syncs.

### Requirements for real tablets
* The server must be reachable over **HTTPS** with a valid certificate. iOS refuses plain HTTP, and the camera needs a secure origin.
* Camera permission is requested the first time a guard takes a photo.
* Photos are **never saved to the tablet's photo library**. Pending uploads sit in the app's private storage until sent.
* The server address, device credentials and session token are kept in the **iOS Keychain / Android Keystore**.

---

## 5. Microsoft 365: email and SharePoint

Both use one Entra ID **app registration** (Azure portal → Entra ID → App registrations).

### Email (arrival notifications)
1. **API permissions → Microsoft Graph → Application → `Mail.Send`** → grant admin consent.
2. Restrict the app to one sender mailbox (Exchange **RBAC for Applications** / Application Access Policy).
3. Set these in `.env`:
   * `EMAIL_PROVIDER=graph`
   * `M365_TENANT_ID`
   * `M365_CLIENT_ID`
   * `M365_CLIENT_SECRET`
   * `M365_SENDER_ADDRESS`

A group generates **one** email listing everyone, with Visitor IDs and passes. Deliveries also show the plate and the PO/invoice number.

### SharePoint copy of folders
1. Create a SharePoint site or document library, e.g. *Gate Records*. Limit membership to people allowed to see visitor ID documents.
2. **API permissions → Microsoft Graph → Application → `Sites.Selected`** → grant admin consent.
3. Grant the app **write** access to that one site, as a SharePoint/Graph admin, using Graph:
   `POST https://graph.microsoft.com/v1.0/sites/{site-id}/permissions` with
   `{"roles":["write"],"grantedToIdentities":[{"application":{"id":"<client-id>","displayName":"Rhodes Gatekeeper"}}]}`
4. Find the library's **drive ID**: `GET https://graph.microsoft.com/v1.0/sites/{site-id}/drives` (Graph Explorer works).
5. Set these in `.env`:
   * `SHAREPOINT_ENABLED=true`
   * `SHAREPOINT_DRIVE_ID=<drive id>`
   * optionally, `SHAREPOINT_BASE_PATH` (default `Rhodes Gatekeeper`)

The server keeps the master copy. Each file is queued and copied to `<base>/Visitors|Vehicles/YYYY/MM/<folder>/<file>`, and failed uploads retry with back-off. **Settings → Integrations** shows copied, waiting and failed counts, with **Retry**. When the retention policy deletes files, their SharePoint copies are deleted too.

---

## 6. Privacy and security

* **ID card photos are stored because the company asked for them.** They are:
  * encrypted at rest on the server;
  * visible only to managers and administrators;
  * never loaded as thumbnails;
  * **audited every time they are opened** (user, time, file);
  * deleted after a configurable period (`Delete ID card photos after … days`, default 180).

  Admins can turn ID photo storage off in **Settings → ID, photos & privacy**.
* The text OCR reads from ID cards is **not stored**. Date of birth is shown to the guard but not saved. Full ID numbers are kept only as a masked value plus a keyed hash, unless full storage is explicitly enabled.
* Reading a card **does not verify it**. IDs are labelled "Read from card" / "scanned", never "verified", and guards are reminded to compare the photo with the person.
* **Retention** (Settings → Data retention):
  * visitor data and folders are anonymised or deleted after *N* days (on-site visitors are never purged);
  * ID photos follow their own, usually shorter, period;
  * the audit log and email records are pruned.
* **Sign-in and requests:**
  * tablets use device-bound bearer tokens, and the web uses `HttpOnly; SameSite=Strict; Secure` cookies;
  * CSRF header, strict CSP, rate-limited login, lock-out after 5 failures;
  * uploads are checked by content type (JPEG/PNG/WebP/PDF only).
* **The audit log** records sign-ins, check-ins and outs, edits, uploads, ID photo views, ID-number searches, ZIP downloads, exports, and tablet enrolment and revocation.

> The app provides configuration points for retention, privacy wording and access. The company must decide and approve its own policies; the app does not by itself make it compliant with any law.

---

## 7. Tests

```bash
npm test                     # 111 automated server tests (SQLite, ~25 s)
TEST_DATABASE_URL=postgres://user:pass@host/test_db npm --prefix server run test:pg   # same suite on PostgreSQL (wipes that DB)
npm run typecheck
```
The tests cover:
* **Check-in:**
  * group check-in (one Visitor ID per person, one folder, one email);
  * deliveries (driver and helpers, plate folder, direction);
  * duplicate IDs within a group, people already on site, group size limit;
  * idempotent retries, individual and whole-group check-out.
* **Files:**
  * automatic file names and retake numbering;
  * encryption on disk, duplicate-upload de-duplication;
  * rejected disguised files, the 24-hour upload window, the ID-photo switch;
  * manager-only ID photo access with audit;
  * ZIP contents.
* **Search:** names, V/G IDs, full Emirates ID (audited), plate, PO, file name and document text.
* **Tablets:** enrolment (single-use codes), revocation, cookie and bearer separation, CORS.
* **SharePoint:**
  * queue and retry, correct paths;
  * Graph simple and chunked uploads, with no auth header on the upload-session URL.
* **Retention:** ID photos deleted early, folder anonymised later.
* **OCR parsing:** MRZ repaired from noisy OCR text, front-side fields, plate formats for all emirates, PO and invoice numbers.
* **Everything from version 1:**
  * permissions, CSRF, cookies, lock-out;
  * durations and timezones, CSV safety;
  * notifications and Graph email.

The tablet and web apps were also driven end to end in a headless browser against the real server. That run covered:
* enrolling a tablet and signing in as a guard;
* OCR of specimen ID cards, a number plate and a PO;
* a 2-person group and a truck collection, with all photos uploaded;
* group check-out;
* the guard being refused on the web;
* manager search, folder view, ID photo view and ZIP download;
* reception being locked out of ID photos.

---

## 8. Deployment

```bash
cp .env.example .env     # NODE_ENV=production, DATA_ENCRYPTION_KEY, M365_*, SHAREPOINT_*, POSTGRES_PASSWORD
docker compose up -d --build
docker compose exec app node dist/db/cli.js create-admin
```
* Put an HTTPS reverse proxy in front of port 8080.
* **Back up both** the PostgreSQL volume and the `files` volume, plus `DATA_ENCRYPTION_KEY` in a secrets manager. Files cannot be decrypted without it.
* Then:
  1. Sign in as admin.
  2. Add employees and departments.
  3. **Tablets → Add tablet**, and enter the code on each gate tablet.
  4. Create guard accounts.
  5. Review **Settings**: privacy notice, ID photo policy, retention, notification rules.

---

## 9. Before go-live — items the company must confirm

1. **Approval to store ID card photos.** This version stores them because it was requested. Confirm the retention period and who may view them (default: managers and admins).
2. **OCR on your actual cards and tablets.** Test with real Emirates IDs in gate lighting. OCR quality depends on the camera and glare, and the guard must always check the result.
3. **SharePoint site, permissions and drive ID.** Decide who has access to the library.
4. **Tablet management (MDM).** Kiosk mode, app distribution (Managed Google Play / Apple Business Manager), screen lock.
5. **Privacy notice wording.** The shipped text is a placeholder.
6. **Microsoft 365 email setup** and notification recipients per visit type.
7. **UAE identity verification.** None is integrated; cards are read, not verified.
8. **Number-plate formats** for foreign trucks (Oman, KSA…). The guard types those; suggestions cover UAE plates.

API reference: [`docs/API.md`](docs/API.md) · Database schema: [`docs/SCHEMA.md`](docs/SCHEMA.md)
