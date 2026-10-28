"""VectorSales HTTP API: authentication, tenant isolation, approvals and send gating."""
import pytest

ACCOUNTS = [{"name": "Acme Corp", "domain": "acme.com", "industry": "software", "employees": 120, "state": "PA", "lat": 40.62, "lng": -75.37},
            {"name": "Tiny Co", "domain": "tiny.com", "industry": "software", "employees": 3}]
ICP = {"industries": ["software"], "employee_min": 50, "employee_max": 500, "target_titles": ["operations"], "hard": ["employees", "excluded"]}


@pytest.fixture()
def vs(backend, client, monkeypatch):
    svc = backend.vectorsales
    # fresh stores per test so tests can't see each other's rows
    svc.store.__init__(":memory:"); svc.ledger.__init__(":memory:")
    svc.sender = None
    monkeypatch.setitem(svc.tenants, "rep2@example.com", "tenant-b")
    monkeypatch.setitem(svc.tenants, "boss@example.com", "default")
    monkeypatch.setitem(svc.tenants, "rep@example.com", "default")
    return svc


def setup_account(client, rep):
    assert client.put("/vs/icp", json=ICP, headers=rep).status_code == 200
    r = client.post("/vs/accounts/import", json={"accounts": ACCOUNTS, "source": "test"}, headers=rep).json()
    assert r["stats"]["discovered"] == 2 and r["stats"]["filtered_out"] == 1
    return r["ids"][0]


def with_contact_and_draft(client, rep, aid):
    cid = client.post(f"/vs/accounts/{aid}/contacts", json={"name": "Jo Smith", "title": "VP Operations", "email": "jo@acme.com"}, headers=rep).json()["id"]
    client.post(f"/vs/accounts/{aid}/triggers", json={"kind": "expansion", "source": "news", "evidence": "Acme will consolidate three warehouses into one in Allentown.", "observed_at": "2026-05-30", "verified": True, "confidence": 0.8}, headers=rep)
    d = client.post(f"/vs/accounts/{aid}/outreach/draft", json={"contact_id": cid, "challenge": "warehouse consolidation"}, headers=rep).json()
    assert d["status"] == "draft", d
    return cid, d["outreach_id"]


@pytest.mark.parametrize("method,path", [("get", "/vs/queue"), ("get", "/vs/icp"), ("put", "/vs/icp"), ("post", "/vs/accounts/import"), ("get", "/vs/usage"),
                                         ("post", "/vs/outreach/x/send"), ("put", "/vs/budgets"), ("get", "/vs/audit"), ("post", "/vs/suppression")])
def test_every_route_requires_sign_in(client, vs, method, path):
    assert getattr(client, method)(path).status_code == 401


def test_import_scores_and_ranks_with_explanations_and_provenance(client, rep, vs):
    aid = setup_account(client, rep)
    q = client.get("/vs/queue", headers=rep).json()["accounts"]
    assert [a["name"] for a in q] == ["Acme Corp"]                       # the 3-employee company never entered
    assert q[0]["explanation"] and q[0]["icp_reasons"] and q[0]["provenance"]["name"]["source"] == "test"
    assert aid == q[0]["id"]


