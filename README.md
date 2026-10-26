# Sales Hub

Prospecting, cost comparisons, proposals and accounts for a field sales team,
in one web app. The FastAPI backend serves both the API and the web app, so a
single Render service runs the whole product: open the service's URL, sign in.

Design: ink navy and brass on warm paper, with an automatic dark mode. Type is
DM Serif Display for titles and headline figures and Plus Jakarta Sans for
everything else, both self-hosted from `frontend/fonts/` under the SIL Open
Font License. Responses are gzip-compressed.

# Good/Better/Best Comparison

## What "good/better/best" means here
This isn't three quality tiers of the same SKU. It's a **substitution strategy**:
- **Good** — the closest like-for-like match to what the prospect currently buys
  (e.g. competitor sells c-fold towels -> good = a comparable c-fold towel)
- **Better** — a different, more cost-effective product *format* that solves the
  same need (e.g. multifold towel)
- **Best** — a format shift with the lowest cost-per-use while remaining
  comparable in quality (e.g. hardwound roll towel)

Because a case of c-fold towels, multifold towels, and roll towels all contain
different unit counts, price alone isn't a fair comparison — the report
normalizes to **cost per use** whenever `uses_per_case` is available.

## Sales Hub tabs
Above every tab, the **current deal** bar shows the customer you're working on
(a lead or an account), where it stands, and one **Next** button for the step
that moves it forward (find the decision-maker → send outreach → run a cost
comparison → build the quote → send it → follow up → onboard). It changes as
the deal does; pick a different deal from its menu. Lead, quote and account
details open as side panels over the list (Esc or a click outside closes
them). Sections are expandable cards (as in DFS Riches): click a card's header
to open or minimize it; each card remembers its state in your browser.

**Today** (the default tab) lists what needs attention across all stages:
account follow-ups due this week, proposals waiting on the customer (expired and
expiring first), engaged leads with no quote yet, drafts to finish, best-fit
leads to reach out to, and accounts with renewals coming up or no recent
contact. Each item opens the right record. On a fresh install it shows a
three-step "Start here".

The stages themselves, one tab each:
1. **Prospecting** (`frontend/prospecting.js`) — ethical regional lead sourcing
   for Philadelphia, New Jersey, Allentown/Lehigh Valley and Lancaster:
   - Sourcing playbook checklist (PA Open Data, OpenDataPhilly, Open Data NJ,
     geo-fenced local scrapers, chamber directories, Clay/Apollo enrichment,
     ZeroBounce/NeverBounce verification).
   - Import from **CSV, Excel (.xlsx/.xls) or PDF** (see
     `frontend/prospects_template.csv`). CSV is read in the browser; Excel and
     PDF go to the backend's `POST /leads/parse/` (`table_extract.py`), which
     returns rows without storing anything. PDFs can be ruled tables (merged
     across pages, repeated headers dropped), tables laid out by alignment
     only, directory listings (one entry per block of lines), or scanned
     (OCR, when Tesseract is available). Every import opens a review step:
     pick the sheet/table, skip title rows, and confirm which column is which
     (headers and column contents are recognized automatically). Labels like
     "Phone:" are stripped and "street, city, ST zip" addresses are split.
     On import, consumer emails (gmail, yahoo, …) are purged, duplicates are
     merged, and region is derived from county → ZIP → city; out-of-territory
     and out-of-range (20–500 employees) rows can be dropped.
   - Re-importing an enriched/verified export merges by `id` or company, filling
     in contacts, headcount and `email_status` and advancing the stage.
   - Pipeline table (New → Enriched → Verified → Contacted → Qualified /
     Disqualified) with filters, a 0–100 fit score (territory, headcount,
     segment, verified email, contact, intent triggers) and CSV export.
   - Lead detail with product-interest → decision-maker title mapping,
     intent triggers, compliance warnings, and a localized outreach draft with
     an opt-out line.
   - **Start Cost Comparison →** marks the lead Qualified and opens tab 2 with
     the lead shown as the active account.
2. **Cost Comparison** — the good/better/best tool described below. After a
   comparison, **Add to quote →** puts the chosen tier on the active lead's
   draft quote, with the competitor's price as the "current price" (scaled to
   cost-per-use when uses-per-case is known on both sides).
