import json
import os
import sqlite3

import pytest

from accounts_store import ConflictError, RecordStore, order_spend, ytd_spend


@pytest.fixture()
def store(tmp_path):
    return RecordStore(str(tmp_path / "t.db"))


def customer(company="Acme", amount=100):
    year = __import__("datetime").datetime.now().year
    return {"company": company, "city": "Philly", "phone": "215", "contactName": "Secret Contact", "email": "s@acme.com",
            "orders": [{"id": "o1", "date": f"{year}-01-05", "lines": [{"qty": 1, "shipped": 2, "unitPrice": amount}]}]}


def test_order_spend_uses_shipped_quantity_before_tax_and_freight():
    o = {"tax": 99, "freight": 50, "lines": [{"qty": 10, "shipped": 4, "unitPrice": 2.5}, {"qty": 3, "unitPrice": 1}, "junk"]}
    assert order_spend(o) == 4 * 2.5 + 3 * 1


def test_ytd_only_counts_this_year_and_unconverted_activity_amounts():
    data = {"orders": [{"date": "2020-03-01", "lines": [{"qty": 1, "unitPrice": 500}]}, {"date": "2026-03-01", "lines": [{"qty": 2, "unitPrice": 10}]}],
            "activities": [{"type": "order", "date": "2026-02-01", "amount": 7}, {"type": "order", "date": "2026-02-01", "amount": 99, "orderId": "x"}, {"type": "call", "date": "2026-02-01", "amount": 5}]}
    assert ytd_spend(data, 2026) == 27.0


def test_other_reps_see_only_the_limited_view_of_a_customer_account(store):
    store.save("accounts", "a1", customer(), "ana@x.com", False)
    full, limited = store.list_visible("accounts", "raj@x.com", False)
    assert full == [] and len(limited) == 1
    assert set(limited[0]) <= {"id", "company", "address", "city", "state", "zip", "phone", "lat", "lng", "ytdSpend", "limited"}
    assert "contactName" not in json.dumps(limited) and "orders" not in limited[0]
    mine, _ = store.list_visible("accounts", "ana@x.com", False)
    assert mine[0]["contactName"] == "Secret Contact"
    mgr, _ = store.list_visible("accounts", "boss@x.com", True)
    assert len(mgr) == 1


def test_non_owner_cannot_edit_or_delete_a_customer_account(store):
    store.save("accounts", "a1", customer(), "ana@x.com", False)
    with pytest.raises(PermissionError):
        store.save("accounts", "a1", {**customer(), "company": "Hijacked"}, "raj@x.com", False)
    with pytest.raises(PermissionError):
        store.delete("accounts", "a1", "raj@x.com", False)
    assert store.delete("accounts", "a1", "ana@x.com", False)


def test_open_records_are_shared_but_reassignment_is_restricted(store):
    store.save("leads", "l1", {"company": "Lead Co"}, "ana@x.com", False)
    out = store.save("leads", "l1", {"company": "Lead Co", "note": "edited by raj"}, "raj@x.com", False)
    assert out["ownerEmail"] == "ana@x.com"                             # editing doesn't take ownership
    out = store.save("leads", "l1", {"company": "Lead Co", "ownerEmail": "raj@x.com"}, "raj@x.com", False)
    assert out["ownerEmail"] == "raj@x.com"                             # claiming for yourself is allowed
    out = store.save("leads", "l1", {"company": "Lead Co", "ownerEmail": "zed@x.com"}, "ana@x.com", False)
    assert out["ownerEmail"] == "raj@x.com"                             # assigning to a third person is not
    out = store.save("leads", "l1", {"company": "Lead Co", "ownerEmail": "zed@x.com"}, "boss@x.com", True)
    assert out["ownerEmail"] == "zed@x.com"                             # managers can


def test_validation(store):
    for bad_id in ["", "a b", "../x", "x" * 65]:
        with pytest.raises(ValueError):
            store.save("leads", bad_id, {}, "a@x.com", False)
    with pytest.raises(ValueError):
        store.save("leads", "ok", ["not", "an", "object"], "a@x.com", False)
    with pytest.raises(ValueError):
        store.save("leads", "ok", {"blob": "x" * (3 * 1024 * 1024)}, "a@x.com", False)
    with pytest.raises(LookupError):
        store.save("passwords", "ok", {}, "a@x.com", False)
    with pytest.raises(ValueError):
        store.save_many("leads", [{"id": str(i)} for i in range(2001)], "a@x.com", False)


def test_server_computed_fields_cannot_be_forged(store):
    store.save("accounts", "a1", {**customer(amount=1), "ytdSpend": 1e9, "limited": True, "rev": 99, "id": "evil"}, "ana@x.com", False)
    rec = store.list_visible("accounts", "ana@x.com", False)[0][0]
    assert rec["id"] == "a1" and rec["ytdSpend"] == 2.0 and "limited" not in rec and rec["rev"] == 1


