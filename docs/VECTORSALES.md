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
`POST /vs/contacts/{id}/events` (reply, meeting_booked, bounce, unsubscribe, invalid) (a `reply` may carry `text`, which is kept as persona evidence) · `PUT /vs/budgets` ·
`POST /vs/accounts/{id}/persona/signals` (web | email | note evidence) · `GET /vs/accounts/{id}/persona?contact_id=` · `GET /vs/usage` · `POST /vs/geo/clusters` · `POST /vs/qualification` · `GET /vs/audit` (manager) · `GET /vs/health`.

## Prospect personas and agent styles
The outreach writer adapts to how the prospect likely communicates (`vectorsales/personas.py`). Evidence comes from web
research, the prospect's own email replies and rep notes, weighted 1 / 3 / 2 (behaviour beats inference), halved after
90 days. Inference is rules-only (no model call, no spend) and returns the quotes behind the answer.

| Prospect persona | Agent style used |
| --- | --- |
| Impatient / Urgent | Efficient Concierge (shortest drafts, point first, one ask) |
| Methodical / Detailed | Analytical Specialist (precise, offers documentation/specifics) |
| Frustrated / Emotional | Empathic Problem-Solver (acknowledge first, no pitch, easy opt-out) |
| Novice / Confused | Proactive Advisor (plain language, one idea, offers a walkthrough) |

Thin or conflicting evidence gives **unknown** and a neutral draft; a web hint alone is never "established". Expressed
frustration in an email or note takes priority over other cues. The persona only shapes tone and length: every draft
still passes the same validator (evidence, no invented claims, opt-out), the email never mentions the inference, and
signals are deleted with the account. A persona is a hint about communication preference, not a judgment of the person.

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
| Model-vs-accuracy harness (`python -m vectorsales.evaluate`) and score calibration on recorded outcomes (`GET /vs/calibration`) | implemented, tested with scripted models and synthetic outcomes; **no real model or real outcome data has been run through it** |
| Plan entitlements / usage quotas per subscription tier, billing | **not implemented** (budgets cap spend; no plan model) |
| Real providers (discovery, enrichment, verification, intent feeds), CRM sync, calendar, email sending, LinkedIn | **not implemented** — need vendor accounts/credentials |
| Persistent job queue with priorities/dead-letter | **not implemented** — long calls run in the request's thread pool, bounded by the existing heavy-work limiter |
| UI for VectorSales | **not implemented** — API only |

## Measured (synthetic data, SQLite file on local disk)
Ingesting 5,000 candidate accounts through filter→dedupe→merge with no providers: 6.7 s before batching commits, 0.34 s after
(~14,600/s); re-import of the same 5,000: 0.34 s, no duplicates; scoring 500 accounts: 0.03 s. These are single-process
laptop-class numbers, not a capacity guarantee.

## Choosing models: the evaluation harness
```
python -m vectorsales.evaluate triggers my_labelled_cases.json \
    --model gpt-4o-mini:0.15:0.60 --model gpt-4o:2.50:10.00 --max-usd 2 --dry-run   # estimate first
python -m vectorsales.evaluate triggers my_labelled_cases.json --model gpt-4o-mini:0.15:0.60 --max-usd 2
```
(`NAME:USD_per_M_input_tokens:USD_per_M_output_tokens`; use your provider's current prices, plus its API key variable.)
A case is `{"documents":[{"source","text","authoritative"?}], "expected":[{"kind","contains"}], "injection"?: true}`;
`vectorsales/eval_cases/triggers_sample.json` shows the format (it is **synthetic and has 10 cases** — replace it with real,
hand-labelled documents; 30+ before the report calls itself conclusive). Each candidate (rules-only, then each model — which
runs *on top of* the rules, as in production) is run in an isolated store and ledger and reported with precision, recall and F1
(with 95% intervals), fabricated quotes the verifier had to discard, injection documents that produced triggers, model failures,
p50/p95 latency and cost per case. `recommend` then picks the **cheapest candidate that clears explicit thresholds** (default F1 ≥ 0.8,
precision ≥ 0.9, zero fabrications, zero acted-on injections) and shows what each extra dollar bought over rules-only.
Model runs require prices and are hard-capped (`--max-usd` per candidate). `drafts` does the same for email drafts, measuring
rule-compliant acceptance versus template fallback (tone still needs human review).
Run it before changing `VS_MODEL_CHEAP`/`VS_MODEL_STRONG` defaults, and again when a provider changes a model.

## Calibrating the score on real outcomes
1. Scores are **frozen when a decision is made** (an outreach draft, or its approval; at most one per account per 7 days).
2. Record what happened: `POST /vs/accounts/{id}/outcomes {"type": "meeting_booked" | "sales_accepted" | "opportunity" | "won" | "lost"}`
   (idempotent; the first time recorded stands).
3. `GET /vs/calibration?outcome=meeting_booked&window_days=60` compares each account's *first* frozen score with its outcome within the
   window. Accounts whose window hasn't closed are left out (not counted as failures). It reports base rate, bucket conversion rates with
   95% intervals, AUC overall and per component, whether buckets rise monotonically, and — only with enough data (≥100 closed accounts,
   ≥20 converted and ≥20 not) — an isotonic score→observed-rate map and **suggested weights** proportional to each component's lift over
   chance. With less data it says so and recommends nothing. If the score is no better than chance it says that too.
4. Weights are never changed automatically. A manager applies them with `PUT /vs/scoring/weights` (audited); the queue then uses them.
   The priority stays a ranking score; only the observed bucket rates describe likelihood, for that tenant, outcome and window.