3. **Proposals & Quotes** (`frontend/quotes.js`) — quotes for qualified leads
   or existing accounts:
   - **Building a proposal works like building a DFS lineup.** Contract line
     items are numbered slots: select "#1 Select item ›" and the item picker
     opens with the six major categories (Janitorial Supplies, Breakroom
     Supplies, Office Supplies, Printing Solutions, Print and Promotional,
     Furniture) in one list (pick any number) beside an item search. Choosing
     an item pulls its cost from the **item catalog**; set the margin % or the
     sell price and the other updates (price = cost ÷ (1 − margin), rounded up
     to the cent). **Save line item** returns to the lineup; **Save & next line
     item** opens the next slot. "Margin for every item" sets the starting
     margin for new items (defaults to your saved target), and **Apply to all
     line items** re-prices every line with a cost. Items not in the catalog
     can be added as custom items.
   - Each line also has quantity, unit, frequency (one-time vs.
     monthly/quarterly/annual, so restock and one-time furniture are valued
     separately), the customer's current price and a taxable flag.
   - **Item catalog** card: import your cost file (CSV/Excel; needs an item
     name/description and cost; SKU, category, list price, unit and pack are
     used if present; see `frontend/catalog_items_template.csv`). Items are filed
     into the six categories from the file's category or the item name;
     re-imports merge by SKU and update costs. "Load sample items" adds a
     made-up catalog (SKUs `SAMPLE-…`) for trying the builder. The catalog is
     stored in this browser.
   - Discount, delivery, and sales tax defaulted from the customer's location
     (Philadelphia 8%, rest of PA 6%, NJ 6.625%; apparel lines default to
     non-taxable; tax-exempt toggle). Confirm rates per deal.
   - Totals: order total, annual recurring value, one-time value, and
     estimated annual savings vs. current pricing.
   - **Print / Save PDF** produces a customer-facing proposal with a savings
     callout, terms and an acceptance block.
   - Status Draft → Sent → Negotiating → Won / Lost (with loss reason);
     quotes past their validity show as Expired. Sending moves the lead to
     "Proposal sent"; winning moves it to "Won" and creates/updates the account.
   - **Cost & margin (internal):** each line has a unit cost (🔒); the editor
     shows per-line margin, overall quote margin vs. your target, and gross
     profit per order and per year. Margin is on line revenue after discount
     (tax and delivery excluded); lines without a cost are left out and flagged.
     Cost and margin are **never printed on the proposal**; they appear only in
     the editor, the quote list, the KPI tiles and the CSV export.
   - KPIs: open pipeline, won recurring value, win rate, average days to close,
     blended margin on open and won quotes.
   - **Margin calculator** card: set a target margin % (remembered between
     sessions), enter a cost and the sell price fills in at that target
     (cost ÷ (1 − margin), rounded up to the cent). Type your own sell price to
     see the margin, profit per unit / total, markup, and how far it is from
     target.
