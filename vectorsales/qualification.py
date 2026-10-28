"""Qualification readiness. Unknown is not a pass."""
from typing import Any, Dict

FIELDS = ("budget", "authority", "need", "timeline", "fit", "intent", "contactability")
WEIGHTS = {"budget": 15, "authority": 20, "need": 20, "timeline": 10, "fit": 15, "intent": 10, "contactability": 10}
MANDATORY_FOR_HANDOFF = ("authority", "need", "contactability")


def assess(answers: Dict[str, Dict[str, Any]], *, threshold: int = 60, mandatory=MANDATORY_FOR_HANDOFF) -> Dict[str, Any]:
    """answers[field] = {"known": bool, "positive": bool, "evidence": str, "confidence": 0-1}.
    Only known + positive + evidenced answers earn points."""
    earned, parts, missing = 0.0, {}, []
    for f in FIELDS:
        a = answers.get(f) or {}
        known = bool(a.get("known"))
        ev = bool((a.get("evidence") or "").strip())
        if not known:
            parts[f] = {"status": "unknown", "points": 0}
            missing.append(f)
            continue
        if a.get("positive") and ev:
            pts = WEIGHTS[f] * float(a.get("confidence", 1.0))
        else:
            pts = 0
            if a.get("positive") and not ev:
                missing.append(f"{f} (no evidence)")
        parts[f] = {"status": "positive" if a.get("positive") else "negative", "points": round(pts, 1), "evidence": a.get("evidence", "")}
        earned += pts
    score = round(100 * earned / sum(WEIGHTS.values()))
    blockers = [f for f in mandatory if parts[f]["status"] != "positive" or parts[f]["points"] <= 0]
    if blockers:
        decision = "needs_human" if score >= threshold else "not_ready"
    else:
        decision = "ready" if score >= threshold else "not_ready"
    return {"score": score, "decision": decision, "blockers": blockers, "missing": missing, "parts": parts,
            "note": "Handoff needs a person to confirm because mandatory items are unproven." if decision == "needs_human" else ""}
