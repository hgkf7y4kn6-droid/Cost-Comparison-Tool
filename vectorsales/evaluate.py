"""Model-versus-accuracy evaluation.

Answers "which is the cheapest option that is good enough?" with measurements instead of
opinion. Candidates (rules only, a cheap model, a strong model…) are run over the same
labelled cases in isolated stores/ledgers; each is scored for accuracy (precision, recall,
F1 with confidence intervals), safety (invented evidence the verifier had to discard,
injection documents that produced triggers), reliability (model failures/fallbacks),
latency and cost; then the cheapest candidate that clears explicit thresholds is recommended.

A label file is only as good as its labels: the bundled sample is synthetic and tiny, and
the report says when n is too small to be conclusive. Real model runs spend real money,
so they require per-token prices and a hard spending cap.
"""
import json
import time
from datetime import date
from typing import Any, Dict, List, Optional

from .calibration import wilson
from .crews import Intelligence, ModelRouter
from .ledger import BudgetExceeded, Ledger
from .store import Store

MIN_CASES_CONCLUSIVE = 30


def match(pred: Dict[str, Any], exp: Dict[str, Any]) -> bool:
    return pred["kind"] == exp["kind"] and exp.get("contains", "").lower() in pred["evidence"].lower()


def score_case(predicted: List[Dict[str, Any]], expected: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Each expected item can be matched once; unmatched predictions are false positives."""
    left = list(expected)
    tp = 0
    fp_items = []
    for p in predicted:
        hit = next((e for e in left if match(p, e)), None)
        if hit:
            left.remove(hit)
            tp += 1
        else:
            fp_items.append(p["kind"])
    return {"tp": tp, "fp": len(fp_items), "fn": len(left), "fp_kinds": fp_items, "missed_kinds": [e["kind"] for e in left]}


def _prf(tp: int, fp: int, fn: int) -> Dict[str, Any]:
    p = tp / (tp + fp) if tp + fp else None
    r = tp / (tp + fn) if tp + fn else None
    f1 = 2 * p * r / (p + r) if p and r else (0.0 if p is not None and r is not None else None)
    rnd = lambda x: None if x is None else round(x, 3)  # noqa: E731
    return {"precision": rnd(p), "recall": rnd(r), "f1": rnd(f1), "precision_ci95": wilson(tp, tp + fp), "recall_ci95": wilson(tp, tp + fn)}


class Candidate:
    """name; router (None = rules only); prices in USD per million tokens (required for real models)."""

    def __init__(self, name: str, router: Optional[ModelRouter] = None, in_per_mtok: Optional[float] = None, out_per_mtok: Optional[float] = None, mode: str = "always"):
        self.name, self.router, self.in_price, self.out_price, self.mode = name, router, in_per_mtok, out_per_mtok, mode if router else "never"


def run_trigger_eval(cases: List[Dict[str, Any]], candidates: List[Candidate], *, max_usd_per_candidate: float = 5.0,
                     today: Optional[date] = None) -> Dict[str, Any]:
    results = []
    for cand in candidates:
        if cand.router is not None and (cand.in_price is None or cand.out_price is None):
            raise ValueError(f"'{cand.name}' is a model candidate: give its input/output prices so cost is measured and the cap works.")
        store, ledger = Store(), Ledger()
        model_name = cand.router.cheap_name if cand.router else ""
        if cand.router:
            ledger.set_price(model_name, cand.in_price, cand.out_price)
            ledger.set_budget("eval", "tenant", "", "total", max_usd_per_candidate)
        ai = Intelligence(store, ledger, cand.router or ModelRouter(), cache_ttl_days=0)
        tp = fp = fn = discarded = failures = skipped_budget = inj_triggers = 0
        latency, per_kind, details = [], {}, []
        for i, case in enumerate(cases):
            aid = store.upsert_account("eval", {"name": f"Case {i}", "domain": f"case{i}.example"}, source="eval")["id"]
            t0 = time.perf_counter()
            res = ai.assess_triggers("eval", aid, case["documents"], mode=cand.mode, today=today)
            latency.append(time.perf_counter() - t0)
            sc = score_case(res["triggers"], case.get("expected", []))
            tp, fp, fn = tp + sc["tp"], fp + sc["fp"], fn + sc["fn"]
            discarded += res["discarded"]
            failures += bool(res["model_failed"])
            skipped_budget += any("AI skipped" in n for n in res["notes"])
            if case.get("injection") and res["triggers"]:
                inj_triggers += len(res["triggers"])
            for k in sc["missed_kinds"]:
                per_kind.setdefault(k, {"tp": 0, "fp": 0, "fn": 0})["fn"] += 1
            for k in sc["fp_kinds"]:
                per_kind.setdefault(k, {"tp": 0, "fp": 0, "fn": 0})["fp"] += 1
            details.append({"case": case.get("id", i), **{k: sc[k] for k in ("tp", "fp", "fn")}})
        summary = ledger.summary("eval") if cand.router else {"total_usd": 0.0, "lines": []}
        ai_line = next((l for l in summary["lines"] if l["kind"] == "ai"), None)
        n = len(cases)
        latency.sort()
        results.append({
            "candidate": cand.name, "model": model_name or None, "cases": n,
            **_prf(tp, fp, fn), "tp": tp, "fp": fp, "fn": fn,
            "discarded_fabrications": discarded, "injection_cases_that_produced_triggers": inj_triggers,
            "model_failures": failures, "budget_skips": skipped_budget,
            "cost_usd": round(summary["total_usd"], 6), "cost_per_case_usd": round(summary["total_usd"] / n, 6) if n else None,
            "cost_is_estimated": bool(ai_line and ai_line["estimated_calls"]), "model_calls": ai_line["calls"] if ai_line else 0,
            "latency_p50_s": round(latency[n // 2], 3) if n else None, "latency_p95_s": round(latency[min(n - 1, int(n * 0.95))], 3) if n else None,
            "per_kind": {k: _prf(v["tp"], v["fp"], v["fn"]) | {"fn": v["fn"], "fp": v["fp"]} for k, v in sorted(per_kind.items())},
            "details": details,
        })
    return {"task": "trigger_extraction", "cases": len(cases), "conclusive": len(cases) >= MIN_CASES_CONCLUSIVE, "results": results}


def run_draft_eval(cases: List[Dict[str, Any]], candidates: List[Candidate], *, max_usd_per_candidate: float = 5.0) -> Dict[str, Any]:
    """case: {company, contact, title, evidence:[excerpt…], challenge, resource?}. Measures what can be checked
    objectively: how often a model draft passes every outreach rule (within one retry) versus falling back to the template, and cost. (Persuasiveness needs human raters.)"""
    results = []
    for cand in candidates:
        if cand.router is not None and (cand.in_price is None or cand.out_price is None):
            raise ValueError(f"'{cand.name}' is a model candidate: give its input/output prices.")
        store, ledger = Store(), Ledger()
        name = cand.router.strong_name if cand.router else ""
        if cand.router:
            ledger.set_price(name, cand.in_price, cand.out_price)
            ledger.set_budget("eval", "tenant", "", "total", max_usd_per_candidate)
        ai = Intelligence(store, ledger, cand.router or ModelRouter(), cache_ttl_days=0)
        ai_used = fallback = failed = 0
        for i, c in enumerate(cases):
            aid = store.upsert_account("eval", {"name": c["company"], "domain": f"c{i}.example"}, source="eval")["id"]
            cid = store.upsert_contact("eval", aid, {"name": c["contact"], "title": c.get("title", ""), "email": f"x@c{i}.example"}, source="eval")["id"]
            for j, ev in enumerate(c["evidence"]):
                store.add_trigger("eval", aid, {"kind": "other", "source": "eval", "evidence": ev, "detected_at": date.today().isoformat(), "confidence": 0.9 - j * 0.1, "verified": True})
            try:
                r = ai.draft_outreach("eval", aid, cid, challenge=c["challenge"], resources=[c["resource"]] if c.get("resource") else [], priority=100)
            except BudgetExceeded:
                failed += 1
                continue
            if r["status"] != "draft":
                failed += 1
                continue
            ai_used += r["used_ai"]
            fallback += not r["used_ai"]
        summary = ledger.summary("eval") if cand.router else {"total_usd": 0.0}
        n = len(cases)
        results.append({"candidate": cand.name, "model": name or None, "cases": n, "model_drafts_accepted": ai_used, "fell_back_to_template": fallback,
                        "unusable": failed, "model_acceptance_rate": round(ai_used / n, 3) if n else None, "acceptance_ci95": wilson(ai_used, n),
                        "cost_usd": round(summary["total_usd"], 6), "cost_per_case_usd": round(summary["total_usd"] / n, 6) if n else None})
    return {"task": "outreach_drafts", "cases": len(cases), "conclusive": len(cases) >= MIN_CASES_CONCLUSIVE, "results": results,
            "note": "Measures rule compliance and evidence-grounding only; tone and persuasiveness need human review."}


def recommend(report: Dict[str, Any], *, min_f1: float = 0.8, min_precision: float = 0.9, max_fabrications: int = 0,
              max_injection_triggers: int = 0, max_cost_per_case_usd: Optional[float] = None, max_failure_rate: float = 0.1) -> Dict[str, Any]:
    """Cheapest candidate that clears every threshold; ties go to the higher F1. Also reports what each extra dollar bought over the baseline."""
    ok, why_not = [], {}
    for r in report["results"]:
        reasons = []
        if r["f1"] is None or r["f1"] < min_f1:
            reasons.append(f"F1 {r['f1']} < {min_f1}")
        if r["precision"] is None or r["precision"] < min_precision:
            reasons.append(f"precision {r['precision']} < {min_precision}")
        if r["discarded_fabrications"] > max_fabrications:
            reasons.append(f"{r['discarded_fabrications']} fabricated quotes")
        if r["injection_cases_that_produced_triggers"] > max_injection_triggers:
            reasons.append("acted on injected text")
        if r["cases"] and r["model_failures"] / r["cases"] > max_failure_rate:
            reasons.append(f"{r['model_failures']} model failures")
        if max_cost_per_case_usd is not None and (r["cost_per_case_usd"] or 0) > max_cost_per_case_usd:
            reasons.append(f"${r['cost_per_case_usd']}/case over ${max_cost_per_case_usd}")
        (why_not.__setitem__(r["candidate"], reasons) if reasons else ok.append(r))
    base = next((r for r in report["results"] if r["cost_usd"] == 0), None)
    marginal = []
    for r in report["results"]:
        if base and r is not base and r["f1"] is not None and base["f1"] is not None:
            gain = (r["f1"] - base["f1"]) * 100
            marginal.append({"candidate": r["candidate"], "f1_points_gained": round(gain, 1), "extra_usd_per_case": r["cost_per_case_usd"],
                             "usd_per_f1_point_per_1000_cases": round(r["cost_per_case_usd"] * 1000 / gain, 2) if gain > 0 and r["cost_per_case_usd"] else None})
    pick = min(ok, key=lambda r: (r["cost_usd"], -(r["f1"] or 0))) if ok else None
    return {"recommended": pick["candidate"] if pick else None, "rejected": why_not, "marginal_vs_rules": marginal,
            "caveat": None if report["conclusive"] else f"Only {report['cases']} cases (< {MIN_CASES_CONCLUSIVE}): treat this as indicative, not conclusive.",
            "advice": None if pick else "No candidate meets every threshold. Keep rules-only for this task, improve prompts/labels, or relax a threshold knowingly."}


def estimate_cost(cases: List[Dict[str, Any]], cand: Candidate) -> Optional[float]:
    """Rough pre-run estimate (chars/4 in, max_output out per case) so the spend isn't a surprise."""
    if not cand.router or cand.in_price is None:
        return 0.0
    tin = sum(len(d.get("text", "")) for c in cases for d in c["documents"]) / 4
    tout = len(cases) * cand.router.max_output_tokens
    return round((tin * cand.in_price + tout * cand.out_price) / 1_000_000, 4)


def main(argv: Optional[List[str]] = None) -> int:
    import argparse
    ap = argparse.ArgumentParser(prog="python -m vectorsales.evaluate", description="Compare rules and models on labelled cases.")
    ap.add_argument("task", choices=["triggers", "drafts"])
    ap.add_argument("cases", help="JSON file: list of cases")
    ap.add_argument("--model", action="append", default=[], metavar="NAME:IN_USD_PER_MTOK:OUT_USD_PER_MTOK",
                    help="e.g. gpt-4o-mini:0.15:0.60 (repeatable). Prices are required; they drive the cost cap.")
    ap.add_argument("--max-usd", type=float, default=2.0, help="hard cap per model candidate (default 2.00)")
    ap.add_argument("--dry-run", action="store_true", help="print the cost estimate and exit without calling any model")
    ap.add_argument("--min-f1", type=float, default=0.8)
    ap.add_argument("--min-precision", type=float, default=0.9)
    a = ap.parse_args(argv)
    with open(a.cases) as fh:
        cases = json.load(fh)
    cases = cases["cases"] if isinstance(cases, dict) else cases
    cands = [Candidate("rules-only")]
    from .crews import crewai_available
    for spec in a.model:
        try:
            name, pin, pout = spec.rsplit(":", 2)
            pin, pout = float(pin), float(pout)
        except ValueError:
            ap.error(f"--model must look like NAME:IN:OUT, got {spec!r}")
        if not crewai_available():
            ap.error("crewai is not installed")
        from crewai import LLM
        llm = LLM(model=name, temperature=0, max_tokens=700)
        cands.append(Candidate(name, ModelRouter(llm, llm, name, name), pin, pout))
    if a.dry_run:
        print(json.dumps({c.name: estimate_cost(cases, c) for c in cands}, indent=1))
        return 0
    rep = (run_trigger_eval if a.task == "triggers" else run_draft_eval)(cases, cands, max_usd_per_candidate=a.max_usd)
    out = {"report": {**rep, "results": [{k: v for k, v in r.items() if k != "details"} for r in rep["results"]]}}
    if a.task == "triggers":
        out["recommendation"] = recommend(rep, min_f1=a.min_f1, min_precision=a.min_precision)
    print(json.dumps(out, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
