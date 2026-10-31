"""Postgres-backed shared records (accounts and leads): the multi-tenant
counterpart of accounts_store.RecordStore, with the same methods and the same
permission rules (they live in accounts_store and are shared).

Tenant isolation is enforced by the database, not just this code: every call
looks up the signed-in user's org (org_for_email), sets it for the transaction
(app.org_id), and Postgres row-level security then hides every other org's rows
(see migrations/001_init.sql). Connect as the unprivileged vectorsales_app role.
"""
from contextlib import contextmanager
from typing import Any, Dict, Iterator, List, Tuple

from accounts_store import (
    KINDS,
    MAX_BULK,
    can_open,
    full_record,
    limited_view,
    may_delete,
    prepare_record,
    resolve_owner,
)


class PostgresRecordStore:
    def __init__(self, dsn: str):
        import psycopg  # imported here so SQLite-only installs don't need the driver
        from psycopg.types.json import Jsonb

        self._pg = psycopg
        self._jsonb = Jsonb
        self.dsn = dsn

    @staticmethod
    def _check_kind(kind: str) -> None:
        if kind not in KINDS:
            raise LookupError(f"Unknown record type: {kind}")

    @contextmanager
    def _tx(self, email: str) -> Iterator[Any]:
        """One transaction scoped to the user's org. Commits on success, rolls back on any error."""
        with self._pg.connect(self.dsn) as conn:
            with conn.cursor() as cur:
                cur.execute("select org_id from org_for_email(%s)", (email,))
                row = cur.fetchone()
                if not row:
                    raise PermissionError("Your account isn't part of an organization yet.")
                cur.execute("select set_config('app.org_id', %s, true)", (str(row[0]),))
                yield cur

    def list_visible(self, kind: str, email: str, is_manager: bool) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        """(full records the user may open and edit, limited views of the rest)."""
        self._check_kind(kind)
        full, limited = [], []
        with self._tx(email) as cur:
            cur.execute("select id, owner, data from records where kind = %s order by id", (kind,))
            rows = cur.fetchall()
        for record_id, owner, data in rows:
            if can_open(kind, owner, data, email, is_manager):
                full.append(full_record(kind, record_id, owner, data))
            else:
                limited.append(limited_view(record_id, data))
        return full, limited

    def _write(self, cur: Any, kind: str, record_id: str, data: Dict[str, Any], requested_owner: str,
               email: str, is_manager: bool) -> Dict[str, Any]:
        cur.execute("select owner, data from records where kind = %s and id = %s for update", (kind, record_id))
        row = cur.fetchone()
        owner = resolve_owner(kind, (row[0], row[1]) if row else None, email, is_manager, requested_owner)
        cur.execute(
            "insert into records (org_id, kind, id, owner, data) values (current_org(), %s, %s, %s, %s)"
            " on conflict (org_id, kind, id) do update set owner = excluded.owner, data = excluded.data, updated_at = now()",
            (kind, record_id, owner, self._jsonb(data)),
        )
        return full_record(kind, record_id, owner, data)

    def save(self, kind: str, record_id: str, data: Dict[str, Any], email: str, is_manager: bool) -> Dict[str, Any]:
        self._check_kind(kind)
        data, requested_owner = prepare_record(record_id, data)  # validate before touching the database
        with self._tx(email) as cur:
            return self._write(cur, kind, record_id, data, requested_owner, email, is_manager)

    def save_many(self, kind: str, records: List[Dict[str, Any]], email: str, is_manager: bool) -> Dict[str, Any]:
        """Saves each record independently; returns what was saved and what was refused."""
        self._check_kind(kind)
        if not isinstance(records, list) or len(records) > MAX_BULK:
            raise ValueError(f"Send a list of at most {MAX_BULK} records.")
        saved, errors = [], []
        with self._tx(email) as cur:
            for rec in records:
                rid = str((rec or {}).get("id", "")) if isinstance(rec, dict) else ""
                cur.execute("savepoint one_record")
                try:
                    data, requested_owner = prepare_record(rid, rec)
                    saved.append(self._write(cur, kind, rid, data, requested_owner, email, is_manager))
                    cur.execute("release savepoint one_record")
                except (PermissionError, ValueError) as e:
                    cur.execute("rollback to savepoint one_record")
                    cur.execute("release savepoint one_record")
                    errors.append({"id": rid, "error": str(e), "forbidden": isinstance(e, PermissionError)})
                except self._pg.Error:
                    cur.execute("rollback to savepoint one_record")
                    cur.execute("release savepoint one_record")
                    errors.append({"id": rid, "error": "The database rejected this record.", "forbidden": False})
        return {"saved": saved, "errors": errors}

    def delete(self, kind: str, record_id: str, email: str, is_manager: bool) -> bool:
        self._check_kind(kind)
        with self._tx(email) as cur:
            cur.execute("select owner from records where kind = %s and id = %s for update", (kind, record_id))
            row = cur.fetchone()
            if not row:
                return False
            may_delete(row[0], email, is_manager)
            cur.execute("delete from records where kind = %s and id = %s", (kind, record_id))
            return True
