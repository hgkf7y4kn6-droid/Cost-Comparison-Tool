"""Verifies migrations/001_init.sql against a real Postgres, through the psql
CLI (no Python driver needed). Set TEST_PG_ADMIN to a libpq connection string
for a superuser, e.g. "host=/tmp port=54329 user=postgres"; otherwise skipped.
Each run uses a throwaway database."""
import os
import shutil
import subprocess
import uuid

import pytest

ADMIN = os.environ.get("TEST_PG_ADMIN")
MIGRATION = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "migrations", "001_init.sql")

pytestmark = pytest.mark.skipif(not (ADMIN and shutil.which("psql")), reason="TEST_PG_ADMIN/psql not available")

ORG_A = str(uuid.uuid4())
ORG_B = str(uuid.uuid4())


def psql(conninfo, sql, *, file=None):
    cmd = ["psql", conninfo, "-X", "-q", "-tA", "-v", "ON_ERROR_STOP=1"]
    if file:
        cmd += ["-f", file]
        p = subprocess.run(cmd, capture_output=True, text=True)
    else:
        p = subprocess.run(cmd + ["-f", "-"], input=sql, capture_output=True, text=True)
    return p.returncode, p.stdout.strip(), p.stderr.strip()


@pytest.fixture(scope="module")
def db():
    name = "vs_test_" + uuid.uuid4().hex[:10]
    assert psql(ADMIN, f"create database {name}")[0] == 0
    conn = f"{ADMIN} dbname={name}"
    rc, _, err = psql(conn, None, file=MIGRATION)
    assert rc == 0, err
    psql(conn, f"insert into orgs (id, name) values ('{ORG_A}', 'A'), ('{ORG_B}', 'B');"
               f"insert into memberships (email, org_id, role) values ('ana@a.com', '{ORG_A}', 'rep'),"
               f"('bob@b.com', '{ORG_B}', 'manager')")
    yield conn
    psql(ADMIN, f"drop database {name} with (force)")


def app(db, org, sql):
    """Runs sql as the unprivileged app role with the given org context."""
    ctx = f"select set_config('app.org_id', '{org}', false) \\g /dev/null\n" if org is not None else ""
    return psql(db, f"set role vectorsales_app;\n{ctx}{sql}")


def test_migration_is_not_reapplicable_but_creates_expected_tables(db):
    rc, out, _ = psql(db, "select string_agg(tablename, ',' order by tablename) from pg_tables where schemaname='public'")
    assert out == "deal_events,memberships,orgs,records"


def test_app_role_is_not_superuser_and_cannot_bypass_rls(db):
    rc, out, _ = psql(db, "select rolsuper, rolbypassrls from pg_roles where rolname='vectorsales_app'")
    assert out == "f|f"


def test_records_visible_only_within_own_org(db):
    assert app(db, ORG_A, "insert into records values (current_org(), 'leads', 'l1', 'ana@a.com', '{\"company\":\"A-Co\"}')")[0] == 0
    assert app(db, ORG_B, "insert into records values (current_org(), 'leads', 'l1', 'bob@b.com', '{\"company\":\"B-Co\"}')")[0] == 0
    assert app(db, ORG_A, "select data->>'company' from records")[1] == "A-Co"
    assert "B-Co" not in app(db, ORG_A, "select data->>'company' from records")[1]
    assert "A-Co" not in app(db, ORG_B, "select data->>'company' from records")[1]


def test_same_record_id_allowed_in_two_orgs(db):
    # both orgs above created leads/l1 without conflict
    rc, out, _ = psql(db, "select count(*) from records where kind='leads' and id='l1'")
    assert out == "2"


def test_cannot_insert_into_another_org(db):
    rc, _, err = app(db, ORG_A, f"insert into records values ('{ORG_B}', 'leads', 'evil', 'ana@a.com', '{{}}')")
    assert rc != 0 and "row-level security" in err


def test_cannot_update_or_delete_another_orgs_rows(db):
    rc, out, _ = app(db, ORG_A, "update records set data = '{\"hacked\":1}' where id = 'l1' and owner = 'bob@b.com' returning id")
    assert rc == 0 and out == ""
    rc, out, _ = app(db, ORG_A, "delete from records where owner = 'bob@b.com' returning id")
    assert rc == 0 and out == ""
    assert psql(db, "select count(*) from records where owner='bob@b.com'")[1] == "1"