def test_tenants_cannot_see_or_touch_each_others_data(client, rep, rep2, vs):
    aid = setup_account(client, rep)
    cid, oid = with_contact_and_draft(client, rep, aid)
    assert client.get("/vs/queue", headers=rep2).json()["accounts"] == []
    for call in (lambda: client.get(f"/vs/accounts/{aid}", headers=rep2),
                 lambda: client.delete(f"/vs/accounts/{aid}", headers=rep2),
                 lambda: client.post(f"/vs/accounts/{aid}/contacts", json={"name": "X"}, headers=rep2),
                 lambda: client.post(f"/vs/accounts/{aid}/triggers", json={"kind": "other", "source": "s", "evidence": "x" * 30}, headers=rep2),
                 lambda: client.post(f"/vs/accounts/{aid}/triggers/assess", json={"documents": []}, headers=rep2),
                 lambda: client.post(f"/vs/accounts/{aid}/outreach/draft", json={"contact_id": cid, "challenge": "abc"}, headers=rep2),
                 lambda: client.post(f"/vs/outreach/{oid}/approve", headers=rep2),
                 lambda: client.post(f"/vs/outreach/{oid}/send", headers=rep2),
                 lambda: client.post(f"/vs/contacts/{cid}/events", json={"type": "reply"}, headers=rep2)):
        assert call().status_code in (403, 404)     # 403 where the action is manager-only; never 200
    assert client.get("/vs/usage", headers=rep2).json()["summary"]["lines"] == []
    assert client.get("/vs/icp", headers=rep2).json()["industries"] == []
    # tenant-b suppression does not leak into tenant default
    client.post("/vs/suppression", json={"kind": "domain", "value": "acme.com"}, headers=rep2)
    assert vs.store.is_suppressed("default", "jo@acme.com") is None


def test_client_cannot_choose_a_tenant(client, rep2, vs):
    r = client.post("/vs/accounts/import", json={"accounts": ACCOUNTS, "source": "t", "tenant": "default"}, headers={**rep2, "X-Tenant": "default"})
    assert r.status_code == 200 and vs.store.list_accounts("default") == [] and len(vs.store.list_accounts("tenant-b")) >= 1


def test_nothing_is_sent_without_approval_integration_and_it_never_double_sends(client, rep, boss, vs):
    aid = setup_account(client, rep)
    cid, oid = with_contact_and_draft(client, rep, aid)
    r = client.post(f"/vs/outreach/{oid}/send", headers=boss)
    assert r.status_code == 409 and "integration" in r.json()["detail"]
    sent = []
    vs.sender = lambda tenant, draft, contact: sent.append(contact["values"]["email"]) or "msg-1"
    assert client.post(f"/vs/outreach/{oid}/send", headers=boss).status_code == 409                # not approved yet
    assert client.post(f"/vs/outreach/{oid}/approve", headers=rep).status_code == 403              # reps can't approve (a manager exists)
    assert client.post(f"/vs/outreach/{oid}/approve", headers=boss).status_code == 200
    assert client.post(f"/vs/outreach/{oid}/approve", headers=boss).status_code == 409             # already approved
    assert client.post(f"/vs/outreach/{oid}/send", headers=boss).json()["state"] == "sent"
    assert client.post(f"/vs/outreach/{oid}/send", headers=boss).status_code == 409
    assert sent == ["jo@acme.com"]


def test_suppression_blocks_sending_and_events_stop_the_sequence(client, rep, boss, vs):
    aid = setup_account(client, rep)
    cid, oid = with_contact_and_draft(client, rep, aid)
    vs.sender = lambda *a: "id"
    client.post(f"/vs/outreach/{oid}/approve", headers=boss)
    client.post("/vs/suppression", json={"kind": "domain", "value": "https://www.acme.com", "reason": "do not contact"}, headers=rep)
    r = client.post(f"/vs/outreach/{oid}/send", headers=boss)
    assert r.status_code == 409 and "suppressed" in r.json()["detail"]
    # a reply cancels pending drafts and pauses the account
    assert client.post(f"/vs/contacts/{cid}/events", json={"type": "reply"}, headers=rep).json()["cancelled"] == 1
    assert client.get(f"/vs/accounts/{aid}", headers=rep).json()["status"] == "replied"
    assert client.post("/vs/suppression", json={"kind": "email", "value": "not-an-email-"}, headers=rep).status_code in (200, 422)


def test_unsubscribe_event_suppresses_the_address(client, rep, vs):
    aid = setup_account(client, rep)
    cid, _ = with_contact_and_draft(client, rep, aid)
    client.post(f"/vs/contacts/{cid}/events", json={"type": "unsubscribe"}, headers=rep)
    assert vs.store.is_suppressed("default", "jo@acme.com") == "unsubscribe"


