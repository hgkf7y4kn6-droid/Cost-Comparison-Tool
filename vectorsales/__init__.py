"""VectorSales prospecting and revenue-intelligence engine.

Layout (cheapest, most reliable tier first):

- Tier 1, plain code: icp, scoring, triggers, outreach rules, geo, qualification,
  ledger (cost and budgets), store (tenant-scoped records with provenance),
  providers (budgeted, rate-limited, circuit-broken data access), pipeline.
- Tier 2/3, CrewAI (crews.py): classifying documents into triggers and writing
  outreach. Used only when a model is configured and the budget allows; output is
  schema-checked and verified against the source text; every failure falls back to
  deterministic behaviour.

Nothing here sends mail, edits a CRM or books a meeting by itself: those need an
explicitly configured integration plus an approval, and are recorded in the audit log.
"""
