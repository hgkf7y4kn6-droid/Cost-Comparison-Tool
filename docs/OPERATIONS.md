# Sales Hub — operations, security and data guide

What is stored where, how to back it up and get it back, who can see what, what
each number means, and what to check before real users go live. It describes what
the code does today; limitations are listed plainly in section 7.

## 1. Where data lives

| Data | Stored in | Shared across devices / people? | Survives clearing browser data? |
| --- | --- | --- | --- |
| Leads | Browser **and** server (SQLite, `$DATA_DIR/sales_hub.db`) | Yes — every signed-in rep sees and can edit all leads | Yes (re-synced from the server) |
| Accounts (incl. contacts, orders/invoices) | Browser **and** server | Owner + managers see everything; other reps see name, address, phone, YTD spend only. Accounts with no orders this year are open to all reps | Yes |
| Proposals / quotes (incl. supplier costs and margins) | Browser; **server only after the person chooses "Save my proposals to the server"** on the Proposals tab | Server copy is private to its owner: no one else receives it in a listing, managers included. A manager's full **server export** (the backup) does include every proposal | Only if saved to the server, or restored from a downloaded backup |
| Item catalog (supplier costs) | Browser only | No | No — use Backup |
| Profile, target margin, other settings | Browser only | No | No — use Backup |
| Good/Better/Best catalog and learned matches | Server (`$DATA_DIR/ob_reports/catalog_store.json`, `feedback_store.json`) | Yes (one shared catalog) | n/a |
| Generated Excel/Word reports | Server (`$DATA_DIR/ob_reports/*.xlsx|docx`), deleted after `REPORT_RETENTION_DAYS` (30) | Any signed-in user who has the (unguessable) file name | n/a |

Signing in does **not** by itself put business records on the server. Server
persistence needs the Render persistent disk (`render.yaml`, `/var/data`). Without
it the server database is lost on every restart; the app notices when the server
returns nothing for records a browser had synced, keeps the local copies, and
uploads them again (it tells the person it did so).

One browser holds one person's local data. If someone else signs in on the same
browser, the previous person's local data is set aside under their own key (not
shown, not deleted) and returns when they sign in again. A shared computer should
still be treated as shared: use Backup → "Remove data and sign out".

## 2. Backup and recovery

### Server (leads, accounts, and proposals saved to the server)
* **Automatic copies.** Every `BACKUP_INTERVAL_HOURS` (6) the server writes a
  consistent copy of the database to `$DATA_DIR/backups/sales_hub-YYYYMMDD-HHMMSS.db`
  and keeps the newest `BACKUP_KEEP` (14). These sit on the **same disk**, so they
  protect against mistakes and corruption, not against losing the disk.
