import os
import subprocess
import uuid

import pytest

from accounts_store import RecordStore, limited_view, order_spend, ytd_spend

YEAR = "2026"


def order(amount, date=f"{YEAR}-03-01"):
    return {"date": date, "lines": [{"qty": 1, "unitPrice": amount}]}


PG_ADMIN = os.environ.get("TEST_PG_ADMIN")
MIGRATION = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "migrations", "001_init.sql")


def _psql(conninfo, sql=None, file=None):
    cmd = ["psql", conninfo, "-X", "-q", "-v", "ON_ERROR_STOP=1"] + (["-f", file] if file else ["-c", sql])
    subprocess.run(cmd, check=True, capture_output=True, text=True)


@pytest.fixture(params=["sqlite", "postgres"])
def store(request, tmp_path):
    """Every permission test runs against both stores: behavior must be identical."""
    if request.param == "sqlite":
        yield RecordStore(str(tmp_path / "t.db"))
        return
    psycopg = pytest.importorskip("psycopg")
    if not PG_ADMIN:
        pytest.skip("TEST_PG_ADMIN not set")
    from psycopg.conninfo import make_conninfo
    from records_pg import PostgresRecordStore

    name = "vs_rec_" + uuid.uuid4().hex[:10]
    _psql(PG_ADMIN, f"create database {name}")
    admin_db = make_conninfo(PG_ADMIN, dbname=name)
    try:
        _psql(admin_db, file=MIGRATION)
        org = str(uuid.uuid4())
        _psql(admin_db, f"insert into orgs (id, name) values ('{org}', 'T');"
                        + "".join(f"insert into memberships (email, org_id) values ('{e}', '{org}');"
                                  for e in ("ana@x.com", "raj@x.com", "boss@x.com", "a@x.com")))
        _psql(PG_ADMIN, "alter role vectorsales_app login password 'test'")
        yield PostgresRecordStore(make_conninfo(admin_db, user="vectorsales_app", password="test"))
    finally:
        _psql(PG_ADMIN, f"drop database {name} with (force)")


def test_order_spend_uses_shipped_qty_and_ignores_tax_freight():
    o = {"lines": [{"qty": 10, "shipped": 4, "unitPrice": 2.5}, {"qty": 2, "unitPrice": 10}], "tax": 99, "freight": 50}
    assert order_spend(o) == 4 * 2.5 + 2 * 10


def test_ytd_counts_only_this_year_and_legacy_order_activities():
    data = {
        "orders": [order(100), order(500, "2025-12-31")],
        "activities": [
            {"type": "order", "date": f"{YEAR}-02-01", "amount": 40},
            {"type": "order", "date": f"{YEAR}-02-01", "amount": 999, "orderId": "o1"},  # already an invoice
            {"type": "note", "date": f"{YEAR}-02-01", "amount": 7},
        ],
    }
    assert ytd_spend(data, int(YEAR)) == 140


def test_limited_view_exposes_only_safe_fields():
    v = limited_view("a1", {"company": "Acme", "phone": "1", "email": "secret@x.com", "contactName": "Z", "orders": [order(5)]})
    assert v["company"] == "Acme" and v["limited"] is True
    assert "email" not in v and "contactName" not in v and "orders" not in v


def customer(amount=1000):
    from datetime import datetime, timezone
    year = datetime.now(timezone.utc).year
    return {"company": "Acme", "email": "buyer@acme.com", "orders": [order(amount, f"{year}-01-15")]}


def test_other_rep_sees_only_limited_view_of_customer_account(store):
    store.save("accounts", "a1", customer(), "ana@x.com", False)
    full, limited = store.list_visible("accounts", "raj@x.com", False)
    assert full == [] and limited[0]["limited"] and "email" not in limited[0]


def test_owner_and_manager_see_full_customer_account(store):
    store.save("accounts", "a1", customer(), "ana@x.com", False)
    for who, mgr in (("ana@x.com", False), ("boss@x.com", True)):
        full, limited = store.list_visible("accounts", who, mgr)
        assert full[0]["email"] == "buyer@acme.com" and limited == []


def test_non_owner_cannot_edit_customer_account(store):
    store.save("accounts", "a1", customer(), "ana@x.com", False)
    with pytest.raises(PermissionError):
        store.save("accounts", "a1", {"company": "Hijack"}, "raj@x.com", False)


def test_prospects_and_leads_are_open_and_claimable(store):
    store.save("accounts", "p1", {"company": "NoOrders"}, "ana@x.com", False)
    full, _ = store.list_visible("accounts", "raj@x.com", False)
    assert [r["id"] for r in full] == ["p1"]
    out = store.save("accounts", "p1", {"company": "NoOrders", "ownerEmail": "raj@x.com"}, "raj@x.com", False)
    assert out["ownerEmail"] == "raj@x.com"


def test_non_manager_cannot_assign_to_someone_else(store):
    store.save("leads", "l1", {"company": "L"}, "ana@x.com", False)
    out = store.save("leads", "l1", {"company": "L", "ownerEmail": "boss@x.com"}, "raj@x.com", False)
    assert out["ownerEmail"] == "ana@x.com"
    out = store.save("leads", "l1", {"company": "L", "ownerEmail": "boss@x.com"}, "boss@x.com", True)
    assert out["ownerEmail"] == "boss@x.com"


def test_only_owner_or_manager_can_delete(store):
    store.save("leads", "l1", {"company": "L"}, "ana@x.com", False)
    with pytest.raises(PermissionError):
        store.delete("leads", "l1", "raj@x.com", False)
    assert store.delete("leads", "l1", "boss@x.com", True) is True
    assert store.delete("leads", "l1", "boss@x.com", True) is False


def test_validation_unknown_kind_bad_id_oversize(store):
    with pytest.raises(LookupError):
        store.list_visible("secrets", "a@x.com", False)
    with pytest.raises(ValueError):
        store.save("leads", "../etc", {"company": "x"}, "a@x.com", False)
    with pytest.raises(ValueError):
        store.save("leads", "big", {"blob": "x" * (2 * 1024 * 1024 + 1)}, "a@x.com", False)


def test_bulk_save_reports_refusals_without_blocking_others(store):
    store.save("accounts", "a1", customer(), "ana@x.com", False)
    res = store.save_many(
        "accounts",
        [{"id": "a1", "company": "Hijack"}, {"id": "n1", "company": "Fine"}, {"id": "bad id!", "company": "x"}],
        "raj@x.com", False,
    )
    assert [r["id"] for r in res["saved"]] == ["n1"]
    assert {e["id"]: e["forbidden"] for e in res["errors"]} == {"a1": True, "bad id!": False}