def test_revision_conflict_prevents_silent_overwrite(store):
    first = store.save("leads", "l1", {"company": "v1"}, "ana@x.com", False)
    second = store.save("leads", "l1", {"company": "v2", "baseRev": first["rev"]}, "raj@x.com", False)
    assert second["rev"] == first["rev"] + 1
    with pytest.raises(ConflictError):
        store.save("leads", "l1", {"company": "stale edit", "baseRev": first["rev"]}, "ana@x.com", False)
    assert store.list_visible("leads", "ana@x.com", False)[0][0]["company"] == "v2"
    # clients that don't send baseRev (older builds) still work
    store.save("leads", "l1", {"company": "v3"}, "ana@x.com", False)


def test_bulk_save_reports_conflicts_per_record(store):
    a = store.save("leads", "l1", {"company": "A"}, "ana@x.com", False)
    store.save("leads", "l2", {"company": "B"}, "ana@x.com", False)
    out = store.save_many("leads", [{"id": "l1", "company": "A2", "baseRev": a["rev"] - 1}, {"id": "l2", "company": "B2"}], "ana@x.com", False)
    assert [e["id"] for e in out["errors"]] == ["l1"] and out["errors"][0]["conflict"] is True
    assert [r["id"] for r in out["saved"]] == ["l2"]


def test_delete_is_audited_and_restorable(store):
    store.save("leads", "l1", {"company": "Keep me"}, "ana@x.com", False)
    store.delete("leads", "l1", "ana@x.com", False)
    assert store.list_visible("leads", "ana@x.com", False)[0] == []
    actions = [e["action"] for e in store.audit_log()]
    assert "delete" in actions and "create" in actions
    restored = store.restore_deleted("leads", "l1", "boss@x.com")
    assert restored["company"] == "Keep me"
    with pytest.raises(ValueError):
        store.restore_deleted("leads", "l1", "boss@x.com")
    with pytest.raises(LookupError):
        store.restore_deleted("leads", "never-existed", "boss@x.com")


def test_backup_is_a_consistent_copy_and_old_copies_are_pruned(store, tmp_path):
    store.save("leads", "l1", {"company": "Backed up"}, "ana@x.com", False)
    d = str(tmp_path / "bk")
    for stamp in ["20200101-000000", "20200102-000000", "20200103-000000"]:
        os.makedirs(d, exist_ok=True)
        open(os.path.join(d, f"sales_hub-{stamp}.db"), "w").close()
    path = store.backup_to(d, keep=2)
    assert len(os.listdir(d)) == 2
    db = sqlite3.connect(path)
    assert db.execute("SELECT count(*) FROM records").fetchone()[0] == 1
    # restoring = opening the copy as a store
    assert RecordStore(path).list_visible("leads", "x@x.com", False)[0][0]["company"] == "Backed up"


def test_old_databases_are_migrated_without_losing_data(tmp_path):
    path = str(tmp_path / "old.db")
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE records (kind TEXT NOT NULL, id TEXT NOT NULL, owner TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (kind, id))")
    db.execute("INSERT INTO records VALUES ('leads','l1','ana@x.com','{\"company\":\"Old\"}','2020-01-01')")
    db.execute("CREATE TABLE accounts (id TEXT, owner TEXT, data TEXT, updated_at TEXT)")
    db.execute("INSERT INTO accounts VALUES ('a1','ana@x.com','{\"company\":\"Older\"}','2019-01-01')")
    db.commit(); db.close()
    s = RecordStore(path)
    assert s.list_visible("leads", "ana@x.com", False)[0][0]["rev"] == 1
    assert s.list_visible("accounts", "ana@x.com", False)[0][0]["company"] == "Older"


# --- HTTP layer ---------------------------------------------------------------

def test_http_customer_account_is_hidden_from_other_reps(client, rep, rep2):
    r = client.put("/records/accounts/http-a1", json=customer("HTTP Co"), headers=rep)
    assert r.status_code == 200 and r.json()["ownerEmail"] == "rep@example.com"
    seen = client.get("/records/accounts/", headers=rep2).json()
    assert all(a["id"] != "http-a1" for a in seen["records"])
    assert any(a["id"] == "http-a1" and a["limited"] for a in seen["others"])
    assert client.put("/records/accounts/http-a1", json=customer("Hijack"), headers=rep2).status_code == 403
    assert client.delete("/records/accounts/http-a1", headers=rep2).status_code == 403


