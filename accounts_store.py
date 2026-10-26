"""Shared customer accounts, stored on the server so every rep's map can show
every account while only the right people see the details.

Who sees what (enforced here, not in the browser):
- the account's owner (the rep who created it, or whoever a manager assigns)
  and managers get the full record and can edit it;
- every other signed-in user gets only the name, address, general phone
  number, year-to-date spend and map position.

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

MAX_RECORD_BYTES = 256 * 1024
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
# What a non-owner, non-manager may see. Everything else stays private.
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


def limited_view(account_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
    view = {k: data.get(k) for k in LIMITED_FIELDS}
    view.update({"id": account_id, "ytdSpend": ytd_spend(data), "limited": True})
    return view


class AccountStore:
    def __init__(self, path: str):
        self.path = path
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS accounts ("
            " id TEXT PRIMARY KEY, owner TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL)"
        )
        self.db.commit()

    def _row(self, account_id: str) -> Optional[Tuple[str, Dict[str, Any]]]:
        row = self.db.execute("SELECT owner, data FROM accounts WHERE id = ?", (account_id,)).fetchone()
        return (row[0], json.loads(row[1])) if row else None

    @staticmethod
    def _full(account_id: str, owner: str, data: Dict[str, Any]) -> Dict[str, Any]:
        return {**data, "id": account_id, "ownerEmail": owner, "ytdSpend": ytd_spend(data)}

    def list_visible(self, email: str, is_manager: bool) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        """(full records the user may open, limited records of everyone else's accounts)."""
        full, limited = [], []
        with self.lock:
            rows = self.db.execute("SELECT id, owner, data FROM accounts ORDER BY id").fetchall()
        for account_id, owner, raw in rows:
            data = json.loads(raw)
            if is_manager or owner == email:
                full.append(self._full(account_id, owner, data))
            else:
                limited.append(limited_view(account_id, data))
        return full, limited

    def save(self, account_id: str, data: Dict[str, Any], email: str, is_manager: bool) -> Dict[str, Any]:
        if not ID_RE.match(account_id or ""):
            raise ValueError("Invalid account id.")
        if not isinstance(data, dict):
            raise ValueError("Account must be a JSON object.")
        data = {k: v for k, v in data.items() if k not in ("id", "ytdSpend", "limited")}
        requested_owner = str(data.pop("ownerEmail", "") or "").strip().lower()
        if len(json.dumps(data)) > MAX_RECORD_BYTES:
            raise ValueError("Account record is too large.")
        with self.lock:
            existing = self._row(account_id)
            if existing:
                owner = existing[0]
                if owner != email and not is_manager:
                    raise PermissionError("Only the account's owner or a manager can change it.")
                # Only managers reassign accounts.
                if is_manager and requested_owner:
                    owner = requested_owner
            else:
                owner = requested_owner if (is_manager and requested_owner) else email
            now = datetime.now(timezone.utc).isoformat()
            self.db.execute(
                "INSERT INTO accounts (id, owner, data, updated_at) VALUES (?, ?, ?, ?)"
                " ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, data = excluded.data, updated_at = excluded.updated_at",
                (account_id, owner, json.dumps(data), now),
            )
            self.db.commit()
        return self._full(account_id, owner, data)

    def delete(self, account_id: str, email: str, is_manager: bool) -> bool:
        with self.lock:
            existing = self._row(account_id)
            if not existing:
                return False
            if existing[0] != email and not is_manager:
                raise PermissionError("Only the account's owner or a manager can delete it.")
            self.db.execute("DELETE FROM accounts WHERE id = ?", (account_id,))
            self.db.commit()
        return True
