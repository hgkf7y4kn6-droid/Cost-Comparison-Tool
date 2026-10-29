"""Does the priority score predict what actually happened?

Input is one row per account: the score frozen when the decision was made
(`store.snapshot_score`) and, if it ever happened, when the outcome (e.g. a booked
meeting) occurred. An account counts as a *positive* if the outcome came within
`window_days` of the snapshot, and as a *negative* only once that window has fully
elapsed — younger accounts are still "open" and are left out rather than counted as
failures (otherwise every recent score would look worse than it is).

Everything reports its sample size and a confidence interval, and says so plainly
when there is too little data to conclude anything. Nothing here changes weights; a
person applies a recommendation (PUT /vs/scoring/weights).
"""
import math
from datetime import date, datetime
from typing import Any, Dict, List, Optional, Sequence

PARTS = ("fit", "intent", "contactability", "evidence")
MIN_MATURED = 100      # below this, no recommendations
MIN_POSITIVES = 20
MIN_NEGATIVES = 20


def _d(s: Optional[str]) -> Optional[date]:
    try:
        return datetime.fromisoformat(s).date() if s else None
    except ValueError:
        return None


def label_rows(rows: Sequence[Dict[str, Any]], window_days: int, as_of: Optional[date] = None) -> Dict[str, Any]:
    as_of = as_of or date.today()
    matured, open_n, late = [], 0, 0
    for r in rows:
        snap, out = _d(r["snapshot_at"]), _d(r.get("outcome_at"))
        if snap is None:
            continue
        days = (out - snap).days if out else None
        if days is not None and 0 <= days <= window_days:
            matured.append({**r, "converted": True})
        elif (as_of - snap).days >= window_days:
            if days is not None and days < 0:
                continue  # outcome pre-dates the prediction: can't be explained by it
            late += days is not None
            matured.append({**r, "converted": False})
        else:
            open_n += 1
    return {"matured": matured, "open": open_n, "converted_after_window": late}


def wilson(k: int, n: int, z: float = 1.96) -> Optional[List[float]]:
    if n == 0:
        return None
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [round(max(0.0, c - h), 3), round(min(1.0, c + h), 3)]


def auc(scores: Sequence[float], labels: Sequence[bool]) -> Optional[float]:
    """Probability a random converter outscores a random non-converter (ties count half). None if one class is empty."""
    pos = [s for s, l in zip(scores, labels) if l]
    neg = [s for s, l in zip(scores, labels) if not l]
    if not pos or not neg:
        return None
    order = sorted(range(len(scores)), key=lambda i: scores[i])
    ranks = [0.0] * len(scores)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and scores[order[j + 1]] == scores[order[i]]:
            j += 1
        for k in range(i, j + 1):
            ranks[order[k]] = (i + j) / 2 + 1
        i = j + 1
    r_pos = sum(r for r, l in zip(ranks, labels) if l)
    return round((r_pos - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)), 3)


def isotonic(xs: Sequence[float], ys: Sequence[bool]) -> List[Dict[str, float]]:
    """Monotone (never decreasing) mapping from priority to observed conversion rate, by pool-adjacent-violators."""
    pts = sorted(zip(xs, ys))
    blocks: List[List[float]] = []  # [sum_y, count, x_min, x_max]
    for x, y in pts:
        blocks.append([float(y), 1, x, x])
        while len(blocks) > 1 and blocks[-2][0] / blocks[-2][1] > blocks[-1][0] / blocks[-1][1]:
            b = blocks.pop()
            blocks[-1] = [blocks[-1][0] + b[0], blocks[-1][1] + b[1], blocks[-1][2], b[3]]
    return [{"from": b[2], "to": b[3], "rate": round(b[0] / b[1], 3), "n": int(b[1])} for b in blocks]


def calibrate(rows: Sequence[Dict[str, Any]], *, window_days: int = 60, buckets: int = 5, as_of: Optional[date] = None) -> Dict[str, Any]:
    lab = label_rows(rows, window_days, as_of)
    m = lab["matured"]
    n = len(m)
    pos = sum(1 for r in m if r["converted"])
    base = pos / n if n else None
    out: Dict[str, Any] = {"window_days": window_days, "matured": n, "positives": pos, "negatives": n - pos, "still_open": lab["open"],
                           "converted_after_window": lab["converted_after_window"], "base_rate": round(base, 3) if base is not None else None,
                           "base_rate_ci95": wilson(pos, n)}
    sufficient = n >= MIN_MATURED and pos >= MIN_POSITIVES and (n - pos) >= MIN_NEGATIVES
    out["sufficient_data"] = sufficient
    width = 100 / buckets
    table = []
    for b in range(buckets):
        lo, hi = b * width, (b + 1) * width
        sel = [r for r in m if lo <= r["priority"] < hi or (b == buckets - 1 and r["priority"] == 100)]
        k = sum(1 for r in sel if r["converted"])
        table.append({"priority": f"{int(lo)}-{int(hi) - (0 if b == buckets - 1 else 1)}", "n": len(sel), "converted": k,
                      "rate": round(k / len(sel), 3) if sel else None, "ci95": wilson(k, len(sel))})
    out["buckets"] = table
    labels = [r["converted"] for r in m]
    out["auc"] = auc([r["priority"] for r in m], labels)
    out["auc_by_component"] = {p: auc([r[p] for r in m], labels) for p in PARTS}
    notes: List[str] = []
    if not sufficient:
        notes.append(f"Too little data to trust any of this: need at least {MIN_MATURED} accounts whose {window_days}-day window has closed, "
                     f"with {MIN_POSITIVES}+ converted and {MIN_NEGATIVES}+ not (have {n}, {pos}, {n - pos}). Figures are indicative only.")
    if lab["open"]:
        notes.append(f"{lab['open']} account(s) are still inside their window and are excluded (not counted as failures).")
    rates = [t["rate"] for t in table if t["rate"] is not None]
    out["monotonic"] = all(a <= b + 1e-9 for a, b in zip(rates, rates[1:])) if len(rates) > 1 else None
    out["calibration_map"] = isotonic([r["priority"] for r in m], labels) if sufficient else None
    rec = None
    if sufficient:
        gains = {p: max((a or 0.5) - 0.5, 0.0) for p, a in out["auc_by_component"].items()}
        total = sum(gains.values())
        if total > 0:
            rec = {p: round(g / total, 3) for p, g in gains.items()}
            notes.append("Suggested weights are proportional to each component's lift over chance (AUC − 0.5). They are a starting point to review, not applied automatically.")
        else:
            notes.append("No component predicts conversion better than chance; keep the current weights and look for better signals.")
        if out["auc"] is not None and out["auc"] < 0.55:
            notes.append(f"Overall AUC {out['auc']} is close to chance: do not use the priority to decide who to contact first without more evidence.")
    out["suggested_weights"] = rec
    out["notes"] = notes
    out["interpretation"] = "Priority is a ranking score. Only the bucket rates (with their intervals) say anything about likelihood, and only for this tenant, window and outcome."
    return out


def probability(calibration: Dict[str, Any], priority: float) -> Optional[float]:
    """Observed conversion rate for a priority, only when the calibration had enough data; otherwise None (no invented probability)."""
    cmap = calibration.get("calibration_map")
    if not cmap:
        return None
    for seg in cmap:
        if seg["from"] <= priority <= seg["to"]:
            return seg["rate"]
    below = [s for s in cmap if s["to"] < priority]
    return below[-1]["rate"] if below else cmap[0]["rate"]
