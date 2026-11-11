"""Customer finder: Google Maps (Places) discovers local businesses, Apollo adds
headcount and the decision-maker. Both keys stay on the server.

    Discover   Google Places Text Search around an area center, plus Apollo's
               organization search (which filters by headcount itself)
    Screen     operating, inside the area's radius, de-duplicated by website
               domain, headcount inside the range (unknown headcount is kept
               and flagged so the rep can decide)
    Enrich     on demand, one company at a time: Apollo organization enrich for
               headcount, then people search for the buyer (office / facilities /
               operations / purchasing). Names and titles only. Emails that
               Apollo locks cost a credit to reveal and are never revealed here.

Nothing is stored: results go to the rep's browser, which adds the ones they pick
as leads. Calls are capped per user per day (FINDER_DAILY_CALLS) so a stray click
can't run up the Google or Apollo bill.
"""
import json
import math
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

USER_AGENT = "SalesHub-finder/1.0"
Http = Callable[[str, str, Dict[str, str], Optional[dict]], Any]

# Where a rep can look. Centers are (lat, lng); every search is held to the radius.
AREAS: Dict[str, Dict[str, Any]] = {
    "philadelphia": {"label": "Philadelphia & suburbs", "center": (39.9526, -75.1652), "radius_mi": 25,
                     "apollo": ["Philadelphia, Pennsylvania, United States", "Montgomery County, Pennsylvania, United States",
                                "Delaware County, Pennsylvania, United States", "Bucks County, Pennsylvania, United States",
                                "Chester County, Pennsylvania, United States"]},
    "south_nj": {"label": "South Jersey", "center": (39.9348, -75.0307), "radius_mi": 25,
                 "apollo": ["Camden County, New Jersey, United States", "Burlington County, New Jersey, United States",
                            "Gloucester County, New Jersey, United States"]},
    "central_nj": {"label": "Central NJ (Trenton / Princeton)", "center": (40.2206, -74.7597), "radius_mi": 22,
                   "apollo": ["Mercer County, New Jersey, United States"]},
    "lehigh": {"label": "Allentown / Lehigh Valley", "center": (40.6084, -75.4902), "radius_mi": 22,
               "apollo": ["Lehigh County, Pennsylvania, United States", "Northampton County, Pennsylvania, United States"]},
    "lancaster": {"label": "Lancaster", "center": (40.0379, -76.3055), "radius_mi": 20,
                  "apollo": ["Lancaster County, Pennsylvania, United States"]},
}

# What an Office Basics rep sells to: offices that buy supplies, break-room items,
# printing and furniture. `q` are Google search phrases, `tags` Apollo keyword tags.
SEGMENTS: Dict[str, Dict[str, Any]] = {
    "professional": {"label": "Professional offices (law, accounting, insurance, finance)",
                     "q": ["law firm", "accounting firm", "insurance agency", "financial advisor"],
                     "tags": ["legal services", "accounting", "insurance", "financial services"]},
    "healthcare": {"label": "Medical & dental practices",
                   "q": ["medical practice", "dental office", "physical therapy clinic", "urgent care"],
                   "tags": ["medical practice", "dental", "health care", "physical therapy"]},
    "property": {"label": "Property management & real estate",
                 "q": ["property management company", "commercial real estate", "real estate office"],
                 "tags": ["property management", "commercial real estate", "real estate"]},
    "industrial": {"label": "Manufacturing, warehouse & distribution",
                   "q": ["manufacturing company", "distribution center", "warehouse", "logistics company"],
                   "tags": ["manufacturing", "logistics & supply chain", "warehousing", "wholesale"]},
    "education": {"label": "Schools, colleges & child care",
                  "q": ["private school", "charter school", "child care center", "trade school"],
                  "tags": ["education management", "primary/secondary education", "higher education"]},
    "nonprofit": {"label": "Nonprofits, churches & associations",
                  "q": ["nonprofit organization", "community center", "association headquarters"],
                  "tags": ["nonprofit organization management", "civic & social organization"]},
    "tech": {"label": "Technology, marketing & staffing offices",
             "q": ["staffing agency", "marketing agency", "software company", "IT services"],
             "tags": ["staffing & recruiting", "marketing & advertising", "information technology & services"]},
    "hospitality": {"label": "Hotels, restaurants & fitness",
                    "q": ["hotel", "fitness center", "event venue"],
                    "tags": ["hospitality", "leisure, travel & tourism", "health, wellness & fitness"]},
}