* **Off-box copy (do this weekly).** A manager opens **Backup → Download server export**
  (`GET /records/export`: JSON with all customers' full detail — store it securely).
* **Restore the whole database from an automatic copy** (Render shell):
  stop writes (Render → Suspend), `cp /var/data/backups/<chosen>.db /var/data/sales_hub.db`,
  `rm -f /var/data/sales_hub.db-wal /var/data/sales_hub.db-shm`, resume the service.
* **Restore from an export file** (adds only records that are missing; never overwrites
  newer work unless `--overwrite`): `python accounts_store.py restore-export export.json`
  (uses `$DATA_DIR/sales_hub.db`, or pass `--db PATH`).
* **Undo an accidental delete.** Deletes and owner changes are written to an audit
  table with a full copy of the record. A manager can `GET /records/audit` and
  `POST /records/{leads|accounts|quotes}/{id}/restore`.
* **Test a restore on disposable data first**: run the restore command above against a copy
  (`--db /tmp/test.db`). `tests/test_records.py` exercises backup, export and restore on synthetic data.

### Browser (proposals not yet on the server, catalog, settings)
* **Backup** in the top bar → *Download backup (.json)*. It contains supplier costs and
  margins; keep it secure. *Restore* validates the file first, snapshots current data
  (one Undo), and offers "add missing records" (default) or "replace everything".
* Data the browser could not read is **set aside, never overwritten**, and offered for
  download in the Backup dialog. Data written by a newer app version is left untouched
  by an older page.
* If a save fails (storage full or blocked) a red banner says so and warns on leaving
  the page.
* Edits that lost a conflict (two people edited the same lead/account; the second save
  is refused and the latest version is loaded) are kept under "Edits replaced by newer
  changes" in the Backup dialog.

## 3. Sign-in, roles and access

* Users are `AUTH_USERS` (`email:pbkdf2_sha256$600000$…` hashes made with
  `python auth.py hash-password`). The API refuses all requests until it is set. Passwords
  are never stored or logged. Tokens are HMAC-signed, expire after `AUTH_TOKEN_HOURS`
  (12), and stop working when the user's hash changes or the user is removed.
  Malformed or tampered tokens are rejected with 401, never a 500.
* Five wrong passwords for an email (30 per IP) lock sign-in for 15 minutes. Unknown
  emails and wrong passwords return identical responses.
* Roles: **rep** (default) and **manager** (`AUTH_MANAGERS`). Managers open every
  account, reassign records, replace the shared Good/Better/Best catalog, and use
  `/records/export`, `/records/audit` and restore. If `AUTH_MANAGERS` is empty, every
  signed-in user may replace the catalog.
* Every route except `GET /health`, `POST /auth/login` and the static web app requires a
  token, including `/reports/*`. `tests/test_api_security.py` checks each one.
  `/health` returns only `{"status":"ok"}`.
* Managers are administrators: the export, audit and restore endpoints can read every record, proposals
  (with costs and margins) included. Give the manager role only to people trusted with all of it.
* The server enforces access to records; hiding something in the page is never the
  control. **Anything the server sends to a browser is readable by the person using it**
  (supplier costs on their own quotes, for instance).
* Customer-facing proposals are produced in the rep's browser (Print / Save PDF) from a
  fixed list of fields: no cost, margin, gross profit or internal notes. `tests/e2e/flow.js`
  asserts the printed HTML contains none of them. There is no public proposal link.
  *Scope / notes* **is printed** — keep internal remarks out of it.
* Response headers on every response: CSP (same-origin scripts; Google Maps hosts only if a
  key is configured), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`,
  `Permissions-Policy`, HSTS over HTTPS, `Cache-Control: no-store` on API data.
  Override the CSP with `CONTENT_SECURITY_POLICY` if you add third-party scripts.
* `ALLOWED_ORIGINS=*` (the default in `render.yaml`) is acceptable because tokens travel in the
  `Authorization` header, not cookies. Set it to your real origin(s) if the frontend is on a
  separate host.

## 4. Files and parsing

* Upload size ≤ `MAX_UPLOAD_MB` (15), JSON bodies ≤ `MAX_JSON_MB` (25; 3 MB per record).
* Extension allow-list **and** file-signature check (a `.pdf` must start with `%PDF`, etc.);
  `.xlsx` files whose contents would expand beyond 250 MB are refused; PDFs read at most
  200 pages (30 for comparisons); absurdly large images (over ~100 megapixels) are refused.
* Parsing/OCR/report building run off the event loop, at most `HEAVY_CONCURRENCY` (2) at a
  time, and give up after `HEAVY_TIMEOUT_SECONDS` (90) with a 504/503. Uploads are processed
  in memory; nothing from a lead file is stored.
* Excel formulas in uploaded files are never evaluated (cached values only), and any
  formula-looking text written into a generated workbook is stored as plain text. CSV exports
  from the app prefix cells starting with `= + - @` with an apostrophe.
* Errors shown to users never include stack traces or server paths; details go to the server
  log (no request bodies, credentials or tokens).

## 5. What the numbers mean

* **Sell price** = cost ÷ (1 − margin), rounded **up** to the cent. $60 at 25% margin → $80.00
  (a 25% *markup* would be $75). Margins of 100% or more, or a missing/negative cost, are refused
  with a message rather than priced.
* **Margin %** = (sell − cost) ÷ sell. **Markup %** = (sell − cost) ÷ cost.
* **Quote totals** (all rounded to the cent per line, then summed, so printed figures add up):
  line extended = qty × unit price; line net = extended after the quote discount;
  subtotal = Σ extended; discount = subtotal − Σ net; tax = rate × Σ net of taxable lines
  (0 if exempt); order total = Σ net + tax + delivery.
* **Annual recurring** = Σ net of recurring lines × (12 monthly / 4 quarterly / 1 annual).
  **One-time** = Σ net of one-time lines. **First-year value** = recurring + one-time.
* **Quote margin** = gross profit ÷ revenue over lines that **have a cost**, after discount,
  before tax and delivery. Lines without a cost are listed as "cost missing" and excluded —
  an incomplete cost file never looks like 100% margin.
* **Estimated annual savings** = Σ over lines with a *current price* of
  (current − proposed) × qty × frequency multiplier. It is an estimate against what the customer
  says they pay today.
* **Valid until** = (sent date, else created date) + validity days, on the rep's local calendar.
  A sent/negotiating quote is **Expired** once today is past it. "Today" is the local date, not UTC.
* **Open pipeline** = first-year value of draft/sent/negotiating quotes that are not expired.
  **Win rate** = won ÷ (won + lost). **Avg days to close** = mean(decided − sent) for won quotes with both dates.
* **Invoice merchandise** = Σ round(shipped qty × unit price) (ordered qty if shipped is blank);
  tax and freight are on the invoice but are not spend. **YTD / MTD orders** = merchandise on
  orders dated in the current calendar year / month, plus amounts logged on legacy "order"
  activities not yet converted. The server (`accounts_store.py`) and browser (`calc.js`) use the same rule;
  `tests/fixtures/calc_cases.json` runs against both.
* **Account margin** = this year's invoice lines with a cost; if none, the won proposal's margin.
* **Good/Better/Best comparison**: *cost per use* = case price ÷ uses per case, only when both
  are known and positive. Spend analysis converts to cost-per-use when the competitor's
  `competitor_uses_per_case` **and** our `uses_per_case` are present; otherwise it assumes
  case-for-case substitution and labels those rows (and their dollars) as an **estimate**. Rows
  with a missing, negative or non-numeric quantity/price are listed by row number and left out,
  not guessed. Nothing infers uses per case, equivalence or quality.
* **Lead fit score (0–100)**: region in territory +20; headcount 20–500 +25 (unknown +10, outside +0);
  known segment +20; email (verified +10, unverified +5, invalid +0); a contact name/title +5;
  intent triggers +7 each up to +20. Missing data scores partial/zero, never full.
* Lead de-duplication key = normalized company name + ZIP5 (or city when there is no ZIP), so the
  same company in two ZIP codes stays two leads.

## 6. Launch checklist

1. Set `AUTH_USERS` (one hash per person, 12+ character passwords) and `AUTH_MANAGERS` on Render;
   leave `AUTH_SECRET` as generated (32+ characters).
2. Confirm the persistent disk is attached (`/var/data`): `GET /health` is up *and* a record created,
   then the service restarted, is still there.
3. Set `ALLOWED_ORIGINS` to the real site address if the frontend is hosted separately.
4. Rebuild so `Pillow>=13` and the new modules (`pricing.py`, `hardening.py`) are in the image.
5. Sign in as a manager: download `/records/export` and keep it; check `backups/` appears on the disk.
6. Sign in as a rep: import a synthetic lead file, build a quote, print the proposal and read the PDF —
   no cost or margin may appear. Turn on "Save my proposals to the server" and check a second device.
7. Have each rep download a Backup after their first week, then weekly.
8. Before using real customer data, add your privacy notice/terms of use and agree a retention rule;
   the app has no legal text of its own. Respect source terms, do-not-contact requests and email
   marketing rules for every lead list you import.

## 7. Known limitations (not fixed here)

* The item catalog, profile and settings are browser-only. Quotes are browser-only until the person opts in.
* Last-save-wins is replaced by conflict detection for leads/accounts/quotes, but edits are whole-record:
  a conflict keeps the loser's version in the Backup dialog for manual re-entry, not an automatic field merge.
* Quote numbers come from a per-person counter (`Q-2026-001`); two reps can issue the same number.
* Managers see all accounts; there is no multi-tenant separation (one company per deployment).
* Passwords are changed by an administrator editing `AUTH_USERS`; there is no self-service reset, no
  second factor, and no per-user session revocation other than changing that user's hash.
* The matching model (`openai/clip-vit-base-patch32`) is downloaded unpinned at image build time.
* Dependencies are not version-pinned (existing convention). `pip-audit` of the application's
  direct dependencies showed only Pillow needing an upgrade (≥ 13.0.0, now required in `requirements.txt`).
* The Google Maps key (when set) is visible in the page by design; restrict it by referrer in Google Cloud.
* Hosting, billing and Google Maps usage limits are outside this codebase and unchanged by it.
