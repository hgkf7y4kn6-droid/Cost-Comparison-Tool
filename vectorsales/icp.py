"""Deterministic ICP matching: hard eligibility vs weighted preference, with reasons."""
from typing import Any, Dict, List

from .models import ICP
from .normalize import domain_of


def _num(v: Any):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def match_icp(icp: ICP, acct: Dict[str, Any]) -> Dict[str, Any]:
    """Returns {eligible, fit (0-100), matched, missed, unknown, reasons}.

    A criterion whose data is missing is *unknown*: it never counts as a pass. If it is
    a hard criterion the account is not eligible yet (`needs_data`), not rejected."""
    matched: List[str] = []
    missed: List[str] = []
    unknown: List[str] = []
    reasons: List[str] = []
    hard_fail: List[str] = []
    needs_data: List[str] = []
    weights = {"industry": 25, "employees": 25, "revenue": 10, "geography": 20, "technology": 20}
    earned = possible = 0

    def settle(name: str, state: str, why: str, hard: bool) -> None:
        nonlocal earned, possible
        w = weights.get(name, 0)
        if state == "unknown":
            unknown.append(name)
            possible += w
            if hard:
                needs_data.append(name)
            reasons.append(f"{name}: unknown ({why})")
            return
        possible += w
        if state == "match":
            matched.append(name)
            earned += w
            reasons.append(f"{name}: {why}")
        else:
            missed.append(name)
            reasons.append(f"{name}: {why}")
            if hard:
                hard_fail.append(name)

    ind = (acct.get("industry") or "").lower().strip()
    if icp.industries:
        if not ind:
            settle("industry", "unknown", "no industry on record", "industry" in icp.hard)
        elif any(i.lower() in ind or ind in i.lower() for i in icp.industries):
            settle("industry", "match", f"'{ind}' is a target industry", "industry" in icp.hard)
        else:
            settle("industry", "miss", f"'{ind}' is not a target industry", "industry" in icp.hard)

    emp = _num(acct.get("employees"))
    if icp.employee_min is not None or icp.employee_max is not None:
        if emp is None:
            settle("employees", "unknown", "headcount not known", "employees" in icp.hard)
        else:
            ok = (icp.employee_min is None or emp >= icp.employee_min) and (icp.employee_max is None or emp <= icp.employee_max)
            settle("employees", "match" if ok else "miss", f"{int(emp)} employees {'within' if ok else 'outside'} {icp.employee_min}–{icp.employee_max}", "employees" in icp.hard)

    rev = _num(acct.get("revenue"))
    if icp.revenue_min is not None or icp.revenue_max is not None:
        if rev is None:
            settle("revenue", "unknown", "revenue not known", "revenue" in icp.hard)
        else:
            ok = (icp.revenue_min is None or rev >= icp.revenue_min) and (icp.revenue_max is None or rev <= icp.revenue_max)
            settle("revenue", "match" if ok else "miss", f"revenue {'within' if ok else 'outside'} range", "revenue" in icp.hard)

    if icp.countries or icp.states:
        country, state = (acct.get("country") or "").upper(), (acct.get("state") or "").upper()
        if not country and not state:
            settle("geography", "unknown", "no location on record", "geography" in icp.hard)
        else:
            ok = (not icp.countries or not country or country in [c.upper() for c in icp.countries]) and \
                 (not icp.states or not state or state in [s.upper() for s in icp.states])
            settle("geography", "match" if ok else "miss", f"{state or country} {'is' if ok else 'is not'} in territory", "geography" in icp.hard)

    if icp.technologies:
        have = [t.lower() for t in (acct.get("technologies") or [])]
        if not have:
            settle("technology", "unknown", "technology stack not known", False)
        else:
            hit = [t for t in icp.technologies if t.lower() in have]
            settle("technology", "match" if hit else "miss", f"uses {', '.join(hit)}" if hit else "none of the target technologies", False)

    excluded = False
    if "excluded" in icp.hard or icp.exclude_domains or icp.exclude_industries:
        d = domain_of(acct.get("domain") or acct.get("website"))
        if d and d in [domain_of(x) or x.lower() for x in icp.exclude_domains]:
            excluded = True
            reasons.append(f"excluded: {d} is on the exclusion list")
        if ind and any(x.lower() in ind for x in icp.exclude_industries):
            excluded = True
            reasons.append(f"excluded: industry '{ind}'")

    eligible = not hard_fail and not excluded and not needs_data
    status = "excluded" if excluded else "ineligible" if hard_fail else "needs_data" if needs_data else "eligible"
    return {
        "eligible": eligible, "status": status, "needs_data": needs_data, "hard_fail": hard_fail,
        "fit": round(100 * earned / possible) if possible else 0,
        "matched": matched, "missed": missed, "unknown": unknown, "reasons": reasons,
    }
