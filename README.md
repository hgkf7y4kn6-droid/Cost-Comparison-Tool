# Cost-Comparison-Tool
# Office Basics Good/Better/Best Comparison Agent

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

## Stack
| Piece | Where | What |
|---|---|---|
| `client/` | **Expo** (expo-router, TypeScript) | One app for web, iOS and Android |
| Web build | **Cloudflare** (`wrangler.jsonc`) | `expo export --platform web`, served as a single-page app |
| iOS / Android builds | **EAS** (`client/eas.json`) | Cloud builds, store submission, OTA updates |
| Auth | **Clerk** | Email-code sign-in in the app; the backend verifies Clerk session tokens on every API route |
| Analytics | **PostHog** | Screen views, sign-ins and each action (catalog upload, comparison, confirm, spend analysis) |
| `backend.py` | **Render** (`Dockerfile`, `render.yaml`) | FastAPI + CLIP/FAISS matching, OCR, report generation |

The backend can't run on Cloudflare: PyTorch, the CLIP model, FAISS and
Tesseract need a real container with ~2 GB RAM.

## Set up the services (once)
### Clerk
1. Create an application at clerk.com.
2. **User & authentication → Email**: enable **Email verification code** as a
   sign-in method, and make email the only required sign-up field (the app's
   sign-in screen is a passwordless email-code flow that also creates accounts).
3. From **API keys** note the **Publishable key** (`pk_...`, for the app) and the
   **Frontend API URL** (e.g. `https://your-app.clerk.accounts.dev`, for the backend).
4. For production, create a Clerk production instance on your own domain and use
   its keys instead of the development ones.

### PostHog
Create a project and note its **Project API key** (`phc_...`) and host
(`https://us.i.posthog.com` or `https://eu.i.posthog.com`). Leaving the key unset
disables analytics. Events sent: `signed_in`, `signed_up`, `catalog_uploaded`,
`comparison_completed` / `comparison_failed`, `match_confirmed`,
`spend_analysis_completed` / `spend_analysis_failed`, plus `$screen` views. Users
are identified by Clerk user id with their email as a person property.

## Deploy
### 1. Backend on Render
1. In Render, choose **New → Blueprint** and select this repo. Render reads
   `render.yaml` and builds the `Dockerfile` (Tesseract and the CLIP model are
   baked into the image).
2. The service needs the **Standard** plan or above — torch + CLIP need ~1.5–2 GB
   RAM and will run out of memory on free/starter instances.
3. Set these environment variables on the service:
   - `CLERK_ISSUER` — the Clerk **Frontend API URL**. Required: until it's set,
     every API route returns 503 (the server fails closed rather than running
     unauthenticated).
   - `CLERK_AUTHORIZED_PARTIES` (optional) — your Cloudflare site's origin, e.g.
     `https://cost-comparison-tool.<you>.workers.dev`; rejects web sessions
     issued for any other site.
   - `ALLOWED_ORIGINS` (optional) — CORS; set to the same origin instead of `*`.
4. A 1 GB persistent disk is mounted at `/var/data` (`DATA_DIR`) so learned
   feedback and generated reports survive restarts/redeploys.
5. Check `https://<service-url>/health` returns `{"status": "ok"}`.

### 2. Web app on Cloudflare
1. In the Cloudflare dashboard, open the Worker → **Settings → Build →
   Variables and secrets** and add these **build** variables:
   `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`, `EXPO_PUBLIC_POSTHOG_KEY`,
   `EXPO_PUBLIC_POSTHOG_HOST`, and (if it differs from the default)
   `EXPO_PUBLIC_API_BASE`. They are inlined into the bundle at build time, so
   changing one needs a redeploy.
2. Keep the deploy command `npx wrangler deploy` and leave the build command
   empty: `wrangler.jsonc` runs `npm ci && npx expo export --platform web` in
   `client/` and uploads `client/dist`. Make sure `"name"` in `wrangler.jsonc`
   matches your Worker's name.

### 3. iOS / Android with EAS
Run from `client/` (needs an Expo account; Apple/Google developer accounts for store builds):
```
npx eas-cli@latest login
npx eas-cli@latest init          # links the project and writes its projectId into app.json
npx eas-cli@latest env:set --name EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY --value pk_... --visibility plaintext \
  --environment production --environment preview --environment development
npx eas-cli@latest env:set --name EXPO_PUBLIC_POSTHOG_KEY --value phc_... --visibility plaintext \
  --environment production --environment preview --environment development
#   (same for EXPO_PUBLIC_POSTHOG_HOST / EXPO_PUBLIC_API_BASE if they differ from the defaults)
npx eas-cli@latest build --profile production --platform all
npx eas-cli@latest submit --profile production --platform ios   # or android
```
Profiles in `eas.json`: `development` (dev client for testing native code),
`preview` (internal distribution builds), `production` (store builds, build
numbers auto-incremented). Before the first store build, change the placeholder
`ios.bundleIdentifier` / `android.package` (`com.officebasics.costcomparison`)
in `client/app.json` if you need a different identifier — they can't be changed
after the app is published.

## Run locally
Backend:
```
pip install -r requirements.txt
AUTH_DISABLED=1 uvicorn backend:app --host 0.0.0.0 --port 8000 --reload
```
`AUTH_DISABLED=1` skips Clerk verification — local development only; to test
real auth locally set `CLERK_ISSUER` instead. OCR (for reading prices off
photos/scanned PDFs) needs the Tesseract binary:
- Mac: `brew install tesseract`
- Ubuntu/Debian: `sudo apt-get install tesseract-ocr`
- Windows: https://github.com/UB-Mannheim/tesseract/wiki

Or run the same container Render uses: `docker build -t ob-backend . && docker run -p 8000:8000 -e AUTH_DISABLED=1 ob-backend`.

App:
```
cd client
cp .env.example .env       # fill in keys; set EXPO_PUBLIC_API_BASE=http://localhost:8000 for a local backend
npm install
npx expo start             # press w for web; native modules (camera, secure store) need a dev build
```
After changing a `.env` value, restart with `npx expo start --clear` so the new
value is inlined.

## Catalog format
Upload via the app or `POST /catalog/upload/` (all API routes need a Clerk session token as `Authorization: Bearer ...`). Required columns:
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