# Who buys office, break-room and facility supplies, most senior first.
BUYER_TITLES = ["owner", "president", "ceo", "office manager", "facilities manager", "director of operations",
                "operations manager", "purchasing manager", "procurement", "administrator", "practice manager",
                "business manager", "controller"]

DEFAULT_MIN_EMPLOYEES, DEFAULT_MAX_EMPLOYEES = 20, 500
MAX_RESULTS = 100
GOOGLE_PAGES = 2  # 20 places per page


# --- configuration ---------------------------------------------------------------

def google_key() -> str:
    # A server-side key (GOOGLE_PLACES_API_KEY) is preferred: the browser key in
    # frontend/config.js is referrer-restricted and won't work from the server.
    return os.environ.get("GOOGLE_PLACES_API_KEY") or os.environ.get("GOOGLE_MAPS_API_KEY", "")


def apollo_key() -> str:
    return os.environ.get("APOLLO_API_KEY", "")


def status() -> Dict[str, Any]:
    return {
        "google": bool(google_key()),
        "apollo": bool(apollo_key()),
        "areas": {k: v["label"] for k, v in AREAS.items()},
        "segments": {k: v["label"] for k, v in SEGMENTS.items()},
        "defaults": {"min_employees": DEFAULT_MIN_EMPLOYEES, "max_employees": DEFAULT_MAX_EMPLOYEES},
    }


# --- per-user daily call budget -------------------------------------------------------

class Budget:
    """Counts outbound Google/Apollo calls per user per UTC day."""

    def __init__(self, daily: Optional[int] = None):
        self.daily = daily if daily is not None else int(os.environ.get("FINDER_DAILY_CALLS", "150"))
        self._lock = threading.Lock()
        self._used: Dict[Tuple[str, str], int] = {}

    def _key(self, user: str) -> Tuple[str, str]:
        return (user, time.strftime("%Y-%m-%d", time.gmtime()))

    def remaining(self, user: str) -> int:
        with self._lock:
            return max(0, self.daily - self._used.get(self._key(user), 0))

    def spend(self, user: str, calls: int = 1) -> None:
        with self._lock:
            key = self._key(user)
            used = self._used.get(key, 0)
            if used + calls > self.daily:
                raise BudgetExceeded(f"Daily search limit reached ({self.daily} lookups). It resets tomorrow; "
                                     "a manager can raise FINDER_DAILY_CALLS.")
            self._used[key] = used + calls
            for old in [k for k in self._used if k[1] != key[1]]:
                del self._used[old]


class BudgetExceeded(Exception):
    pass


class SearchFailed(Exception):
    """Every provider failed; the message says why and is safe to show."""


# --- plumbing ---------------------------------------------------------------------

def http_json(method: str, url: str, headers: Dict[str, str], body: Optional[dict] = None) -> Any:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json", "User-Agent": USER_AGENT, **headers})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=25) as resp:  # noqa: S310 - fixed API hosts
                return json.loads(resp.read() or b"{}")
        except urllib.error.HTTPError as exc:
            if exc.code == 429 or exc.code >= 500:
                time.sleep(2 ** attempt)
                continue
            raise ProviderError(_provider(url), exc.code) from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            if attempt == 2:
                raise ProviderError(_provider(url), 0) from exc
            time.sleep(2 ** attempt)
    raise ProviderError(_provider(url), 429)


def _provider(url: str) -> str:
    return "Apollo" if "apollo.io" in url else "Google"


class ProviderError(Exception):
    """A Google or Apollo call failed. The message is safe to show the rep (no keys, no URLs)."""

    def __init__(self, provider: str, status_code: int):
        self.provider, self.status_code = provider, status_code
        if status_code in (401, 403):
            msg = f"{provider} rejected the server's API key or plan (HTTP {status_code}). Ask your admin to check it."
        elif status_code == 429:
            msg = f"{provider} is rate limiting requests right now. Try again in a minute."
        elif status_code == 0:
            msg = f"Couldn't reach {provider}. Check the connection and try again."
        else:
            msg = f"{provider} returned an error (HTTP {status_code})."
        super().__init__(msg)


