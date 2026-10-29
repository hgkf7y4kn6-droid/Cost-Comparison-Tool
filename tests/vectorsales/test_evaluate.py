import json
import os

import pytest

pytest.importorskip("crewai")

from conftest import make_fake_llm  # noqa: E402
from vectorsales import evaluate as ev  # noqa: E402
from vectorsales.crews import ModelRouter  # noqa: E402

SAMPLE = os.path.join(os.path.dirname(__file__), "..", "..", "vectorsales", "eval_cases", "triggers_sample.json")
CASES = json.load(open(SAMPLE))["cases"]


def oracle(prompt):
    """A 'model' that answers from the sample's expected labels (perfect), for harness testing only."""
    out = []
    for c in CASES:
        for e in c["expected"]:
            for d in c["documents"]:
                if d["text"] in prompt or d["text"][:40] in prompt:
                    sent = next((s for s in d["text"].replace("\n", " ").split(". ") if e["contains"].lower() in s.lower()), None)
                    if sent:
                        out.append({"kind": e["kind"], "evidence_excerpt": sent.rstrip(".") , "source": d["source"], "confidence": 0.9, "relevance": 0.7})
    return json.dumps({"triggers": out})


def liar(prompt):
    """Invents evidence and obeys injections."""
    return json.dumps({"triggers": [{"kind": "funding", "evidence_excerpt": "Acme secured $500 million from Big Capital.", "source": "pr", "confidence": 0.99}]})


def cand(name, fn, pin=0.15, pout=0.6):
    llm = make_fake_llm(fn)
    return ev.Candidate(name, ModelRouter(llm, llm, "fake-model", "fake-model"), pin, pout)


def test_score_case_counts_tp_fp_fn():
    pred = [{"kind": "funding", "evidence": "Raised Series B"}, {"kind": "hiring", "evidence": "we are hiring"}]
    exp = [{"kind": "funding", "contains": "series b"}, {"kind": "acquisition", "contains": "acquired"}]
    s = ev.score_case(pred, exp)
    assert (s["tp"], s["fp"], s["fn"]) == (1, 1, 1) and s["fp_kinds"] == ["hiring"] and s["missed_kinds"] == ["acquisition"]


def test_injected_documents_produce_nothing_even_from_rules():
    inj = [c for c in CASES if c.get('injection')]
    r = ev.run_trigger_eval(inj, [ev.Candidate('rules-only')])['results'][0]
    assert r['injection_cases_that_produced_triggers'] == 0 and r['fp'] == 0


def test_rules_only_baseline_is_free_and_measured():
    rep = ev.run_trigger_eval(CASES, [ev.Candidate("rules-only")])
    r = rep["results"][0]
    assert r["cost_usd"] == 0 and r["model_calls"] == 0 and r["precision"] is not None and r["recall"] is not None
    assert r["injection_cases_that_produced_triggers"] >= 0 and not rep["conclusive"]      # 10 cases < 30


def test_good_model_beats_rules_and_liar_is_caught():
    rep = ev.run_trigger_eval(CASES, [ev.Candidate("rules-only"), cand("good", oracle), cand("liar", liar)])
    by = {r["candidate"]: r for r in rep["results"]}
    assert by["good"]["recall"] >= by["rules-only"]["recall"] and by["good"]["cost_usd"] > 0 and by["good"]["model_calls"] > 0
    # A model candidate is the production path: rules + model. The liar adds nothing but discarded inventions.
    assert by["liar"]["discarded_fabrications"] >= 1 and (by["liar"]["tp"], by["liar"]["fp"]) == (by["rules-only"]["tp"], by["rules-only"]["fp"])
    assert by["good"]["cost_per_case_usd"] == pytest.approx(by["good"]["cost_usd"] / len(CASES), abs=1e-6)


def test_model_failures_are_counted_not_hidden():
    def boom(prompt):
        raise RuntimeError("down")
    rep = ev.run_trigger_eval(CASES, [cand("flaky", boom)])
    assert rep["results"][0]["model_failures"] >= 1


def test_recommendation_picks_cheapest_that_clears_thresholds():
    rep = ev.run_trigger_eval(CASES, [ev.Candidate("rules-only"), cand("good", oracle), cand("liar", liar)])
    rec = ev.recommend(rep, min_f1=0.0, min_precision=0.0)
    assert rec["recommended"] == "rules-only" and "liar" in rec["rejected"] and rec["caveat"]       # free option wins when it's good enough
    strict = ev.recommend(rep, min_f1=0.99, min_precision=0.99)
    assert strict["recommended"] in ("good", None) and "rules-only" in strict["rejected"] or strict["recommended"] == "good"
    assert any(m["candidate"] == "good" for m in strict["marginal_vs_rules"])


def test_nothing_qualifies_gives_honest_advice():
    rep = ev.run_trigger_eval(CASES, [cand("liar", liar)])
    rec = ev.recommend(rep, min_f1=0.5)
    assert rec["recommended"] is None and "No candidate" in rec["advice"]


def test_model_candidates_must_be_priced_and_budget_caps_spend():
    llm = make_fake_llm(oracle)
    with pytest.raises(ValueError, match="prices"):
        ev.run_trigger_eval(CASES, [ev.Candidate("unpriced", ModelRouter(llm, llm, "fake-model", "fake-model"))])
    rep = ev.run_trigger_eval(CASES, [cand("capped", oracle, pin=1e6, pout=1e6)], max_usd_per_candidate=0.0001)
    r = rep["results"][0]
    assert r["budget_skips"] >= 1 and r["cost_usd"] <= 0.0001


def test_draft_eval_reports_acceptance_and_cost():
    good_email = lambda p: json.dumps({"subject": "An idea for Acme re: staffing", "body": "Hi Jo, Acme will open a second plant in Allentown.\n\nThis often strains staffing.\n\nWorth a chat? If this isn't relevant, say so and I won't follow up (reply \"opt out\").",
                                       "evidence_refs": ["Acme will open a second plant in Allentown."]})
    cases = [{"company": "Acme", "contact": "Jo Smith", "evidence": ["Acme will open a second plant in Allentown."], "challenge": "staffing"}]
    rep = ev.run_draft_eval(cases, [ev.Candidate("template"), cand("writer", good_email)])
    by = {r["candidate"]: r for r in rep["results"]}
    assert by["template"]["fell_back_to_template"] == 1 and by["template"]["cost_usd"] == 0
    assert by["writer"]["model_drafts_accepted"] == 1 and by["writer"]["cost_usd"] > 0


def test_dry_run_estimate_and_cli(tmp_path, capsys):
    p = tmp_path / "c.json"
    p.write_text(json.dumps({"cases": CASES}))
    assert ev.estimate_cost(CASES, ev.Candidate("rules-only")) == 0.0
    assert ev.main(["triggers", str(p)]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["report"]["results"][0]["candidate"] == "rules-only" and out["recommendation"]["caveat"]
    with pytest.raises(SystemExit):
        ev.main(["triggers", str(p), "--model", "gpt-4o-mini"])         # missing prices is refused
