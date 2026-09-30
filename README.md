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

## Setup
```
pip install -r requirements.txt
```
OCR (for reading prices off photos/scanned PDFs) needs the Tesseract binary:
- Mac: `brew install tesseract`
- Ubuntu/Debian: `sudo apt-get install tesseract-ocr`
- Windows: https://github.com/UB-Mannheim/tesseract/wiki

## Run
```
uvicorn backend:app --host 0.0.0.0 --port 8000 --reload
reflex init
reflex run
```

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
(`/tmp/ob_reports/feedback_store.json`) and pending (unconfirmed) comparisons
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