def miles(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (*a, *b))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 3958.8 * 2 * math.asin(math.sqrt(h))


def domain_of(url: Optional[str]) -> str:
    if not url:
        return ""
    host = urllib.parse.urlparse(url if "//" in url else "http://" + url).netloc.lower()
    return host[4:] if host.startswith("www.") else host


def norm_name(name: str) -> str:
    n = re.sub(r"[^a-z0-9 ]", " ", (name or "").lower())
    n = re.sub(r"\b(llc|inc|co|corp|corporation|company|the|ltd|pc|llp|lp)\b", " ", n)
    return re.sub(r"\s+", " ", n).strip()


def parse_address(addr: str) -> Dict[str, str]:
    """'123 Main St, Bensalem, PA 19020, USA' -> street, city, state, zip."""
    parts = [p.strip() for p in (addr or "").split(",")]
    if parts and parts[-1] in ("USA", "United States"):
        parts = parts[:-1]
    out = {"address": "", "city": "", "state": "", "zip": ""}
    if len(parts) >= 2:
        m = re.match(r"([A-Z]{2})\s*(\d{5})?", parts[-1])
        if m:
            out["state"], out["zip"] = m[1], m[2] or ""
            out["city"] = parts[-2]
            out["address"] = ", ".join(parts[:-2])
    return out


_STATES = {"pennsylvania": "PA", "new jersey": "NJ", "delaware": "DE", "maryland": "MD", "new york": "NY"}


def _state_abbr(s: str) -> str:
    s = (s or "").strip()
    return _STATES.get(s.lower(), s.upper() if len(s) == 2 else s)


# --- discover: Google Places --------------------------------------------------------

PLACES_FIELDS = ",".join("places." + f for f in (
    "id", "displayName", "formattedAddress", "location", "websiteUri", "nationalPhoneNumber",
    "rating", "userRatingCount", "businessStatus", "primaryTypeDisplayName")) + ",nextPageToken"


def google_discover(key: str, area: Dict[str, Any], queries: Iterable[str], http: Http = http_json,
                    pages: int = GOOGLE_PAGES, spend: Callable[[int], None] = lambda n: None) -> List[Dict[str, Any]]:
    center = area["center"]
    found: Dict[str, Dict[str, Any]] = {}
    for query in queries:
        token = None
        for _ in range(pages):
            spend(1)
            body: Dict[str, Any] = {
                "textQuery": f"{query} near {area['label']}", "pageSize": 20,
                "locationBias": {"circle": {"center": {"latitude": center[0], "longitude": center[1]},
                                            "radius": min(50000.0, area["radius_mi"] * 1609.0)}},
            }
            if token:
                body["pageToken"] = token
            data = http("POST", "https://places.googleapis.com/v1/places:searchText",
                        {"X-Goog-Api-Key": key, "X-Goog-FieldMask": PLACES_FIELDS}, body)
            for p in data.get("places", []):
                found.setdefault(p["id"], p)
            token = data.get("nextPageToken")
            if not token:
                break
    rows = []
    for p in found.values():
        loc = p.get("location") or {}
        rows.append({
            "company": (p.get("displayName") or {}).get("text", ""),
            **parse_address(p.get("formattedAddress", "")),
            "website": p.get("websiteUri", ""), "phone": p.get("nationalPhoneNumber", ""),
            "lat": loc.get("latitude"), "lng": loc.get("longitude"), "placeId": p["id"],
            "industry": (p.get("primaryTypeDisplayName") or {}).get("text", ""),
            "googleRating": p.get("rating", ""), "googleReviews": p.get("userRatingCount", 0),
            "status": p.get("businessStatus", "OPERATIONAL"), "source": "Google Maps",
        })
    return rows


# --- discover + enrich: Apollo ------------------------------------------------------

APOLLO = "https://api.apollo.io/api/v1"