def test_cannot_move_own_row_to_another_org(db):
    rc, _, err = app(db, ORG_A, f"update records set org_id = '{ORG_B}' where owner = 'ana@a.com'")
    assert rc != 0 and "row-level security" in err


def test_no_org_context_sees_and_writes_nothing(db):
    assert app(db, None, "select count(*) from records")[1] == "0"
    assert app(db, "", "select count(*) from records")[1] == "0"
    rc, _, err = app(db, None, f"insert into records values ('{ORG_A}', 'leads', 'x', 'a', '{{}}')")
    assert rc != 0


def test_record_constraints(db):
    rc, _, err = app(db, ORG_A, "insert into records values (current_org(), 'secrets', 'k1', 'a', '{}')")
    assert rc != 0 and "check" in err
    rc, _, err = app(db, ORG_A, "insert into records values (current_org(), 'leads', '../etc', 'a', '{}')")
    assert rc != 0 and "check" in err


def test_app_role_cannot_read_org_or_membership_tables_but_can_resolve_itself(db):
    assert app(db, ORG_A, "select * from memberships")[0] != 0
    assert app(db, ORG_A, "select * from orgs")[0] != 0
    rc, out, _ = app(db, None, "select org_id, role from org_for_email('BOB@b.com')")
    assert out == f"{ORG_B}|manager"
    assert app(db, None, "select count(*) from org_for_email('nobody@x.com')")[1] == "0"


def add_event(db, org, kind, actor="ana@a.com"):
    return app(db, org, f"insert into deal_events (org_id, deal_id, actor, actor_type, type, payload) "
                        f"values (current_org(), 'D1', '{actor}', 'user', '{kind}', '{{\"n\":1}}') returning chain_index")


def test_event_chain_is_linear_per_org_and_verifies(db):
    for k in ("discovery_note", "quote_sent", "quote_won"):
        assert add_event(db, ORG_A, k)[0] == 0
    assert add_event(db, ORG_B, "quote_sent", "bob@b.com")[1] == "1"  # B starts its own chain
    rc, out, _ = psql(db, "select chain_index, prev_hash = 'genesis' from deal_events "
                          f"where org_id='{ORG_A}' order by chain_index")
    assert out.splitlines()[0] == "1|t" and len(out.splitlines()) == 3
    assert app(db, ORG_A, "select coalesce(verify_deal_events()::text, 'ok')")[1]== "ok"


def test_events_are_isolated_and_append_only(db):
    assert app(db, ORG_B, "select count(*) from deal_events")[1] == "1"
    assert app(db, ORG_A, "select count(*) from deal_events")[1] == "3"
    for stmt in ("update deal_events set type='x'", "delete from deal_events"):
        rc, _, err = app(db, ORG_A, stmt)
        assert rc != 0, stmt
    # even the table owner cannot edit through normal SQL
    rc, _, err = psql(db, "update deal_events set type='x'")
    assert rc != 0 and "append-only" in err
    rc, _, err = app(db, ORG_A, f"insert into deal_events (org_id, actor, actor_type, type) values ('{ORG_B}', 'a', 'user', 'x')")
    assert rc != 0 and "row-level security" in err


def test_event_actor_type_validated(db):
    rc, _, err = app(db, ORG_A, "insert into deal_events (org_id, actor, actor_type, type) values (current_org(), 'a', 'robot', 'x')")
    assert rc != 0 and "check" in err


def test_tampering_with_storage_is_detected(db):
    # Simulates someone bypassing triggers at the storage level (replica mode needs superuser).
    rc, _, err = psql(db, f"set session_replication_role = replica; update deal_events set payload='{{\"n\":999}}' "
                          f"where org_id='{ORG_A}' and chain_index=2")
    assert rc == 0, err
    assert app(db, ORG_A, "select verify_deal_events()")[1]== "2"
    assert app(db, ORG_B, "select coalesce(verify_deal_events()::text, 'ok')")[1]== "ok"
