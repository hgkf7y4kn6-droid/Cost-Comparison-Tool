"""Commercial metrics with explicit formulas. A metric whose denominator is zero or whose
inputs were never recorded is None ("unavailable"), never 0 and never guessed."""
from typing import Dict, Optional


def ratio(numerator: Optional[float], denominator: Optional[float]) -> Optional[float]:
    if numerator is None or not denominator:
        return None
    return numerator / denominator


def unit_costs(total_cost_usd: float, counts: Dict[str, int]) -> Dict[str, Optional[float]]:
    """cost per X = attributable cost ÷ count of X.  counts keys: discovered, verified_decision_makers,
    qualified, meetings, sales_accepted. Costs are counted once (the caller passes each cost to one workflow)."""
    return {f"cost_per_{k}": (round(total_cost_usd / v, 4) if v else None) for k, v in counts.items()}


def funnel(counts: Dict[str, int]) -> Dict[str, Optional[float]]:
    return {
        "qualified_to_meeting": ratio(counts.get("meetings"), counts.get("qualified")),
        "meeting_to_opportunity": ratio(counts.get("opportunities"), counts.get("meetings")),
        "email_reply_rate": ratio(counts.get("replies"), counts.get("delivered")),
        "email_bounce_rate": ratio(counts.get("bounces"), counts.get("sent")),
        "unsubscribe_rate": ratio(counts.get("unsubscribes"), counts.get("delivered")),
        "contact_verification_coverage": ratio(counts.get("verified_contacts"), counts.get("contacts")),
        "enrichment_success_rate": ratio(counts.get("enrich_ok"), counts.get("enrich_attempts")),
    }


def gross_margin(revenue_usd: Optional[float], direct_cost_usd: float, allocated_infra_usd: float = 0.0) -> Dict[str, Optional[float]]:
    """Direct provider cost and shared infrastructure are reported separately."""
    if revenue_usd is None or revenue_usd <= 0:
        return {"gross_margin_pct": None, "contribution_usd": None}
    contrib = revenue_usd - direct_cost_usd
    return {"contribution_usd": round(contrib, 2), "gross_margin_pct": round(100 * (contrib - allocated_infra_usd) / revenue_usd, 1)}