def _apollo_row(o: Dict[str, Any], source: str) -> Dict[str, Any]:
    employees = o.get("estimated_num_employees") or ""
    return {
        "company": o.get("name", ""), "website": o.get("website_url") or o.get("primary_domain") or "",
        "phone": (o.get("primary_phone") or {}).get("sanitized_number") or o.get("sanitized_phone") or "",
        "city": o.get("city") or "", "state": _state_abbr(o.get("state") or ""), "zip": o.get("postal_code") or "",
        "address": o.get("street_address") or "", "employees": employees,
        "linkedinUrl": o.get("linkedin_url") or "", "industry": o.get("industry") or "",
        "headcountSource": "Apollo" if employees else "", "source": source,
    }


def apollo_discover(key: str, area: Dict[str, Any], tags: List[str], lo: int, hi: int, http: Http = http_json,
                    max_pages: int = 2, spend: Callable[[int], None] = lambda n: None) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for page in range(1, max_pages + 1):
        spend(1)
        data = http("POST", f"{APOLLO}/mixed_companies/search", {"X-Api-Key": key}, {
            "q_organization_keyword_tags": tags,
            "organization_locations": area["apollo"],
            "organization_num_employees_ranges": [f"{lo},{hi}"],
            "page": page, "per_page": 50,
        })
        orgs = data.get("organizations") or data.get("accounts") or []
        rows += [_apollo_row(o, "Apollo") for o in orgs]
        if not orgs or page >= (data.get("pagination") or {}).get("total_pages", page):
            break
    return rows


def apollo_enrich(row: Dict[str, Any], key: str, http: Http = http_json) -> None:
    """Headcount and gaps from Apollo's organization record for this domain."""
    domain = domain_of(row.get("website"))
    if not domain:
        return
    data = http("GET", f"{APOLLO}/organizations/enrich?domain={urllib.parse.quote(domain)}", {"X-Api-Key": key}, None)
    org = data.get("organization") or {}
    if not org:
        return
    a = _apollo_row(org, "")
    for k in ("employees", "linkedinUrl", "industry", "zip", "address", "phone"):
        if a.get(k) and not row.get(k):
            row[k] = a[k]
    if a.get("employees") and row.get("headcountSource") != "Apollo":
        row["employees"], row["headcountSource"] = a["employees"], "Apollo"


def _title_rank(title: str) -> int:
    t = (title or "").lower()
    return next((i for i, d in enumerate(BUYER_TITLES) if d in t), len(BUYER_TITLES))


def apollo_contact(row: Dict[str, Any], key: str, http: Http = http_json) -> None:
    """The most relevant buyer Apollo lists at this domain: name and title.
    Locked emails are left locked (revealing one costs an Apollo credit)."""
    domain = domain_of(row.get("website"))
    if not domain:
        return
    data = http("POST", f"{APOLLO}/mixed_people/search", {"X-Api-Key": key}, {
        "q_organization_domains_list": [domain], "person_titles": BUYER_TITLES, "page": 1, "per_page": 5})
    people = data.get("people") or data.get("contacts") or []
    if not people:
        return
    p = min(people, key=lambda x: _title_rank(x.get("title", "")))
    row["contactName"] = p.get("name") or " ".join(filter(None, (p.get("first_name"), p.get("last_name"))))
    row["contactTitle"] = p.get("title") or ""
    email = p.get("email") or ""
    if email and "email_not_unlocked" not in email:
        row["email"] = email.lower()
        row["emailStatus"] = "valid" if p.get("email_status") == "verified" else "unverified"
    else:
        row["emailLocked"] = True


# --- merge, screen -------------------------------------------------------------------

