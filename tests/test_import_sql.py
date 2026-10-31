import json
import os
import shutil
import sqlite3
import subprocess
import sys
import uuid

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
import sqlite_to_postgres as imp  # noqa: E402

from accounts_store import RecordStore  # noqa: E402

ADMIN = os.environ.get("TEST_PG_ADMIN")
MIGRATION = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "migrations", "001_init.sql")

NASTY = {"company": "O'Brien & \"Sons\" \\ Supply", "notes": "line1\nline2\ttab \\n literal", "emoji": "café ☕ 北京",
         "sql": "'); drop table records; --", "n": 12.5, "nested": {"a": [1, None, True]}}


def make_sqlite(tmp_path):
    store = RecordStore(str(tmp_path / "sales_hub.db"))
    store.save("accounts", "a1", NASTY, "ana@x.com", False)
    store.save("leads", "l1", {"company": "Lead Co"}, "Raj@X.com", False)
    return str(tmp_path / "sales_hub.db")


def test_org_id_is_stable_and_name_based():
    assert imp.org_id_for("Office Basics") == imp.org_id_for("  office basics ")
    assert imp.org_id_for("A") != imp.org_id_for("B")


def test_quoting_rejects_nul_and_doubles_quotes():
    assert imp.q("it's") == "'it''s'"
    with pytest.raises(ValueError):
        imp.q("a\x00b")


def test_bad_rows_are_skipped_and_reported():
    rows = [("accounts", "ok", "a@x.com", "{}"), ("widgets", "w", "a@x.com", "{}"),
            ("leads", "bad id!", "a@x.com", "{}"), ("leads", "l2", "not-an-email", "{}"),
            ("leads", "l3", "a@x.com", "{not json")]
    sql, stats = imp.build_sql(rows, "Org")
    assert stats == {"records": 1, "skipped": 4, "members": 1}
    assert sql.count("-- SKIPPED") == 4


def test_managers_override_member_role_and_owners_become_reps():
    sql, stats = imp.build_sql([("leads", "l1", "ana@x.com", "{}")], "Org", managers=["Boss@x.com"], members=["ana@x.com"])
    assert "'boss@x.com', " in sql and "'manager'" in sql and "'ana@x.com', " in sql
    assert stats["members"] == 2


def test_cli_reads_sqlite_read_only_and_emits_sql(tmp_path):
    db = make_sqlite(tmp_path)
    p = subprocess.run([sys.executable, imp.__file__, "--db", db, "--org", "Acme", "--manager", "ana@x.com"],
                       capture_output=True, text=True)
    assert p.returncode == 0 and "begin;" in p.stdout and "2 records" in p.stderr


@pytest.mark.skipif(not (ADMIN and shutil.which("psql")), reason="TEST_PG_ADMIN/psql not available")
def test_import_roundtrips_exactly_into_postgres_and_is_idempotent(tmp_path):
    db = make_sqlite(tmp_path)
    sql, _ = imp.build_sql(imp.read_records(db), "Acme", managers=["ana@x.com"])
    name = "vs_imp_" + uuid.uuid4().hex[:10]

    def run(conn, text=None, file=None):
        cmd = ["psql", conn, "-X", "-q", "-tA", "-v", "ON_ERROR_STOP=1"] + (["-f", file] if file else ["-f", "-"])
        return subprocess.run(cmd, input=text, capture_output=True, text=True)

    assert run(ADMIN + " dbname=postgres", "create database " + name).returncode == 0
    conn = f"{ADMIN} dbname={name}"
    try:
        assert run(conn, file=MIGRATION).returncode == 0
        for _ in range(2):  # twice: must be idempotent
            r = run(conn, sql)
            assert r.returncode == 0, r.stderr
        org = imp.org_id_for("Acme")
        assert run(conn, f"select count(*) from records where org_id='{org}'").stdout.strip() == "2"
        assert run(conn, "select count(*) from orgs").stdout.strip() == "1"
        assert run(conn, "select string_agg(email||':'||role, ',' order by email) from memberships").stdout.strip() == \
            "ana@x.com:manager,raj@x.com:rep"
        got = json.loads(run(conn, "select data::text from records where id='a1'").stdout)
        assert got == NASTY  # quotes, backslashes, newlines, unicode and SQL-looking text survive exactly
        # and the data is only visible through the right org context
        seen = run(conn, f"set role vectorsales_app;\nselect set_config('app.org_id','{org}',false) \\g /dev/null\n"
                         "select count(*) from records;").stdout.strip()
        assert seen == "2"
        other = run(conn, f"set role vectorsales_app;\nselect set_config('app.org_id','{uuid.uuid4()}',false) \\g /dev/null\n"
                          "select count(*) from records;").stdout.strip()
        assert other == "0"
    finally:
        run(ADMIN + " dbname=postgres", f"drop database {name} with (force)")
