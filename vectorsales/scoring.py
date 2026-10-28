"""Explainable scores. Fit, intent, contactability, evidence and overall priority are
separate numbers; the priority is a documented weighted blend, not a conversion
probability. Calibrate against real outcomes with calibration() before trusting it."""
from datetime import date, datetime
from typing import Any, Dict, List, Optional

from .models import TRIGGER_TIER

DEFAULT_WEIGHTS = {"fit": 0.30, "intent": 0.35, "contactability": 0.20, "evidence": 0.15}
TIER_STRENGTH = {1: 1.0, 2: 0.45}
HALF_LIFE_DAYS = {1: 45, 2: 20}  # how fast each tier's signal fades
SENIORITY = [("chief|ceo|cfo|coo|cio|cto|cmo|president|owner|founder", 1.0), ("vp|vice president|head of|director", 0.85),
             ("manager|lead|principal", 0.55), ("", 0.25)]


def _day(s: Optional[str]) -> Optional[date]:
    try:
        return datetime.fromisoformat(s).date() if s else None
    except ValueError:
        return None


def freshness(trigger: Dict[str, Any], today: Optional[date] = None) -> float:
    """1.0 on the day of the event, halving every half-life; unknown dates count as stale (0.25)."""
    today = today or date.today()
    d = _day(trigger.get("observed_at"))
    if d is None:
        return 0.25
    age = max((today - d).days, 0)
    return 0.5 ** (age / HALF_LIFE_DAYS[TRIGGER_TIER.get(trigger.get("kind", "other"), 2)])


def intent_score(triggers: List[Dict[str, Any]], today: Optional[date] = None) -> Dict[str, Any]:
    items, best = [], 0.0
    for t in triggers:
        if t.get("processed") and not t.get("force"):
            continue
        tier = TRIGGER_TIER.get(t.get("kind", "other"), 2)
        f = freshness(t, today)
        verified = 1.0 if t.get("verified") else 0.5  # an inferred signal counts half
        v = TIER_STRENGTH[tier] * f * float(t.get("confidence", 0.5)) * verified * (0.5 + 0.5 * float(t.get("relevance", 0.5)))
        items.append({"kind": t.get("kind"), "tier": tier, "freshness": round(f, 2), "verified": bool(t.get("verified")), "value": round(v, 3), "source": t.get("source")})
        best = max(best, v)
    # strongest signal dominates; extra signals add a little (diminishing)
    extra = sum(sorted((i["value"] for i in items), reverse=True)[1:3]) * 0.25
    return {"score": round(min(1.0, best + extra) * 100), "signals": items}


def contact_score(contacts: List[Dict[str, Any]], target_titles: List[str], suppressed: Optional[callable] = None) -> Dict[str, Any]:
    import re
    best, why = 0.0, "no contacts on record"
    for c in contacts:
        v = c.get("values", c)
        title = (v.get("title") or "").lower()
        senior = next(w for pat, w in SENIORITY if not pat or re.search(rf"\b({pat})\b", title))
        role = 1.0 if any(t.lower() in title for t in target_titles) else 0.5 if not target_titles else 0.3
        email = v.get("email")
        status = v.get("email_status")
        deliver = 0.0
        if email and not (suppressed and suppressed(email)):
            deliver = 1.0 if status == "valid" else 0.0 if status == "invalid" else 0.4  # unverified: usable but not safe
        s = (0.35 * senior + 0.25 * role + 0.40 * deliver)
        if s > best:
            best = s
            why = f"{v.get('name') or 'contact'}: seniority {senior:.2f}, role fit {role:.2f}, email {'verified' if deliver == 1.0 else 'unverified' if deliver else 'unusable or missing'}"
    return {"score": round(best * 100), "why": why}


def evidence_score(triggers: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not triggers:
        return {"score": 0, "why": "no evidence on record"}
    good = sum(1 for t in triggers if t.get("source") and len(t.get("evidence", "")) >= 20)
    ver = sum(1 for t in triggers if t.get("verified"))
    return {"score": round(100 * (0.6 * good + 0.4 * ver) / len(triggers)), "why": f"{good}/{len(triggers)} with a source and excerpt, {ver} verified"}


def priority(fit: int, intent: Dict, contact: Dict, evidence: Dict, weights: Optional[Dict[str, float]] = None,
             est_cost_usd: float = 0.0, value_usd: float = 0.0) -> Dict[str, Any]:
    w = {**DEFAULT_WEIGHTS, **(weights or {})}
    total_w = sum(w.values()) or 1.0
    parts = {"fit": fit, "intent": intent["score"], "contactability": contact["score"], "evidence": evidence["score"]}
    base = sum(parts[k] * w[k] for k in parts) / total_w
    # cost-aware: expensive-to-pursue accounts are ranked down only when we know both numbers
    adj = 0.0
    if value_usd > 0 and est_cost_usd > 0:
        adj = -min(15.0, 15.0 * est_cost_usd / value_usd)
    return {"priority": max(0, round(base + adj)), "parts": parts, "weights": w, "cost_adjustment": round(adj, 1),
            "explanation": [f"{k} {v} × {w[k] / total_w:.2f}" for k, v in parts.items()] + ([f"cost adjustment {adj:.1f}"] if adj else [])}


def calibration(outcomes: List[Dict[str, Any]], buckets: int = 5) -> List[Dict[str, Any]]:
    """outcomes: [{priority:int, converted:bool}] -> observed conversion per priority bucket,
    so the score can be checked against real results. Buckets with no data report None."""
    out = []
    width = 100 / buckets
    for b in range(buckets):
        lo, hi = b * width, (b + 1) * width + (1 if b == buckets - 1 else 0)
        sel = [o for o in outcomes if lo <= o["priority"] < hi]
        out.append({"range": f"{int(lo)}-{int(min(100, hi - (0 if b == buckets - 1 else 1)))}", "n": len(sel),
                    "conversion": (sum(1 for o in sel if o["converted"]) / len(sel)) if sel else None})
    return out
