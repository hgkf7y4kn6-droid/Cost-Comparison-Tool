"""Geographic clustering around an anchor meeting. Pure arithmetic: no routing API is
called until a cluster is worth pricing, and nothing here books anything."""
import math
from typing import Any, Dict, List

EARTH_MILES = 3958.8


def valid_coord(lat: Any, lng: Any) -> bool:
    try:
        return -90 <= float(lat) <= 90 and -180 <= float(lng) <= 180 and not (float(lat) == 0 and float(lng) == 0)
    except (TypeError, ValueError):
        return False


def haversine_miles(a: tuple, b: tuple) -> float:
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * EARTH_MILES * math.asin(math.sqrt(h))


def cluster_around(anchor: Dict[str, Any], accounts: List[Dict[str, Any]], *, radius_miles: float = 20.0, max_stops: int = 4,
                   min_priority: int = 40, mph: float = 30.0, meeting_minutes: int = 45, cost_per_mile: float = 0.70,
                   value_per_priority_point: float = 15.0) -> Dict[str, Any]:
    """anchor: {name, lat, lng, confirmed: bool}. accounts: [{id, name, lat, lng, priority}].
    Returns a *proposal*: ranked stops with distance/time, the economics, and why each was chosen or skipped."""
    if not valid_coord(anchor.get("lat"), anchor.get("lng")):
        return {"proposal": None, "error": "The anchor has no valid coordinates.", "skipped": []}
    a = (float(anchor["lat"]), float(anchor["lng"]))
    cand, skipped = [], []
    for acct in accounts:
        if not valid_coord(acct.get("lat"), acct.get("lng")):
            skipped.append({"id": acct.get("id"), "reason": "no valid coordinates"})
            continue
        d = haversine_miles(a, (float(acct["lat"]), float(acct["lng"])))
        if d > radius_miles:
            skipped.append({"id": acct.get("id"), "reason": f"{d:.1f} mi is outside {radius_miles:g} mi"})
        elif acct.get("priority", 0) < min_priority:
            skipped.append({"id": acct.get("id"), "reason": f"priority {acct.get('priority', 0)} is below {min_priority}"})
        else:
            cand.append({**acct, "miles": round(d, 1)})
    # best value per mile first
    cand.sort(key=lambda x: (-(x["priority"] / (1 + x["miles"])), x["miles"]))
    stops = cand[:max_stops]
    for c in cand[max_stops:]:
        skipped.append({"id": c.get("id"), "reason": "more than max stops"})
    miles = 2 * max((s["miles"] for s in stops), default=0)  # out and back from the anchor, upper bound
    drive_min = round(miles / mph * 60)
    value = sum(s["priority"] * value_per_priority_point for s in stops)
    travel_cost = round(miles * cost_per_mile, 2)
    return {
        "proposal": {
            "anchor": {"name": anchor.get("name"), "confirmed": bool(anchor.get("confirmed"))},
            "stops": [{"id": s["id"], "name": s.get("name"), "miles_from_anchor": s["miles"], "priority": s["priority"]} for s in stops],
            "est_drive_minutes": drive_min, "est_total_minutes": drive_min + meeting_minutes * len(stops),
            "est_travel_cost": travel_cost, "est_value": round(value, 2), "worth_it": bool(stops) and value > travel_cost * 3,
            "note": "Proposal only. Nothing is booked; confirm the anchor meeting in your calendar/CRM first." if anchor.get("confirmed") else
                    "The anchor meeting is NOT confirmed, so this is a hypothetical cluster.",
        },
        "skipped": skipped,
    }
