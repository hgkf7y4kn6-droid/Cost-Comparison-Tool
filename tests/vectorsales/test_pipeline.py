import time

import pytest

from vectorsales.ledger import BudgetExceeded, Ledger, USD
from vectorsales.models import ICP
from vectorsales.pipeline import Pipeline
from vectorsales.providers import AllProvidersFailed, NoProvider, Provider, ProviderError, Registry
from vectorsales.store import Store


class Fake(Provider):
    def __init__(self, name, capability, results, cost=1000, tier=1):
        self.name, self.capability, self.cost_per_call_micro, self.tier = name, capability, cost, tier
        self.results, self.calls = list(results), 0

    def call(self, payload):
        self.calls += 1
        r = self.results[min(self.calls - 1, len(self.results) - 1)]
        if isinstance(r, Exception):
            raise r
        return r(payload) if callable(r) else r


class Clock:
    def __init__(self):
        self.t = 0.0
        self.sleeps = []

    def now(self):
        return self.t

    def sleep(self, s):
        self.sleeps.append(s)
        self.t += s


def registry(ledger, clock=None):
    clock = clock or Clock()
    return Registry(ledger, sleep=clock.sleep, clock=clock.now, rng=lambda: 0.5), clock


# ---- providers --------------------------------------------------------------------------------
def test_retries_with_backoff_then_succeeds_and_charges_once():
    led = Ledger(); reg, clk = registry(led)
    p = Fake("p", "cap", [ProviderError("boom"), ProviderError("boom"), {"ok": 1}], cost=500)
    reg.register(p, retries=2)
    assert reg.call("cap", {}, tenant="t", operation="op") == ("p", {"ok": 1})
    assert p.calls == 3 and clk.sleeps == [0.5, 1.0]                      # exponential, jitter factor 1.0 at rng=.5
    line = led.summary("t")["lines"][0]
    assert line["calls"] == 1 and line["cost_usd"] == pytest.approx(500 / USD) and line["failures"] == 0


def test_falls_back_to_next_provider_and_failed_attempts_cost_nothing():
    led = Ledger(); reg, _ = registry(led)
    bad = Fake("bad", "cap", [ProviderError("down")], cost=900)
    good = Fake("good", "cap", [{"v": 1}], cost=100)
    reg.register(bad, priority=1, retries=1); reg.register(good, priority=2)
    assert reg.call("cap", {}, tenant="t")[0] == "good"
    costs = led.cost_by("t", "provider")
    assert costs["bad"] == 0 and costs["good"] == 100
    assert led.summary("t")["lines"][0]["failures"] == 1


def test_circuit_opens_then_half_opens_after_cooldown():
    led = Ledger(); reg, clk = registry(led)
    p = Fake("p", "cap", [ProviderError("x")] * 3 + [{"ok": 1}])
    reg.register(p, retries=0, fail_threshold=2, cooldown=60)
    for _ in range(2):
        with pytest.raises(AllProvidersFailed):
            reg.call("cap", {}, tenant="t")
    before = p.calls
    with pytest.raises(AllProvidersFailed, match="temporarily disabled"):
        reg.call("cap", {}, tenant="t")
    assert p.calls == before and reg.health()[0]["circuit"] == "open"
    clk.t += 61
    with pytest.raises(AllProvidersFailed):                              # half-open probe fails -> reopens
        reg.call("cap", {}, tenant="t")
    clk.t += 61
    reg.call("cap", {}, tenant="t")
    assert reg.health()[0]["circuit"] == "closed"


def test_timeout_is_a_provider_error():
    led = Ledger(); reg, _ = registry(led)
    reg.register(Fake("slow", "cap", [lambda p: time.sleep(0.3) or {}]), timeout=0.05, retries=0)
    with pytest.raises(AllProvidersFailed, match="timed out"):
        reg.call("cap", {}, tenant="t")


def test_budget_stops_calls_without_trying_other_providers_and_no_provider_is_explicit():
    led = Ledger(); reg, _ = registry(led)
    led.set_budget("t", "provider", "p", "total", 0.001)
    a, b = Fake("p", "cap", [{}], cost=2000), Fake("other", "cap", [{}], cost=1)
    reg.register(a, priority=1); reg.register(b, priority=2)
    with pytest.raises(BudgetExceeded):
        reg.call("cap", {}, tenant="t")
    assert a.calls == 0 and b.calls == 0
    with pytest.raises(NoProvider):
        reg.call("unknown", {}, tenant="t")


def test_provider_reported_cost_replaces_estimate():
    led = Ledger(); reg, _ = registry(led)
    p = Fake("p", "cap", [{"x": 1}], cost=1000); p.actual_cost_micro = lambda r: 250
    reg.register(p)
    reg.call("cap", {}, tenant="t")
    assert led.summary("t")["lines"][0]["estimated_calls"] == 0 and led.cost_by("t", "provider")["p"] == 250


# ---- pipeline ---------------------------------------------------------------------------------------
ICP1 = ICP(industries=["software"], employee_min=50, employee_max=500, target_titles=["operations"], hard=["employees", "excluded"], exclude_domains=["bad.com"])


def build():
    store, led = Store(), Ledger()
    reg, _ = registry(led)
    return store, led, reg, Pipeline(store, led, reg)


def test_cheap_filters_run_before_any_paid_call():
    store, led, reg, pipe = build()
    ent = Fake("ent", "company_enrichment", [{"account": {"employees": 100}}]); reg.register(ent)
    res = pipe.ingest("t", [{"name": "Tiny", "domain": "tiny.com", "industry": "software", "employees": 5},
                            {"name": "Excl", "domain": "bad.com", "employees": 100}, {"name": ""}], source="csv", icp=ICP1)
    assert res["stats"]["discovered"] == 2 and res["stats"]["filtered_out"] == 2 and ent.calls == 0
    assert store.list_accounts("t") == []


