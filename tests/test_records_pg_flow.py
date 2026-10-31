"""Control-flow tests for records_pg.PostgresRecordStore using a fake driver.
They check the store's sequencing and error handling (org lookup, validation
before any connection, savepoints, rollbacks). The SQL itself is exercised
against real Postgres in test_pg_schema.py and, with the real driver, in
test_records.py's Postgres variant."""
import sys
import types

import pytest

import records_pg


class FakePgError(Exception):
    pass


class Script:
    def __init__(self, org=("11111111-1111-1111-1111-111111111111",), existing=None):
        self.org, self.existing, self.log, self.connects, self.committed = org, existing or {}, [], 0, False


def make_store(script, monkeypatch):
    class Cur:
        def __init__(self):
            self.last = ""

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def execute(self, sql, params=None):
            self.last, self.params = sql, params
            script.log.append(sql.split("(")[0].strip().lower()[:40])

        def fetchone(self):
            if "org_for_email" in self.last:
                return script.org
            if "for update" in self.last:
                return script.existing.get(self.params[1])
            return None

        def fetchall(self):
            return []

    class Conn:
        def __enter__(self):
            script.connects += 1
            return self

        def __exit__(self, exc_type, *a):
            script.committed = exc_type is None
            return False

        def cursor(self):
            return Cur()

    fake = types.SimpleNamespace(connect=lambda dsn: Conn(), Error=FakePgError)
    monkeypatch.setitem(sys.modules, "psycopg", fake)
    monkeypatch.setitem(sys.modules, "psycopg.types", types.ModuleType("psycopg.types"))
    monkeypatch.setitem(sys.modules, "psycopg.types.json", types.SimpleNamespace(Jsonb=lambda d: ("jsonb", d)))
    return records_pg.PostgresRecordStore("dsn")


def test_user_without_org_is_refused_before_any_record_sql(monkeypatch):
    s = Script(org=None)
    store = make_store(s, monkeypatch)
    with pytest.raises(PermissionError, match="organization"):
        store.save("leads", "l1", {"company": "x"}, "ghost@x.com", False)
    assert not any("records" in q or "set_config" in q for q in s.log) and s.committed is False


def test_invalid_input_never_opens_a_connection(monkeypatch):
    s = Script()
    store = make_store(s, monkeypatch)
    with pytest.raises(ValueError):
        store.save("leads", "../etc", {"company": "x"}, "a@x.com", False)
    with pytest.raises(LookupError):
        store.list_visible("secrets", "a@x.com", False)
    assert s.connects == 0


def test_org_is_set_for_the_transaction_before_record_queries(monkeypatch):
    s = Script()
    store = make_store(s, monkeypatch)
    store.save("leads", "l1", {"company": "x"}, "a@x.com", False)
    assert s.log.index("select set_config") < s.log.index("insert into records") and s.committed


def test_forbidden_update_rolls_back_whole_transaction(monkeypatch):
    s = Script(existing={"a1": ("ana@x.com", {"orders": [{"date": "2999-01-01", "lines": []}], "activities": [{"type": "order", "date": "%d-01-01" % __import__("datetime").datetime.now().year, "amount": 50}]})})
    store = make_store(s, monkeypatch)
    with pytest.raises(PermissionError):
        store.save("accounts", "a1", {"company": "Hijack"}, "raj@x.com", False)
    assert s.committed is False and "insert into records" not in s.log


def test_bulk_uses_a_savepoint_per_record_and_reports_refusals(monkeypatch):
    s = Script()
    store = make_store(s, monkeypatch)
    res = store.save_many("leads", [{"id": "ok1", "company": "A"}, {"id": "bad id!", "company": "B"}], "a@x.com", False)
    assert [r["id"] for r in res["saved"]] == ["ok1"]
    assert res["errors"][0]["id"] == "bad id!" and res["errors"][0]["forbidden"] is False
    assert s.log.count("savepoint one_record") == 2
    assert s.log.count("rollback to savepoint one_record") == 1
    assert s.log.count("release savepoint one_record") == 2
    assert s.committed is True


def test_database_errors_in_bulk_are_isolated(monkeypatch):
    s = Script()
    store = make_store(s, monkeypatch)
    orig = store._write

    def flaky(cur, kind, rid, *a):
        if rid == "boom":
            raise FakePgError("check violation")
        return orig(cur, kind, rid, *a)

    store._write = flaky
    res = store.save_many("leads", [{"id": "boom"}, {"id": "fine"}], "a@x.com", False)
    assert [r["id"] for r in res["saved"]] == ["fine"] and "rejected" in res["errors"][0]["error"]


def test_delete_missing_returns_false_and_forbidden_raises(monkeypatch):
    s = Script()
    store = make_store(s, monkeypatch)
    assert store.delete("leads", "nope", "a@x.com", False) is False
    s2 = Script(existing={"l1": ("ana@x.com", {})})
    store2 = make_store(s2, monkeypatch)
    with pytest.raises(PermissionError):
        store2.delete("leads", "l1", "raj@x.com", False)
    assert store2.delete("leads", "l1", "boss@x.com", True) is True
