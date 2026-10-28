# Changelog

## Unreleased — launch-readiness pass

### Money and dates
- Sell price from margin is exact (no $80.01 for $60 at 25%); margins of 100% or more and missing/negative costs are refused with a message instead of being clamped or priced.
- Quote and invoice totals round each line to the cent and sum cents, so printed figures add up. Rules and worked examples: `docs/OPERATIONS.md`, `tests/fixtures/calc_cases.json`.
- Server-side YTD spend uses the same per-line rounding as the browser.
- "Today" is the rep's local date (it was the UTC date, so proposals expired and follow-ups went overdue a day early each evening in US time zones).
- Spend analysis: Decimal arithmetic; rows with missing/negative/non-numeric quantities or prices are reported by row number instead of crashing or being priced; savings are split into measured (cost per use) and estimated (case-for-case).

### Data safety
- Unreadable local data is set aside (downloadable), never overwritten; data from a newer app version is never overwritten by an older page; failed saves show a banner and warn on leaving.
- New **Backup** dialog: download, validated restore (add-missing or replace, with undo), set-aside copies, replaced-edit copies, "remove my data from this browser", manager server export.
- Local data is kept per person on a shared browser.
- Proposals can be saved to the server (opt-in, private to the owner).
- Leads/accounts/quotes carry revisions: a save based on an outdated version is refused, the latest is loaded and the refused edit is kept.
- If the server returns nothing for records a browser had synced, the browser keeps and re-uploads them instead of deleting its copies.
- Invoice import is reviewed before anything changes, flags likely partial exports, rejects impossible dates (no more silent "today"), skips re-imports of identical invoices, keeps replaced versions, and can be undone.
- Server: WAL, rolling database backups, audit log with restorable deletes, export/restore tool, atomic writes for catalog and learned matches (a corrupt file is moved aside), catalog persists across restarts.

### Security
- Security headers (CSP, frame/sniff/referrer/permissions policies, HSTS), `no-store` on API data, generic error responses.
- Upload limits, extension + signature checks, zip-bomb guard, bounded concurrency and timeouts for parsing/report work, JSON body limits.
- Report files have unguessable names and are cleaned up; formulas in uploaded data can't execute in generated workbooks; CSV exports defuse `= + - @` cells.
- Token validation can no longer raise on odd payloads; login field lengths are capped; startup warns about malformed `AUTH_USERS` entries and short secrets.
- Replacing the shared catalog is manager-only once `AUTH_MANAGERS` is set.
- `Pillow>=13.0.0` (published advisories against older versions).

### Accessibility and polish
- Axe (WCAG 2.0–2.2 A/AA rules) reports no violations on the main screens in light and dark; fixed unlabeled file inputs and low-contrast muted/brass text. Brand colours otherwise unchanged.
- Proposals export file is named `…INTERNAL-costs-and-margins…`; the rendered proposal is cleared from the page after printing.
- The current deal survives a refresh.

### Tests
- 141 backend tests, 15 browser-maths tests, an 18-step browser flow; CI workflow added.