def test_enriches_only_when_data_missing_and_promising_and_reuses_stored_data():
    store, led, reg, pipe = build()
    ent = Fake("ent", "company_enrichment", [{"account": {"employees": 120}, "source": "ent", "confidence": 0.8}]); reg.register(ent)
    cands = [{"name": "Acme", "domain": "acme.com", "industry": "software"},                       # employees unknown -> enrich
             {"name": "Known", "domain": "known.com", "industry": "software", "employees": 100},     # nothing to fill
             {"name": "Weak", "domain": "weak.com", "industry": "mining"}]                           # unknown but not promising
    res = pipe.ingest("t", cands, source="csv", icp=ICP1, enrich_min_fit=50)
    assert ent.calls == 1 and res["stats"]["enriched"] == 1
    assert store.get_account("t", res["ids"][0])["values"]["employees"] == 120
    res2 = pipe.ingest("t", cands, source="csv", icp=ICP1, enrich_min_fit=50)       # re-import: stored data reused
    assert ent.calls == 1 and res2["stats"]["merged"] == 3 and len(store.list_accounts("t")) == 3
    assert store.get_account("t", res["ids"][2])["status"] == "needs_data"


def test_progressive_contact_flow_with_escalation_only_for_high_priority():
    store, led, reg, pipe = build()
    reg.register(Fake("cheap", "contact_enrichment", [{"contacts": [{"name": "Jo Smith", "title": "VP Operations", "email": "jo@acme.com"}], "source": "cheap"}], tier=1))
    reg.register(Fake("ver", "email_verification", [{"valid": False, "source": "ver"}]))
    prem = Fake("premium", "contact_enrichment", [{"contacts": [{"name": "Al Jones", "title": "Director of Operations", "email": "al@acme.com", "email_verified": True}], "source": "premium"}], cost=50_000, tier=2)
    reg.register(prem)
    acct = [{"name": "Acme", "domain": "acme.com", "industry": "software", "employees": 100}]
    low = pipe.ingest("t", acct, source="csv", icp=ICP1, escalate_min_priority=99)
    assert prem.calls == 0 and low["stats"]["emails_verified"] == 1 and low["stats"]["review"] == 1     # invalid email -> review, no premium spend
    store2, led2, reg2, pipe2 = build()
    for p in reg.states:
        reg2.register(p.p) if p.p.name != "premium" else None
    prem2 = Fake("premium", "contact_enrichment", prem.results, cost=50_000, tier=2); reg2.register(prem2)
    store2.add_trigger("t", __import__("vectorsales.normalize", fromlist=["x"]).account_id("acme.com", "Acme"),
                       {"kind": "funding", "source": "news", "evidence": "Acme raised $12 million in Series B.", "detected_at": "2026-06-01", "observed_at": "2026-06-01", "confidence": 0.9, "verified": True, "relevance": 0.9})
    high = pipe2.ingest("t", acct, source="csv", icp=ICP1, escalate_min_priority=1)
    assert prem2.calls == 1 and high["stats"]["escalated"] == 1
    assert any(c["values"].get("email_status") == "valid" for c in store2.contacts_for("t", high["ids"][0]))
    assert high["stage_costs_usd"]["escalate_contacts"] > high["stage_costs_usd"]["find_contacts"]


def test_free_mail_addresses_are_not_sent_for_paid_verification():
    store, led, reg, pipe = build()
    reg.register(Fake("c", "contact_enrichment", [{"contacts": [{"name": "Jo", "email": "jo@gmail.com"}]}]))
    ver = Fake("v", "email_verification", [{"valid": True}]); reg.register(ver)
    pipe.ingest("t", [{"name": "Acme", "domain": "acme.com", "industry": "software", "employees": 100}], source="s", icp=ICP1)
    assert ver.calls == 0


def test_hard_budget_stops_the_run_and_reports_it():
    store, led, reg, pipe = build()
    led.set_budget("t", "tenant", "", "total", 0.0015)           # room for one 1000-micro call, not two
    reg.register(Fake("ent", "company_enrichment", [{"account": {"employees": 100}}], cost=1000))
    cands = [{"name": f"Co{i}", "domain": f"co{i}.com", "industry": "software"} for i in range(5)]
    res = pipe.ingest("t", cands, source="s", icp=ICP1)
    assert res["stopped"] and res["stats"]["enriched"] == 1 and led.summary("t")["total_usd"] <= 0.0015
    assert store.audit_log("t")[0]["action"] == "budget_stop"


def test_provider_outage_routes_account_to_review_not_crash():
    store, led, reg, pipe = build()
    reg.register(Fake("ent", "company_enrichment", [ProviderError("down")]), retries=0)
    res = pipe.ingest("t", [{"name": "A", "domain": "a.com", "industry": "software"}], source="s", icp=ICP1)
    assert res["stats"]["review"] == 1 and store.get_account("t", res["ids"][0])["status"] == "review"


def test_no_providers_configured_still_ingests_and_scores_deterministically():
    store, led = Store(), Ledger()
    pipe = Pipeline(store, led, None)
    res = pipe.ingest("t", [{"name": "A", "domain": "a.com", "industry": "software", "employees": 100}], source="csv", icp=ICP1)
    sc = pipe.score("t", res["ids"][0], ICP1)
    assert sc["icp"]["eligible"] and sc["priority"]["priority"] > 0 and led.summary("t")["total_usd"] == 0
