import pytest

import prospect_finder as pf

PHILLY = pf.AREAS["philadelphia"]


def place(pid, name, lat, lng, site="", status="OPERATIONAL", addr="1 Main St, Philadelphia, PA 19103, USA"):
    return {"id": pid, "displayName": {"text": name}, "formattedAddress": addr, "location": {"latitude": lat, "longitude": lng},
            "websiteUri": site, "nationalPhoneNumber": "(215) 555-0100", "businessStatus": status, "userRatingCount": 40}


class FakeHttp:
    def __init__(self, places=(), orgs=(), people=(), enrich_org=None, fail=None):
        self.places, self.orgs, self.people, self.enrich_org, self.fail = places, orgs, people, enrich_org, fail
        self.calls = []

    def __call__(self, method, url, headers, body=None):
        self.calls.append(url)
        if self.fail and self.fail in url:
            raise pf.ProviderError("Apollo" if "apollo" in url else "Google", 403)
        if "places.googleapis" in url:
            return {"places": list(self.places)}
        if url.endswith("mixed_companies/search"):
            return {"organizations": list(self.orgs), "pagination": {"total_pages": 1}}
        if "organizations/enrich" in url:
            return {"organization": self.enrich_org or {}}
        if url.endswith("mixed_people/search"):
            return {"people": list(self.people)}
        raise AssertionError(url)


@pytest.fixture
def keys(monkeypatch):
    monkeypatch.setenv("GOOGLE_PLACES_API_KEY", "g")
    monkeypatch.setenv("APOLLO_API_KEY", "a")


def test_merge_by_domain_screen_by_radius_and_headcount(keys):
    http = FakeHttp(
        places=[place("1", "Acme Law LLC", 39.95, -75.16, "https://www.acmelaw.com/"),
                place("2", "Far Away Inc", 41.5, -75.0, "https://far.com"),          # outside radius
                place("3", "Closed Co", 39.95, -75.16, "https://closed.com", status="CLOSED_PERMANENTLY")],
        orgs=[{"name": "Acme Law", "website_url": "http://acmelaw.com", "estimated_num_employees": 45, "city": "Philadelphia", "state": "Pennsylvania"},
              {"name": "Tiny LLC", "website_url": "http://tiny.com", "estimated_num_employees": 3}])
    out = pf.search(pf.Budget(100), "u@x.com", "professional", "philadelphia", 20, 500, http=http)
    names = [r["company"] for r in out["results"]]
    assert names == ["Acme Law LLC"]  # merged on domain, far/closed/tiny dropped
    r = out["results"][0]
    assert r["employees"] == 45 and r["headcountSource"] == "Apollo" and r["source"] == "Google Maps + Apollo"
    assert r["placeId"] == "1" and r["state"] == "PA" and r["zip"] == "19103"


def test_unknown_headcount_is_kept_and_flagged(keys):
    http = FakeHttp(places=[place("1", "Mystery Dental", 39.95, -75.16, "https://m.com")])
    r = pf.search(pf.Budget(100), "u", "healthcare", "philadelphia", 20, 500, http=http)["results"][0]
    assert r["employees"] == ""


def test_one_provider_failing_still_returns_the_other(keys):
    http = FakeHttp(places=[place("1", "Acme", 39.95, -75.16, "https://a.com")], fail="apollo")
    out = pf.search(pf.Budget(100), "u", "professional", "philadelphia", 20, 500, http=http)
    assert len(out["results"]) == 1 and "Apollo" in out["notes"][0]
    assert "api" not in out["notes"][0].lower().replace("api key", "")  # no URLs or keys leak


def test_all_providers_failing_raises(keys):
    with pytest.raises(pf.SearchFailed):
        pf.search(pf.Budget(100), "u", "professional", "philadelphia", 20, 500, http=FakeHttp(fail="."))


def test_budget_caps_calls_per_user(keys):
    b = pf.Budget(2)
    http = FakeHttp(places=[])
    with pytest.raises(pf.BudgetExceeded):
        pf.search(b, "u", "professional", "philadelphia", 20, 500, http=http)
    assert pf.Budget(2).remaining("other") == 2 and b.remaining("u") == 0
    assert len(http.calls) <= 2  # stopped before overspending


def test_enrich_finds_buyer_and_never_reveals_locked_email(keys):
    http = FakeHttp(enrich_org={"name": "Acme", "estimated_num_employees": 60, "linkedin_url": "https://li/acme"},
                    people=[{"name": "Pat Owner", "title": "Owner", "email": "email_not_unlocked@acme.com"},
                            {"name": "Sam Office", "title": "Office Manager", "email": "email_not_unlocked@acme.com"}])
    out = pf.enrich(pf.Budget(10), "u", {"company": "Acme", "website": "acme.com"}, http=http)
    assert out["employees"] == 60 and out["contactName"] == "Pat Owner"  # most senior title first
    assert not out.get("email")


def test_enrich_needs_a_website_and_key(keys, monkeypatch):
    with pytest.raises(ValueError):
        pf.enrich(pf.Budget(10), "u", {"company": "No Site"}, http=FakeHttp())
    monkeypatch.delenv("APOLLO_API_KEY")
    with pytest.raises(ValueError):
        pf.enrich(pf.Budget(10), "u", {"website": "a.com"}, http=FakeHttp())


def test_validation_and_unconfigured(monkeypatch):
    for k in ("GOOGLE_PLACES_API_KEY", "GOOGLE_MAPS_API_KEY", "APOLLO_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    with pytest.raises(ValueError, match="isn't set up"):
        pf.search(pf.Budget(10), "u", "professional", "philadelphia", 20, 500, http=FakeHttp())
    monkeypatch.setenv("APOLLO_API_KEY", "a")
    with pytest.raises(ValueError):
        pf.search(pf.Budget(10), "u", "nope", "philadelphia", 20, 500, http=FakeHttp())
    with pytest.raises(ValueError):
        pf.search(pf.Budget(10), "u", "professional", "philadelphia", 500, 20, http=FakeHttp())


def test_provider_error_messages_hide_secrets():
    assert "key" in str(pf.ProviderError("Google", 403))
    assert "http" not in str(pf.ProviderError("Apollo", 500)).lower().replace("(http 500)", "")
