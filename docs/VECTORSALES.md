# VectorSales prospecting engine (CrewAI)

VectorSales is this project's new name (formerly Sales Hub). The prospecting engine in
`vectorsales/` adds cost-aware account discovery, trigger intelligence, explainable
scoring, education-first outreach drafting, geographic clustering and qualification.
It runs inside the existing FastAPI service under `/vs/*` (same sign-in), stores data in
two SQLite files under `$DATA_DIR` (`vectorsales.db`, `vectorsales_ledger.db`), and adds
**no new infrastructure**. The AI parts use **CrewAI** (`crewai>=1.15,<2`, MIT licensed).

## Design rule: deterministic first, a model only where it earns its cost

| Tier | Does | Where |
| --- | --- | --- |
| 1. Plain code | ICP filtering, dedupe/merge, scoring, freshness, budgets, geo radius, cadence dates, qualification, suppression, state machines, metrics | `icp.py scoring.py store.py ledger.py geo.py outreach.py qualification.py metrics.py pipeline.py` |
| 2. Cheap model (CrewAI "Signal Analyst") | classify news/web text into trigger events — only when the rules found nothing | `crews.py` |
| 3. Strong model (CrewAI "Outreach Writer") | first-email draft, only for accounts at or above `strong_min_priority` (default 70); others use the cheap model | `crews.py` |

Each crew is **one agent with no tools**, bounded (`max_iter=3`, time limit, `max_tokens`), with a
pydantic output schema. Around every call: budget reserved first and settled with real token usage
(flagged *estimated* if the model reports none); tenant-scoped cache (14 days); retrieved text is
cleaned, delimited as untrusted, screened for instruction-like phrases (those documents are never
sent to the model); every quoted trigger excerpt is checked to appear in the named source (invented
evidence is dropped); drafts are validated (≤125 words, ≤3 paragraphs, ≤1 link on an approved list,
subject pattern, opt-out line, only evidence-backed claims, no invented statistics), retried once
with the problems listed, then replaced by a compliant template. CrewAI telemetry is switched off.

## Configure
| Variable | Meaning |
| --- | --- |
| `VS_MODEL_CHEAP`, `VS_MODEL_STRONG` | CrewAI/LiteLLM model names, e.g. `gpt-4o-mini`; plus that provider's API key variable (`OPENAI_API_KEY`…). Unset = rules-only; everything else still works |
| `VS_MAX_OUTPUT_TOKENS` (700), `VS_LLM_TIMEOUT` (60) | per-call bounds |
| `VS_TENANTS` | `email:tenant,…` — which organisation each sign-in belongs to; unlisted users share `default` |

Set prices (`Ledger.set_price(model, in_per_mtok, out_per_mtok)`) so model spend is costed; without a
price the cost is recorded as 0 **and marked estimated**. Set budgets with `PUT /vs/budgets` (manager).

## API (all require sign-in; tenant comes from the server, never the request)
`PUT/GET /vs/icp` · `POST /vs/accounts/import` (≤500) · `GET /vs/queue` (ranked, with explanations and field provenance) ·
`GET/DELETE /vs/accounts/{id}` · `POST …/contacts`, `…/triggers`, `…/triggers/assess`, `…/outreach/draft` ·
`POST /vs/outreach/{id}/approve` (manager) · `POST /vs/outreach/{id}/send` · `POST /vs/suppression` ·
`POST /vs/contacts/{id}/events` (reply, meeting_booked, bounce, unsubscribe, invalid) · `PUT /vs/budgets` ·
`GET /vs/usage` · `POST /vs/geo/clusters` · `POST /vs/qualification` · `GET /vs/audit` (manager) · `GET /vs/health`.

## What the software does versus what it only recommends
* A draft is not a send. `send` requires: approved by a manager, a clean suppression check, an account not
  replied/booked/disqualified, and an **email integration plugged into `Services.sender`** (none is bundled,
  so today `send` answers 409). The state change is an atomic compare-and-set, so a double click cannot send twice.
* A geographic cluster is a proposal. Nothing is booked, and an unconfirmed anchor is labelled hypothetical.
* Qualification treats *unknown* as not-yet-qualified; handoff with unproven mandatory items needs a person.
* A trigger is **verified** only when it comes from a document the caller marked `authoritative`; model or
  rule hits on other pages are inferred, count half in intent, and go to the review count.
* No data provider is bundled. `providers.py` is the interface (priority, tier, timeout, retries with
  jittered backoff, circuit breaker, per-provider concurrency/rate, budget reservation); you add real vendors
  with credentials you are licensed to use. Until then `/vs/accounts/import` ingests, dedupes, filters and scores
  only what you send it.

## Status (see the commit/test run for evidence)
| Capability | Status |
| --- | --- |
| ICP match, dedupe/merge with provenance and merge log, staleness checks | implemented, unit-tested |
| Trigger rules + CrewAI classification, verification against source, injection screening, caching | implemented, tested with a scripted LLM (no real model call has been made) |
| Explainable score (fit/intent/contactability/evidence/priority), cost-aware adjustment, calibration helper | implemented, tested |
| Outreach rules, cadence planner, approval + send gate, suppression, reply/unsubscribe cancellation | implemented, tested |
| Cost ledger, concurrency-safe budgets (operation/workflow/campaign/provider/tenant, day/month/total), warnings | implemented, tested incl. 12 concurrent reservations |
| Provider registry (retries, breaker, timeouts, budgets) and progressive enrichment with per-stage cost | implemented, tested with fake providers |
| Tenant isolation (every query tenant-scoped; HTTP-level cross-tenant tests) | implemented, tested |
| Geo radius clustering and economics | implemented, tested (no routing API; straight-line distance) |
| Unit-cost metrics (unavailable when a denominator is missing) | implemented; outcome-based ones stay unavailable until outcome events are recorded |
| Plan entitlements / usage quotas per subscription tier, billing | **not implemented** (budgets cap spend; no plan model) |
| Real providers (discovery, enrichment, verification, intent feeds), CRM sync, calendar, email sending, LinkedIn | **not implemented** — need vendor accounts/credentials |
| Persistent job queue with priorities/dead-letter | **not implemented** — long calls run in the request's thread pool, bounded by the existing heavy-work limiter |
| UI for VectorSales | **not implemented** — API only |
| Model-vs-accuracy evaluation harness, score calibration on real outcomes | **not implemented** (needs labelled data and real models) |

## Measured (synthetic data, SQLite file on local disk)
Ingesting 5,000 candidate accounts through filter→dedupe→merge with no providers: 6.7 s before batching commits, 0.34 s after
(~14,600/s); re-import of the same 5,000: 0.34 s, no duplicates; scoring 500 accounts: 0.03 s. These are single-process
laptop-class numbers, not a capacity guarantee.