def test_provider_failure_on_send_leaves_nothing_sent(client, rep, boss, vs):
    aid = setup_account(client, rep)
    cid, oid = with_contact_and_draft(client, rep, aid)
    def boom(*a): raise RuntimeError("smtp down")
    vs.sender = boom
    client.post(f"/vs/outreach/{oid}/approve", headers=boss)
    assert client.post(f"/vs/outreach/{oid}/send", headers=boss).status_code == 502
    assert vs.store.get_outreach("default", oid)["state"] == "failed"


def test_budget_endpoint_is_manager_only_validated_and_enforced(client, rep, boss, vs):
    assert client.put("/vs/budgets", json={"limit_usd": 5}, headers=rep).status_code == 403
    assert client.put("/vs/budgets", json={"limit_usd": -1}, headers=boss).status_code == 422
    assert client.put("/vs/budgets", json={"scope": "bogus", "limit_usd": 1}, headers=boss).status_code == 422
    assert client.put("/vs/budgets", json={"limit_usd": 5, "period": "month"}, headers=boss).status_code == 200
    u = client.get("/vs/usage", headers=rep).json()
    assert u["budgets"][0]["limit_usd"] == 5 and u["unit_costs"]["cost_per_discovered"] is None
    assert client.get("/vs/audit", headers=rep).status_code == 403 and client.get("/vs/audit", headers=boss).status_code == 200


def test_ai_assessment_degrades_cleanly_without_a_model(client, rep, vs):
    aid = setup_account(client, rep)
    r = client.post(f"/vs/accounts/{aid}/triggers/assess", headers=rep, json={"documents": [{"source": "pr", "authoritative": True, "text": "Acme Corp raised $12 million in a Series B round to expand."}]})
    assert r.status_code == 200 and r.json()["triggers"][0]["kind"] == "funding" and not r.json()["used_ai"]
    assert client.get("/vs/health", headers=rep).json()["ai_enabled"] is False
    assert client.post(f"/vs/accounts/{aid}/triggers/assess", headers=rep, json={"documents": [{"source": "s", "text": "x" * 30000}]}).status_code == 422


def test_import_limits_and_validation(client, rep, vs):
    assert client.post("/vs/accounts/import", json={"accounts": [{"name": "x"}] * 501, "source": "s"}, headers=rep).status_code == 422
    assert client.post("/vs/accounts/none/contacts", json={"name": "x"}, headers=rep).status_code == 404
    aid = setup_account(client, rep)
    assert client.post(f"/vs/accounts/{aid}/contacts", json={}, headers=rep).status_code == 422
    assert client.post(f"/vs/accounts/{aid}/triggers", json={"kind": "bogus", "source": "s", "evidence": "x" * 30}, headers=rep).status_code == 422


def test_geo_and_qualification_endpoints(client, rep, vs):
    setup_account(client, rep)
    g = client.post("/vs/geo/clusters", json={"anchor": {"name": "Customer", "lat": 40.6084, "lng": -75.4902, "confirmed": False}, "min_priority": 0}, headers=rep).json()
    assert g["proposal"]["stops"][0]["name"] == "Acme Corp" and "NOT confirmed" in g["proposal"]["note"]
    q = client.post("/vs/qualification", json={"answers": {"need": {"known": True, "positive": True, "evidence": "said so"}}}, headers=rep).json()
    assert q["decision"] == "not_ready" and "authority" in q["blockers"]


def test_account_deletion_is_manager_only_and_audited(client, rep, boss, vs):
    aid = setup_account(client, rep)
    assert client.delete(f"/vs/accounts/{aid}", headers=rep).status_code == 403
    assert client.delete(f"/vs/accounts/{aid}", headers=boss).status_code == 200
    assert client.get(f"/vs/accounts/{aid}", headers=rep).status_code == 404
    assert client.get("/vs/audit", headers=boss).json()["entries"][0]["action"] == "delete_account"
