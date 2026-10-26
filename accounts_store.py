"""Shared sales records (customer accounts and leads), stored on the server so
the whole team works from one map and one pipeline, with access enforced here
rather than in the browser.

Who sees and manages what:
- **Customer accounts** (an account with orders logged this calendar year):
  the owner (the rep who created it, or whoever a manager assigns) and
  managers get the full record and can edit it. Every other user gets only
  the name, address, general phone number, year-to-date spend and map position.
- **Prospective accounts** (an account with no orders year to date) and
  **leads** are open: every signed-in user sees and can edit the full record,
  and may claim it (make themselves the owner).
- Deleting is limited to the record's owner and managers. Only managers can
  hand a record to someone other than themselves.

Records are JSON documents in a SQLite database under DATA_DIR (the Render
persistent disk in production); without a persistent disk they are lost on
restart.
"""
import json
import re
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

KINDS = ("accounts", "leads")
MAX_RECORD_BYTES = 256 * 1024
MAX_BULK = 2000
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
# What a non-owner, non-manager may see of a customer account.
LIMITED_FIELDS = ("company", "address", "city", "state", "zip", "phone", "lat", "lng")


def ytd_spend(data: Dict[str, Any], year: Optional[int] = None) -> float:
    """Sum of this calendar year's orders logged on the account."""
    year = year or datetime.now(timezone.utc).year
    total = 0.0
    for act in data.get("activities") or []:
        if not isinstance(act, dict) or act.get("type") != "order":
            continue
        if not str(act.get("date", "")).startswith(str(year)):
            continue
        try:
            total += float(act.get("amount") or 0)
        except (TypeError, ValueError):
            continue
    return round(total, 2)


def limited_view(record_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
    view = {k: data.get(k) for k in LIMITED_FIELDS}
    view.update({"id": record_id, "ytdSpend": ytd_spend(data), "limited": True})
    return view


def is_open(kind: str, data: Dict[str, Any]) -> bool:
    """Open to every user: all leads, and accounts not ordering this year."""
    return kind == "leads" or ytd_spend(data) <= 0


class RecordStore:
    def __init__(self, path: str):
        self.path = path
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS records ("
            " kind TEXT NOT NULL, id TEXT NOT NULL, owner TEXT NOT NULL, data TEXT NOT NULL,"
            " updated_at TEXT NOT NULL, PRIMARY KEY (kind, id))"
        )
        # Earlier builds kept accounts in their own table.
        old = self.db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'").fetchone()
        if old:
            self.db.execute(
                "INSERT OR IGNORE INTO records (kind, id, owner, data, updated_at)"
                " SELECT 'accounts', id, owner, data, updated_at FROM accounts"
            )
            self.db.execute("DROP TABLE accounts")
        self.db.commit()

    @staticmethod
    def _check_kind(kind: str) -> None:
        if kind not in KINDS:
            raise LookupError(f"Unknown record type: {kind}")

    def _row(self, kind: str, record_id: str) -> Optional[Tuple[str, Dict[str, Any]]]:
        row = self.db.execute("SELECT owner, data FROM records WHERE kind = ? AND id = ?", (kind, record_id)).fetchone()
        return (row[0], json.loads(row[1])) if row else None

    @staticmethod
    def _full(kind: str, record_id: str, owner: str, data: Dict[str, Any]) -> Dict[str, Any]:
        out = {**data, "id": record_id, "ownerEmail": owner}
        if kind == "accounts":
            out["ytdSpend"] = ytd_spend(data)
        return out

    def list_visible(self, kind: str, email: str, is_manager: bool) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        """(full records the user may open and edit, limited views of the rest)."""
        self._check_kind(kind)
        full, limited = [], []
        with self.lock:
            rows = self.db.execute("SELECT id, owner, data FROM records WHERE kind = ? ORDER BY id", (kind,)).fetchall()
        for record_id, owner, raw in rows:
            data = json.loads(raw)
            if is_manager or owner == email or is_open(kind, data):
                full.append(self._full(kind, record_id, owner, data))
            else:
                limited.append(limited_view(record_id, data))
        return full, limited

    def _save_locked(self, kind: str, record_id: str, data: Dict[str, Any], email: str, is_manager: bool) -> Dict[str, Any]:
        if not ID_RE.match(record_id or ""):
            raise ValueError("Invalid record id.")
        if not isinstance(data, dict):
            raise ValueError("Record must be a JSON object.")
        data = {k: v for k, v in data.items() if k not in ("id", "ytdSpend", "limited")}
        requested_owner = str(data.pop("ownerEmail", "") or "").strip().lower()
        if len(json.dumps(data)) > MAX_RECORD_BYTES:
            raise ValueError("Record is too large.")
        existing = self._row(kind, record_id)
        if existing:
            owner, before = existing
            if owner != email and not is_manager and not is_open(kind, before):
                raise PermissionError("Only the account's owner or a manager can change a customer account.")
            if requested_owner and requested_owner != owner:
                # Managers assign to anyone; others may only claim an open record for themselves.
                if is_manager or (requested_owner == email and is_open(kind, before)):
                    owner = requested_owner
        else:
            owner = requested_owner if (is_manager and requested_owner) else email
        self.db.execute(
            "INSERT INTO records (kind, id, owner, data, updated_at) VALUES (?, ?, ?, ?, ?)"
            " ON CONFLICT(kind, id) DO UPDATE SET owner = excluded.owner, data = excluded.data, updated_at = excluded.updated_at",
            (kind, record_id, owner, json.dumps(data), datetime.now(timezone.utc).isoformat()),
        )
        return self._full(kind, record_id, owner, data)

    def save(self, kind: str, record_id: str, data: Dict[str, Any], email: str, is_manager: bool) -> Dict[str, Any]:
        self._check_kind(kind)
        with self.lock:
            out = self._save_locked(kind, record_id, data, email, is_manager)
            self.db.commit()
        return out

    def save_many(self, kind: str, records: List[Dict[str, Any]], email: str, is_manager: bool) -> Dict[str, Any]:
        """Saves each record independently; returns what was saved and what was refused."""
        self._check_kind(kind)
        if not isinstance(records, list) or len(records) > MAX_BULK:
            raise ValueError(f"Send a list of at most {MAX_BULK} records.")
        saved, errors = [], []
        with self.lock:
            for rec in records:
                rid = str((rec or {}).get("id", "")) if isinstance(rec, dict) else ""
                try:
                    saved.append(self._save_locked(kind, rid, rec, email, is_manager))
                except (PermissionError, ValueError) as e:
                    errors.append({"id": rid, "error": str(e), "forbidden": isinstance(e, PermissionError)})
            self.db.commit()
        return {"saved": saved, "errors": errors}

    def delete(self, kind: str, record_id: str, email: str, is_manager: bool) -> bool:
        self._check_kind(kind)
        with self.lock:
            existing = self._row(kind, record_id)
            if not existing:
                return False
            if existing[0] != email and not is_manager:
                raise PermissionError("Only the record's owner or a manager can delete it.")
            self.db.execute("DELETE FROM records WHERE kind = ? AND id = ?", (kind, record_id))
            self.db.commit()
        return True
