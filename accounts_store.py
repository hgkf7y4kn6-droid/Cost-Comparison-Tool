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
- **Quotes** (proposals, which carry supplier costs and margins) are private:
  only their owner is ever sent them; nobody else, managers included, sees them
  in a listing. A manager may still overwrite or delete one by id (the same
  authority they have over accounts), export everything for backup, and every
  delete is audited and restorable.
- Deleting is limited to the record's owner and managers. Only managers can
  hand a record to someone other than themselves.

Records are JSON documents in a SQLite database under DATA_DIR (the Render
persistent disk in production); without a persistent disk they are lost on
restart.

Safety nets (all inside the one SQLite file, no extra services):
- every record carries a revision number; a save that names the revision it was
  based on (`baseRev`) is refused with a conflict if someone else saved first,
  so one rep's edit can't silently erase another's;
- deletes and owner changes are written to an `audit` table, and a delete keeps
  a full copy of the record there so it can be restored;
- `backup_to()` writes a consistent copy of the database (see backend.py, which
  schedules it) and `export_all()` gives managers a JSON dump.
"""
import json
import re
import sqlite3
import threading
import os
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple

import pricing

KINDS = ("accounts", "leads", "quotes")
PRIVATE_KINDS = ("quotes",)  # listed only to their owner
MAX_RECORD_BYTES = 2 * 1024 * 1024  # accounts carry their invoice history
MAX_BULK = 2000
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
SERVER_ONLY_KEYS = ("id", "ytdSpend", "limited", "rev", "baseRev")


class ConflictError(Exception):
    """The record changed since the caller loaded it."""

# What a non-owner, non-manager may see of a customer account.
LIMITED_FIELDS = ("company", "address", "city", "state", "zip", "phone", "lat", "lng")


def _num(v: Any) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def _dec(v: Any) -> Decimal:
    return pricing.to_decimal(v) or Decimal(0)


def order_spend(order: Dict[str, Any]) -> float:
    """Merchandise billed on an invoice: shipped quantity x unit price, each line
    rounded to the cent (tax and freight excluded; back-ordered units count when
    they ship). Mirrors frontend/calc.js orderTotals; tests/fixtures/calc_cases.json
    holds the cases both must agree on."""
    total = Decimal(0)
    for line in order.get("lines") or []:
        if not isinstance(line, dict):
            continue
        qty = line.get("shipped")
        qty = line.get("qty") if qty in (None, "") else qty
        total += pricing.money(_dec(qty) * _dec(line.get("unitPrice")))
    return float(total)


def ytd_spend(data: Dict[str, Any], year: Optional[int] = None) -> float:
    """This calendar year's spend: invoiced orders, plus amounts logged on
    "order" activities from before invoices existed (ones not yet converted)."""
    year = str(year or datetime.now().year)  # the server's calendar year; the rep's browser uses their local one
    total = Decimal(0)
    for order in data.get("orders") or []:
        if isinstance(order, dict) and str(order.get("date", "")).startswith(year):
            total += Decimal(str(order_spend(order)))
    for act in data.get("activities") or []:
        if not isinstance(act, dict) or act.get("type") != "order" or act.get("orderId"):
            continue
        if str(act.get("date", "")).startswith(year):
            total += _dec(act.get("amount"))
    return float(pricing.money(total))


def limited_view(record_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
    view = {k: data.get(k) for k in LIMITED_FIELDS}
    view.update({"id": record_id, "ytdSpend": ytd_spend(data), "limited": True})
    return view


def is_open(kind: str, data: Dict[str, Any]) -> bool:
    """Open to every user: all leads, and accounts not ordering this year. Never quotes."""
    return kind == "leads" or (kind == "accounts" and ytd_spend(data) <= 0)


class RecordStore:
    def __init__(self, path: str):
        self.path = path
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path, check_same_thread=False, timeout=30)
        try:
            self.db.execute("PRAGMA journal_mode=WAL")  # readers don't block the writer; safer on crash
        except sqlite3.DatabaseError:  # pragma: no cover - e.g. a filesystem without shared memory
            pass
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS records ("
            " kind TEXT NOT NULL, id TEXT NOT NULL, owner TEXT NOT NULL, data TEXT NOT NULL,"
            " updated_at TEXT NOT NULL, PRIMARY KEY (kind, id))"
        )
        if "rev" not in {r[1] for r in self.db.execute("PRAGMA table_info(records)")}:
            self.db.execute("ALTER TABLE records ADD COLUMN rev INTEGER NOT NULL DEFAULT 1")
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS audit ("
            " id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL,"
            " action TEXT NOT NULL, kind TEXT, record_id TEXT, detail TEXT, snapshot TEXT)"
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

    def _rev(self, kind: str, record_id: str) -> int:
        row = self.db.execute("SELECT rev FROM records WHERE kind = ? AND id = ?", (kind, record_id)).fetchone()
        return int(row[0]) if row else 0

    def _audit(self, actor: str, action: str, kind: str, record_id: str, detail: str = "", snapshot: Any = None) -> None:
        self.db.execute(
            "INSERT INTO audit (at, actor, action, kind, record_id, detail, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (datetime.now(timezone.utc).isoformat(), actor, action, kind, record_id, detail,
             json.dumps(snapshot) if snapshot is not None else None),
        )

    def _full(self, kind: str, record_id: str, owner: str, data: Dict[str, Any]) -> Dict[str, Any]:
        out = {**data, "id": record_id, "ownerEmail": owner, "rev": self._rev(kind, record_id)}
        if kind == "accounts":
            out["ytdSpend"] = ytd_spend(data)
        return out

    def list_visible(self, kind: str, email: str, is_manager: bool) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        """(full records the user may open and edit, limited views of the rest)."""
        self._check_kind(kind)
        full, limited = [], []
        with self.lock:
            rows = self.db.execute("SELECT id, owner, data, rev FROM records WHERE kind = ? ORDER BY id", (kind,)).fetchall()
        for record_id, owner, raw, rev in rows:
            if kind in PRIVATE_KINDS:
                if owner != email:
                    continue  # not even a limited view
                full.append({**json.loads(raw), "id": record_id, "ownerEmail": owner, "rev": rev})
                continue
            data = json.loads(raw)
            if is_manager or owner == email or is_open(kind, data):
                full.append({**data, "id": record_id, "ownerEmail": owner, "rev": rev,
                             **({"ytdSpend": ytd_spend(data)} if kind == "accounts" else {})})
            else:
                limited.append(limited_view(record_id, data))
        return full, limited

    def _save_locked(self, kind: str, record_id: str, data: Dict[str, Any], email: str, is_manager: bool) -> Dict[str, Any]:
        if not ID_RE.match(record_id or ""):
            raise ValueError("Invalid record id.")
        if not isinstance(data, dict):
            raise ValueError("Record must be a JSON object.")
        base_rev = data.get("baseRev")
        data = {k: v for k, v in data.items() if k not in SERVER_ONLY_KEYS}
        requested_owner = str(data.pop("ownerEmail", "") or "").strip().lower()
        if len(json.dumps(data)) > MAX_RECORD_BYTES:
            raise ValueError("Record is too large.")
        existing = self._row(kind, record_id)
        if existing:
            owner, before = existing
            if owner != email and not is_manager and not is_open(kind, before):
                raise PermissionError("Only the account's owner or a manager can change a customer account.")
            if isinstance(base_rev, int) and not isinstance(base_rev, bool) and base_rev != self._rev(kind, record_id):
                raise ConflictError("Someone else changed this record after you opened it.")
            if requested_owner and requested_owner != owner:
                # Managers assign to anyone; others may only claim an open record for themselves.
                if is_manager or (requested_owner == email and is_open(kind, before)):
                    self._audit(email, "owner_change", kind, record_id, f"{owner} -> {requested_owner}")
                    owner = requested_owner
        else:
            owner = requested_owner if (is_manager and requested_owner) else email
            self._audit(email, "create", kind, record_id, f"owner {owner}")
        self.db.execute(
            "INSERT INTO records (kind, id, owner, data, updated_at, rev) VALUES (?, ?, ?, ?, ?, 1)"
            " ON CONFLICT(kind, id) DO UPDATE SET owner = excluded.owner, data = excluded.data,"
            " updated_at = excluded.updated_at, rev = records.rev + 1",
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
                except (PermissionError, ValueError, ConflictError) as e:
                    errors.append({"id": rid, "error": str(e), "forbidden": isinstance(e, PermissionError),
                                   "conflict": isinstance(e, ConflictError)})
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
            # The audit row keeps a full copy, so an accidental delete can be restored.
            self._audit(email, "delete", kind, record_id, f"owner {existing[0]}", {"owner": existing[0], "data": existing[1]})
            self.db.execute("DELETE FROM records WHERE kind = ? AND id = ?", (kind, record_id))
            self.db.commit()
        return True

    def restore_deleted(self, kind: str, record_id: str, actor: str) -> Dict[str, Any]:
        """Puts back the most recently deleted copy of a record (managers only; see backend.py)."""
        self._check_kind(kind)
        with self.lock:
            row = self.db.execute(
                "SELECT snapshot FROM audit WHERE action = 'delete' AND kind = ? AND record_id = ? ORDER BY id DESC LIMIT 1",
                (kind, record_id),
            ).fetchone()
            if not row:
                raise LookupError("No deleted copy of that record was found.")
            if self._row(kind, record_id):
                raise ValueError("That record exists again; nothing to restore.")
            snap = json.loads(row[0])
            self.db.execute(
                "INSERT INTO records (kind, id, owner, data, updated_at, rev) VALUES (?, ?, ?, ?, ?, 1)",
                (kind, record_id, snap["owner"], json.dumps(snap["data"]), datetime.now(timezone.utc).isoformat()),
            )
            self._audit(actor, "restore", kind, record_id)
            self.db.commit()
            return self._full(kind, record_id, snap["owner"], snap["data"])

    # --- Backup and export -------------------------------------------------------

    def export_all(self) -> Dict[str, Any]:
        """Every record with its owner and revision (managers only; includes all customer detail)."""
        with self.lock:
            rows = self.db.execute("SELECT kind, id, owner, data, rev, updated_at FROM records ORDER BY kind, id").fetchall()
        return {
            "exportedAt": datetime.now(timezone.utc).isoformat(),
            "records": [{"kind": k, "id": i, "ownerEmail": o, "rev": r, "updatedAt": u, "data": json.loads(d)}
                        for k, i, o, d, r, u in rows],
        }

    def import_export(self, payload: Dict[str, Any], actor: str, overwrite: bool = False) -> Dict[str, int]:
        """Loads a file produced by export_all(). By default only records that don't exist
        yet are added, so restoring into a live database can't clobber newer work;
        overwrite=True replaces existing records with the file's versions."""
        records = payload.get("records") if isinstance(payload, dict) else None
        if not isinstance(records, list):
            raise ValueError("That isn't a Sales Hub export file.")
        added = replaced = skipped = 0
        with self.lock:
            for item in records:
                if not isinstance(item, dict) or item.get("kind") not in KINDS or not ID_RE.match(str(item.get("id", ""))) \
                        or not isinstance(item.get("data"), dict) or not str(item.get("ownerEmail", "")).strip():
                    skipped += 1
                    continue
                kind, rid = item["kind"], item["id"]
                exists = self._row(kind, rid) is not None
                if exists and not overwrite:
                    skipped += 1
                    continue
                self.db.execute(
                    "INSERT INTO records (kind, id, owner, data, updated_at, rev) VALUES (?, ?, ?, ?, ?, 1)"
                    " ON CONFLICT(kind, id) DO UPDATE SET owner = excluded.owner, data = excluded.data,"
                    " updated_at = excluded.updated_at, rev = records.rev + 1",
                    (kind, rid, str(item["ownerEmail"]).strip().lower(), json.dumps(item["data"]),
                     datetime.now(timezone.utc).isoformat()),
                )
                replaced += exists
                added += not exists
            self._audit(actor, "import_export", "", "", f"added {added}, replaced {replaced}, skipped {skipped}")
            self.db.commit()
        return {"added": added, "replaced": replaced, "skipped": skipped}

    def audit_log(self, limit: int = 200) -> List[Dict[str, Any]]:
        with self.lock:
            rows = self.db.execute(
                "SELECT at, actor, action, kind, record_id, detail FROM audit ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(zip(("at", "actor", "action", "kind", "recordId", "detail"), r)) for r in rows]

    def backup_to(self, directory: str, keep: int = 14) -> str:
        """Consistent online copy of the database (SQLite's backup API), pruning old copies."""
        os.makedirs(directory, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        target = os.path.join(directory, f"sales_hub-{stamp}.db")
        dest = sqlite3.connect(target)
        try:
            with self.lock:
                self.db.backup(dest)
        finally:
            dest.close()
        copies = sorted(f for f in os.listdir(directory) if f.startswith("sales_hub-") and f.endswith(".db"))
        for old in copies[:-keep]:
            os.remove(os.path.join(directory, old))
        return target


if __name__ == "__main__":
    import argparse
    import sys

    ap = argparse.ArgumentParser(description="Restore shared records from a /records/export file.")
    ap.add_argument("command", choices=["restore-export"])
    ap.add_argument("file")
    ap.add_argument("--db", default=os.path.join(os.environ.get("DATA_DIR", "."), "sales_hub.db"))
    ap.add_argument("--overwrite", action="store_true", help="replace records that already exist (default: only add missing ones)")
    args = ap.parse_args()
    with open(args.file) as fh:
        result = RecordStore(args.db).import_export(json.load(fh), "cli", overwrite=args.overwrite)
    print(result)
    sys.exit(0)