def test_http_conflict_is_409_and_bulk_reports_it(client, rep):
    saved = client.put("/records/leads/http-l1", json={"company": "One"}, headers=rep).json()
    client.put("/records/leads/http-l1", json={"company": "Two", "baseRev": saved["rev"]}, headers=rep)
    assert client.put("/records/leads/http-l1", json={"company": "Stale", "baseRev": saved["rev"]}, headers=rep).status_code == 409
    out = client.post("/records/leads/bulk", json={"records": [{"id": "http-l1", "company": "Stale", "baseRev": saved["rev"]}]}, headers=rep).json()
    assert out["errors"][0]["conflict"] is True


def test_http_export_audit_restore_are_manager_only(client, rep, boss):
    client.put("/records/leads/http-l9", json={"company": "Gone soon"}, headers=rep)
    client.delete("/records/leads/http-l9", headers=rep)
    for path in ["/records/export", "/records/audit"]:
        assert client.get(path, headers=rep).status_code == 403
        assert client.get(path, headers=boss).status_code == 200
    assert client.post("/records/leads/http-l9/restore", headers=rep).status_code == 403
    assert client.post("/records/leads/http-l9/restore", headers=boss).json()["company"] == "Gone soon"


def test_http_bad_json_and_oversized_bodies(client, rep):
    assert client.put("/records/leads/x1", content=b"{not json", headers={**rep, "Content-Type": "application/json"}).status_code == 400
    big = b'{"company": "' + b"x" * (4 * 1024 * 1024) + b'"}'
    assert client.put("/records/leads/x2", content=big, headers={**rep, "Content-Type": "application/json"}).status_code == 413
    assert client.get("/records/nonsense/", headers=rep).status_code == 404


# --- Quotes are private to their owner --------------------------------------------

def test_quotes_are_listed_only_to_their_owner_not_even_managers(store):
    store.save("quotes", "q1", {"number": "Q-1", "lines": [{"cost": 60, "unitPrice": 80}]}, "ana@x.com", False)
    assert [r["id"] for r in store.list_visible("quotes", "ana@x.com", False)[0]] == ["q1"]
    for email, mgr in [("raj@x.com", False), ("boss@x.com", True)]:
        full, limited = store.list_visible("quotes", email, mgr)
        assert full == [] and limited == []


def test_other_reps_cannot_change_or_delete_someone_elses_quote(store):
    store.save("quotes", "q1", {"number": "Q-1"}, "ana@x.com", False)
    with pytest.raises(PermissionError):
        store.save("quotes", "q1", {"number": "hijacked"}, "raj@x.com", False)
    with pytest.raises(PermissionError):
        store.delete("quotes", "q1", "raj@x.com", False)
    assert store.delete("quotes", "q1", "ana@x.com", False)
    assert store.restore_deleted("quotes", "q1", "boss@x.com")["number"] == "Q-1"


def test_http_quotes_round_trip_and_stay_private(client, rep, rep2, boss):
    body = {"number": "Q-2026-001", "company": "Acme", "lines": [{"unitPrice": 80, "cost": 60}]}
    assert client.put("/records/quotes/http-q1", json=body, headers=rep).status_code == 200
    mine = client.get("/records/quotes/", headers=rep).json()
    assert [q["id"] for q in mine["records"]] == ["http-q1"]
    for who in (rep2, boss):
        got = client.get("/records/quotes/", headers=who).json()
        assert got["records"] == [] and got["others"] == []
    assert client.put("/records/quotes/http-q1", json=body, headers=rep2).status_code == 403


def test_export_file_restores_into_an_empty_database_and_never_clobbers_by_default(store, tmp_path):
    store.save("leads", "l1", {"company": "Lead One"}, "ana@x.com", False)
    store.save("quotes", "q1", {"number": "Q-1"}, "ana@x.com", False)
    dump = json.loads(json.dumps(store.export_all()))
    fresh = RecordStore(str(tmp_path / "fresh.db"))
    assert fresh.import_export(dump, "boss@x.com") == {"added": 2, "replaced": 0, "skipped": 0}
    assert fresh.list_visible("quotes", "ana@x.com", False)[0][0]["number"] == "Q-1"
    fresh.save("leads", "l1", {"company": "Newer work"}, "ana@x.com", False)
    assert fresh.import_export(dump, "boss@x.com")["skipped"] == 2
    assert fresh.list_visible("leads", "ana@x.com", False)[0][0]["company"] == "Newer work"
    assert fresh.import_export(dump, "boss@x.com", overwrite=True)["replaced"] == 2
    assert fresh.list_visible("leads", "ana@x.com", False)[0][0]["company"] == "Lead One"
    with pytest.raises(ValueError):
        fresh.import_export({"nope": 1}, "x")
    assert fresh.import_export({"records": [{"kind": "leads", "id": "../x", "data": {}, "ownerEmail": "a@x.com"}, "junk"]}, "x")["skipped"] == 2