4. **Accounts** (`frontend/accounts.js`) — customers from won quotes (or added
   by hand). A newly won account starts in **Customer Onboarding**: a
   checklist (kickoff, account setup, contacts, contract pricing, delivery,
   first order — plus a tax-exempt certificate only for a non-profit and a
   resale certificate only if they'll resell supplies) that the deal bar points to; ticking
   the last step makes the account Active and schedules a first business
   review in 90 days. Accounts also track status (Onboarding / Active / At risk / Churned), owner, contacts,
   renewal date, next action, and an activity log. Shows recurring and one-time
   value and savings delivered from won quotes, product-line coverage with
   cross-sell gaps (and who to talk to), follow-ups due this week, accounts
   with no touch in 60+ days, and renewals within 90 days.

All Sales Hub data (leads, quotes, accounts) is stored in the browser's
`localStorage` via `frontend/store.js` — per browser, per device. Use each
tab's **Export shown (CSV)** to back up or share; moving this data to a
backend database is the next step for team-wide use.

## Sign-in (required)
Every backend endpoint except `/health` and `/auth/login` requires a signed-in
user, including report downloads under `/reports/`. The frontend shows a sign-in
screen and sends the token with each request. Leads, quotes and accounts still
live in each browser's local storage; signing out doesn't erase them.

Set up users on Render (Environment tab of `cost-comparison-backend`):
1. For each person, run `python auth.py hash-password` locally (asks for their
   email and a 12+ character password) and copy the `email:hash` line it prints.
2. Set `AUTH_USERS` to those lines joined with commas, e.g.
   `ana@officebasics.com:pbkdf2_sha256$600000$...,raj@officebasics.com:pbkdf2_sha256$...`
3. `AUTH_SECRET` is generated by Render from `render.yaml`. Leave it alone;
   changing it signs everyone out.

Until `AUTH_USERS` is set, the API refuses every request (it fails closed).
To remove someone or reset a password, edit their entry. Changing a user's hash
immediately invalidates their existing sessions. Sessions last 12 hours
(`AUTH_TOKEN_HOURS`). Five wrong passwords for one email (or 30 from one IP
address) lock sign-in for 15 minutes.

## Prospecting map and shared accounts
The Prospecting tab opens with a **service region map** (Google Maps):
- **Customer accounts** are star-topped green pins, darker the higher their
  year-to-date spend (this year's orders logged on the account with an amount:
  under $5k, $5k–25k, $25k–100k, $100k–250k, $250k+).
- **Prospects** (your leads not yet won) are round pins, blue to purple as they
  move through the pipeline.
- **Add a lead from Google Maps**: search for a business in the region, check
  the preview (address, phone, website, category, region, duplicate check) and
  add it; the lead opens with those details filled in.
- Addresses are located with Google's geocoder a few at a time and refreshed
  after 30 days.

**Who sees what.** Accounts and leads are stored on the server
(`accounts_store.py`, SQLite at `$DATA_DIR/sales_hub.db`, API under
`/records/{accounts|leads}/`), each with an owner.
- **Customers** (accounts with orders this year) are green pins. Their owner
  and managers can open the full account; any other rep sees only the name,
  address, general phone number and YTD spend. The server never sends other
  reps the rest of the record and rejects their edits.
- **Prospects** (accounts with no orders this year, and all leads) are grey
  pins, open to every rep: anyone can open and edit them, and claim them with
  "Make me the owner".
- Only a record's owner or a manager can delete it. Managers are listed in
  `AUTH_MANAGERS` (comma-separated emails) and can reassign any record.
- Quotes and the item catalog still live in each rep's browser.

Setup:
1. **Google Maps key.** In Google Cloud, enable the *Maps JavaScript API*,
   *Places API (New)* and *Geocoding API*, create a browser key restricted to
   the site's address, and set `GOOGLE_MAPS_API_KEY` in `frontend/config.js`
   (optionally `GOOGLE_MAPS_MAP_ID`). Without a key the map card explains this
   and the rest of the app works. Google bills map loads, place searches and
   geocoding beyond its monthly free usage.
2. **Persistent disk.** Shared accounts need the Render persistent disk
   (`render.yaml`, Standard plan). Without it they're lost on every restart.
3. **Managers.** Set `AUTH_MANAGERS` on Render.

Google's terms limit how long you may keep data copied from Google Maps
(place details and coordinates). The lead keeps Google's place ID; review
Google Maps Platform terms before relying on stored copies long-term.

## Project layout
- `auth.py` — sign-in: password hashing, signed session tokens, lockout.
- `accounts_store.py` — shared accounts and who may see/edit them.
- `table_extract.py` — Excel/PDF → rows for lead import.
- `backend.py` — FastAPI backend (CLIP + FAISS matching, OCR, report generation).
  Deployed to **Render** as a Docker service (`Dockerfile`, `render.yaml`).
- `frontend/` — static HTML/JS frontend. Deployed to **Cloudflare** as static
  assets (`wrangler.jsonc`). It calls the backend at the URL in `frontend/config.js`.

## Deploy
### 1. Backend on Render
1. In Render, choose **New → Blueprint** and select this repo. Render reads
   `render.yaml` and builds the `Dockerfile` (Tesseract and the CLIP model are
   baked into the image).
2. The service needs the **Standard** plan or above — torch + CLIP need ~1.5–2 GB
   RAM and will run out of memory on free/starter instances.
3. A 1 GB persistent disk is mounted at `/var/data` (`DATA_DIR`) so learned
   feedback and generated reports survive restarts/redeploys.
4. Once it's live, note its URL (e.g. `https://cost-comparison-backend.onrender.com`)
   and check `https://<that-url>/health` returns `{"status": "ok"}`.

### 2. Frontend on Cloudflare
1. Put the Render URL in `frontend/config.js` (`window.API_BASE = "..."`) and push.
2. Cloudflare's deploy command stays `npx wrangler deploy`; no build command is
   needed. `wrangler.jsonc` points it at `./frontend`. Make sure `"name"` in
   `wrangler.jsonc` matches your Cloudflare Worker's name.
3. Optionally lock CORS down: in Render set `ALLOWED_ORIGINS` to your Cloudflare
   URL (comma-separate multiple origins) instead of `*`.

## Run locally
```
pip install -r requirements.txt
python auth.py hash-password        # create a hash for yourself
export AUTH_USERS='you@example.com:<hash from above>'
export AUTH_SECRET="$(python -c 'import secrets; print(secrets.token_hex(32))')"
uvicorn backend:app --host 0.0.0.0 --port 8000 --reload
```
OCR (for reading prices off photos/scanned PDFs) needs the Tesseract binary:
- Mac: `brew install tesseract`
- Ubuntu/Debian: `sudo apt-get install tesseract-ocr`
- Windows: https://github.com/UB-Mannheim/tesseract/wiki

Or run the same container Render uses: `docker build -t ob-backend . && docker run -p 8000:8000 ob-backend`.

Then serve the frontend (with `window.API_BASE = "http://localhost:8000"` in
`frontend/config.js`): `npx wrangler dev` or `python -m http.server -d frontend 8080`.

## Catalog format
Upload via the app or `POST /catalog/upload/`. Required columns:
`sku, name, description, category, tier, price`
Optional columns:
- `format` — free-text product type (c-fold, multifold, roll, etc.) for your own reference
- `uses_per_case` — total number of individual uses obtainable from one case
  (e.g. sheets per case ÷ sheets used per hand-dry). Enables cost-per-use math.

`category` should represent the underlying **need** (e.g. "hand towel"), not the
specific format — that's what lets a c-fold, multifold, and roll towel all live
in the same comparison group with different tiers.

See `catalog_template.csv` for the worked towel example.

## How a comparison is resolved
1. Upload the competitor's product (photo, PDF, or Excel spec sheet).
2. The backend extracts text (OCR for images/scanned PDFs) and a price.
3. **Learned lookup first**: if a visually/textually similar competitor product
   has previously been confirmed (see below), its confirmed good/better/best
   SKUs are reused directly.
4. **Algorithmic fallback**: for any tier not covered by a learned match, the
   system embeds the product with CLIP, finds the closest matching `category`
   in your catalog, and picks the best-similarity item per tier within it.
5. The response includes a `comparison_id` and, if `competitor_uses_per_case`
   is supplied, a cost-per-use baseline for the competitor product too.

## Multi-month / multi-location usage analysis
Once you have several months of spend data (or data across multiple
locations), upload it via the app or `POST /analysis/spend/` to get a
retrospective savings analysis instead of a single-item comparison.

**Required columns** (case-insensitive): `date, location, product, quantity`,
plus either `unit_price` or `total_price`.
**Optional column**: `competitor_uses_per_case` — enables true cost-per-use
normalization instead of a case-for-case substitution assumption. See
`spend_history_template.csv` for the expected shape.

Each row's `product` description is matched the same way a single comparison
would be (learned feedback first, then algorithmic category/tier ranking),
using the `best` tier by default (pass `recommended_tier=good|better|best` as
a form field to change that).

Returns:
- A JSON summary (totals, savings %, by-month/location/category breakdowns)
- `workbook_url` — a multi-sheet Excel workbook (Summary, By Month, By
  Location, By Category, Line Detail) with bar charts for the month and
  location breakdowns
- `executive_summary_url` — a Word document with the same figures written up
  as a narrative: key metrics, top savings opportunities, methodology and
  assumptions, and a recommendation

Rows that can't be matched to any catalog category are included in the
current-spend totals with zero assumed savings (visible as "Records
Unmatched" in both outputs) rather than silently dropped.


After a comparison, a rep can confirm or correct which SKU was actually used
for each tier via `POST /feedback/confirm/`:
```json
{"comparison_id": "...", "good_sku": "OB-TWL-CFOLD-01", "better_sku": "OB-TWL-MFOLD-01"}
```
Any tier left out keeps whatever the comparison originally suggested. This
pairing (competitor product embedding -> confirmed SKUs) is stored, and the
*next* upload of a similar-looking competitor product will retrieve it
directly instead of recomputing from scratch. `GET /feedback/list/` shows
everything learned so far.

**Current limitation:** confirmed feedback is stored as JSON on local disk
(`$DATA_DIR/ob_reports/feedback_store.json`, the Render persistent disk in
production) and pending (unconfirmed) comparisons
live in memory only — restarting the backend clears anything not yet
confirmed. For production use, swap this for a real database (e.g. Postgres
with pgvector) so the learned mappings and pending comparisons survive
restarts and scale past a single process.

## supplies.officebasics.com — why it isn't queried automatically
This was checked directly: the site is a login-gated B2B ordering portal
(per-account contract pricing, JS-rendered content). Fetching it returns no
usable product/price data without an authenticated session, so there's no
reliable way to search or scrape it automatically here.

Instead, whenever a competitor product has no catalog match (fully or for
specific tiers), both `/compare/` and `/analysis/spend/` return a
`manual_lookup` / `manual_lookup_note` field with a direct link to the portal,
so a rep can check it manually while logged in. This is surfaced in the app UI
and in the spend analysis executive summary. Once more catalog items are
uploaded, this hint naturally stops appearing for whatever's now covered.

## Notes / assumptions
- Price extraction from images depends entirely on OCR quality — review
  detected prices before trusting a report, especially for handwritten or
  low-res photos.
- `uses_per_case` for the competitor's product usually can't be extracted
  automatically; pass it explicitly as `competitor_uses_per_case` on
  `/compare/` or `/compare/download/` if you want a true cost-per-use
  comparison rather than just a price comparison.
- This relies on your uploaded SKU/price files rather than live-scraping
  supplies.officebasics.com, since that's far more reliable for pricing
  accuracy.