def merge(rows: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """One row per company: matched by website domain, else by normalized name + city."""
    out: Dict[str, Dict[str, Any]] = {}
    for r in rows:
        k = domain_of(r.get("website")) or f"{norm_name(r.get('company', ''))}|{(r.get('city') or '').lower()}"
        if k in out:
            cur = out[k]
            for f, v in r.items():
                if v not in (None, "", 0) and cur.get(f) in (None, "", 0):
                    cur[f] = v
            if r.get("source") and r["source"] not in cur.get("source", ""):
                cur["source"] += " + " + r["source"]
        else:
            out[k] = dict(r)
    return list(out.values())


def _employees(r: Dict[str, Any]) -> Optional[int]:
    try:
        return int(float(r.get("employees") or ""))
    except (TypeError, ValueError):
        return None


def screen(rows: List[Dict[str, Any]], area: Dict[str, Any], lo: int, hi: int) -> List[Dict[str, Any]]:
    """Operating, inside the radius (or a located Apollo row), headcount in range or unknown. Best first."""
    keep = []
    for r in rows:
        if r.get("status") not in (None, "", "OPERATIONAL") or not r.get("company"):
            continue
        if r.get("lat") is not None and r.get("lng") is not None:
            r["miles"] = round(miles(area["center"], (r["lat"], r["lng"])), 1)
            if r["miles"] > area["radius_mi"]:
                continue
        n = _employees(r)
        if n is not None:
            if not lo <= n <= hi:
                continue
            r["employees"] = n
        else:
            r["employees"] = ""
        r["fit"] = fit_score(r)
        keep.append(r)
    return sorted(keep, key=lambda r: (-r["fit"], r.get("miles") if r.get("miles") is not None else 99))


def fit_score(r: Dict[str, Any]) -> int:
    """0-100: confirmed headcount, a reachable buyer, a real web presence, proximity and reputation."""
    s = 0
    if r.get("headcountSource") == "Apollo":
        s += 35
    elif r.get("employees") != "":
        s += 20
    if r.get("contactName"):
        s += 20
    if r.get("website"):
        s += 15
    if r.get("phone"):
        s += 5
    s += min(10, int(r.get("googleReviews") or 0) // 5)
    if r.get("miles") is not None:
        s += max(0, 15 - int(r["miles"] // 2))
    return min(100, s)


# --- entry points ----------------------------------------------------------------------

def search(user_budget: Budget, user: str, segment: str, area_key: str, lo: int, hi: int,
           limit: int = 40, http: Http = http_json) -> Dict[str, Any]:
    if segment not in SEGMENTS:
        raise ValueError("Pick a business type.")
    if area_key not in AREAS:
        raise ValueError("Pick an area.")
    if not 1 <= lo <= hi <= 100_000:
        raise ValueError("Employee range must be between 1 and 100,000, smallest first.")
    gkey, akey = google_key(), apollo_key()
    if not gkey and not akey:
        raise ValueError("Customer search isn't set up on this server yet: it needs GOOGLE_PLACES_API_KEY "
                         "and/or APOLLO_API_KEY.")
    seg, area = SEGMENTS[segment], AREAS[area_key]
    limit = max(1, min(int(limit), MAX_RESULTS))
    spend = lambda n: user_budget.spend(user, n)  # noqa: E731
    rows: List[Dict[str, Any]] = []
    notes: List[str] = []
    if gkey:
        try:
            rows += google_discover(gkey, area, seg["q"][:3], http, spend=spend)
        except ProviderError as exc:
            notes.append(str(exc))
    if akey:
        try:
            rows += apollo_discover(akey, area, seg["tags"], lo, hi, http, spend=spend)
        except ProviderError as exc:
            notes.append(str(exc))
    if not rows and notes:
        raise SearchFailed(" ".join(notes))
    screened = screen(merge(rows), area, lo, hi)
    for r in screened:
        r["segmentKey"] = segment
    return {"results": screened[:limit], "found": len(screened), "notes": notes,
            "remaining": user_budget.remaining(user)}


def enrich(user_budget: Budget, user: str, row: Dict[str, Any], http: Http = http_json) -> Dict[str, Any]:
    """Headcount and buyer for one company (2 Apollo calls)."""
    akey = apollo_key()
    if not akey:
        raise ValueError("Apollo isn't connected on this server (APOLLO_API_KEY).")
    if not domain_of(row.get("website")):
        raise ValueError("This company has no website, so Apollo can't look it up.")
    out = {k: row.get(k, "") for k in ("company", "website", "employees", "headcountSource", "industry", "phone",
                                       "address", "zip", "linkedinUrl", "contactName", "contactTitle", "email",
                                       "emailStatus")}
    user_budget.spend(user, 2)
    apollo_enrich(out, akey, http)
    apollo_contact(out, akey, http)
    out["remaining"] = user_budget.remaining(user)
    return out
