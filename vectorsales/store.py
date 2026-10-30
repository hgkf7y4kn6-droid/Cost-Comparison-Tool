"""Tenant-scoped intelligence store with provenance.

Every table has a `tenant` column and every public method takes the tenant as its
first argument and puts it in the WHERE clause; there is no method that reads
across tenants. Field values keep their source, confidence, verification status and
timestamp so conflicts are resolved by rule (verified > higher confidence > newer)
and a missing value stays missing until something verifies it.
"""
import contextlib
import json
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from .normalize import account_id, company_key, domain_of, normalize_email, valid_email

FIELDS = ("name", "domain", "industry", "employees", "revenue", "country", "state", "city", "lat", "lng", "technologies", "linkedin_url")
OUTREACH_STATES = ("draft", "approved", "scheduled", "sent", "cancelled", "failed")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Store:
    def __init__(self, path: str = ":memory:"):
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None, timeout=30)
        self.lock = threading.RLock()
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS accounts (tenant TEXT, id TEXT, fields TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new',
              created TEXT, updated TEXT, PRIMARY KEY (tenant, id));
            CREATE TABLE IF NOT EXISTS contacts (tenant TEXT, id TEXT, account_id TEXT, fields TEXT NOT NULL, created TEXT, updated TEXT,
              PRIMARY KEY (tenant, id));
            CREATE INDEX IF NOT EXISTS contacts_acct ON contacts (tenant, account_id);
            CREATE TABLE IF NOT EXISTS triggers (tenant TEXT, id TEXT, account_id TEXT, data TEXT NOT NULL, detected_at TEXT, processed INTEGER DEFAULT 0,
              PRIMARY KEY (tenant, id));
            CREATE INDEX IF NOT EXISTS triggers_acct ON triggers (tenant, account_id);
            CREATE TABLE IF NOT EXISTS merges (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant TEXT, account_id TEXT, at TEXT, field TEXT, old TEXT, new TEXT, reason TEXT);
            CREATE TABLE IF NOT EXISTS suppression (tenant TEXT, kind TEXT, value TEXT, reason TEXT, at TEXT, PRIMARY KEY (tenant, kind, value));
            CREATE TABLE IF NOT EXISTS outreach (tenant TEXT, id TEXT, account_id TEXT, contact_id TEXT, step INTEGER, state TEXT, campaign TEXT,
              draft TEXT, created TEXT, updated TEXT, approved_by TEXT, send_after TEXT, UNIQUE (tenant, contact_id, step, campaign), PRIMARY KEY (tenant, id));
            CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant TEXT, at TEXT, actor TEXT, action TEXT, target TEXT, detail TEXT);
            CREATE TABLE IF NOT EXISTS ai_cache (tenant TEXT, key TEXT, value TEXT, created TEXT, ttl_days INTEGER, PRIMARY KEY (tenant, key));
            CREATE TABLE IF NOT EXISTS icp (tenant TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS settings (tenant TEXT, key TEXT, value TEXT NOT NULL, PRIMARY KEY (tenant, key));
            CREATE TABLE IF NOT EXISTS score_snapshots (tenant TEXT, id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT, at TEXT, priority INTEGER,
              fit INTEGER, intent INTEGER, contactability INTEGER, evidence INTEGER, weights TEXT, why TEXT);
            CREATE INDEX IF NOT EXISTS snap_acct ON score_snapshots (tenant, account_id, at);
            CREATE TABLE IF NOT EXISTS persona_signals (tenant TEXT, id TEXT, account_id TEXT, contact_id TEXT, source TEXT, text TEXT, observed_at TEXT,
              created TEXT, PRIMARY KEY (tenant, id));
            CREATE INDEX IF NOT EXISTS persona_acct ON persona_signals (tenant, account_id);
            CREATE TABLE IF NOT EXISTS outcomes (tenant TEXT, account_id TEXT, type TEXT, at TEXT, value_usd REAL, PRIMARY KEY (tenant, account_id, type));
        """)

    @contextlib.contextmanager
    def batch(self):
        """One transaction (one disk sync) for many writes. Re-entrant. Don't hold it across slow network calls."""
        with self.lock:
            if self.db.in_transaction:
                yield
                return
            self.db.execute("BEGIN IMMEDIATE")
            try:
                yield
            except BaseException:
                self.db.execute("ROLLBACK")
                raise
            self.db.execute("COMMIT")

    def audit(self, tenant: str, actor: str, action: str, target: str = "", detail: str = "") -> None:
        with self.lock:
            self.db.execute("INSERT INTO audit (tenant,at,actor,action,target,detail) VALUES (?,?,?,?,?,?)", (tenant, _now(), actor, action, target, detail[:500]))

    def audit_log(self, tenant: str, limit: int = 100) -> List[Dict]:
        with self.lock:
            rows = self.db.execute("SELECT at,actor,action,target,detail FROM audit WHERE tenant=? ORDER BY id DESC LIMIT ?", (tenant, limit)).fetchall()
        return [dict(zip(("at", "actor", "action", "target", "detail"), r)) for r in rows]

    # --- settings, score snapshots and real outcomes (for calibration) -----------------
    def get_setting(self, tenant: str, key: str) -> Optional[Any]:
        with self.lock:
            row = self.db.execute("SELECT value FROM settings WHERE tenant=? AND key=?", (tenant, key)).fetchone()
        return json.loads(row[0]) if row else None

    def set_setting(self, tenant: str, key: str, value: Any) -> None:
        with self.lock:
            self.db.execute("INSERT INTO settings VALUES (?,?,?) ON CONFLICT(tenant,key) DO UPDATE SET value=excluded.value", (tenant, key, json.dumps(value)))

    def snapshot_score(self, tenant: str, aid: str, scored: Dict[str, Any], *, min_gap_days: int = 7, now: Optional[datetime] = None) -> bool:
        """Freezes the score as it was when a decision was made, so it can later be compared with what happened.
        At most one snapshot per account per `min_gap_days` (repeat views don't create new "predictions")."""
        now = now or datetime.now(timezone.utc)
        p = scored["priority"]
        with self.lock:
            last = self.db.execute("SELECT at FROM score_snapshots WHERE tenant=? AND account_id=? ORDER BY at DESC LIMIT 1", (tenant, aid)).fetchone()
            if last and (now - datetime.fromisoformat(last[0])).days < min_gap_days:
                return False
            parts = p["parts"]
            self.db.execute("INSERT INTO score_snapshots (tenant,account_id,at,priority,fit,intent,contactability,evidence,weights,why) VALUES (?,?,?,?,?,?,?,?,?,?)",
                            (tenant, aid, now.isoformat(), p["priority"], parts["fit"], parts["intent"], parts["contactability"], parts["evidence"],
                             json.dumps(p["weights"]), json.dumps(p["explanation"])))
        return True

    def record_outcome(self, tenant: str, aid: str, type_: str, at: Optional[str] = None, value_usd: Optional[float] = None) -> bool:
        """Idempotent per (account, type): the first recorded time stands. Returns True if newly recorded."""
        with self.lock:
            n = self.db.execute("INSERT OR IGNORE INTO outcomes VALUES (?,?,?,?,?)", (tenant, aid, type_, at or _now(), value_usd)).rowcount
        return bool(n)

    def calibration_rows(self, tenant: str, outcome: str) -> List[Dict[str, Any]]:
        """One row per account: its FIRST snapshot (the prediction) and when (if ever) the outcome happened."""
        with self.lock:
            rows = self.db.execute(
                "SELECT s.account_id, s.at, s.priority, s.fit, s.intent, s.contactability, s.evidence, o.at FROM score_snapshots s "
                "LEFT JOIN outcomes o ON o.tenant=s.tenant AND o.account_id=s.account_id AND o.type=? "
                "WHERE s.tenant=? AND s.id=(SELECT MIN(id) FROM score_snapshots WHERE tenant=s.tenant AND account_id=s.account_id)", (outcome, tenant)).fetchall()
        keys = ("account_id", "snapshot_at", "priority", "fit", "intent", "contactability", "evidence", "outcome_at")
        return [dict(zip(keys, r)) for r in rows]

    # --- ICP --------------------------------------------------------------------
    def save_icp(self, tenant: str, data: Dict) -> None:
        with self.lock:
            self.db.execute("INSERT INTO icp VALUES (?,?) ON CONFLICT(tenant) DO UPDATE SET data=excluded.data", (tenant, json.dumps(data)))

    def load_icp(self, tenant: str) -> Optional[Dict]:
        with self.lock:
            row = self.db.execute("SELECT data FROM icp WHERE tenant=?", (tenant,)).fetchone()
        return json.loads(row[0]) if row else None

    # --- accounts -----------------------------------------------------------------
    @staticmethod
    def _better(new: Dict, old: Dict) -> bool:
        """Conflict rule: verified beats unverified, then higher confidence, then newer."""
        key = lambda f: (bool(f.get("verified")), float(f.get("confidence", 0)), f.get("at", ""))  # noqa: E731
        return key(new) > key(old)

    def upsert_account(self, tenant: str, record: Dict[str, Any], *, source: str, confidence: float = 0.5,
                       verified: bool = False, actor: str = "system") -> Dict[str, Any]:
        """Merges `record` into the account with the same identity. Empty values are ignored
        (a missing field stays missing); conflicting values are resolved by rule and logged.
        Returns {"id", "created", "changed": [fields]}."""
        domain = domain_of(record.get("domain") or record.get("website"))
        rec = {**record, "domain": domain}
        aid = account_id(domain, rec.get("name", ""), rec.get("state", ""))
        if not domain and not rec.get("name"):
            raise ValueError("An account needs a domain or a name.")
        at = _now()
        with self.lock:
            row = self.db.execute("SELECT fields FROM accounts WHERE tenant=? AND id=?", (tenant, aid)).fetchone()
            fields: Dict[str, Dict] = json.loads(row[0]) if row else {}
            changed = []
            for f in FIELDS:
                v = rec.get(f)
                if v in (None, "", [], {}):
                    continue
                cand = {"value": v, "source": source, "confidence": confidence, "verified": verified, "at": at}
                cur = fields.get(f)
                if cur is not None and f == "name" and company_key(cur["value"]) == company_key(v):
                    continue  # "Acme Inc" vs "ACME, LLC" is spelling, not a conflict
                if cur is None:
                    fields[f] = cand
                    changed.append(f)
                elif cur["value"] != v and self._better(cand, cur):
                    self.db.execute("INSERT INTO merges (tenant,account_id,at,field,old,new,reason) VALUES (?,?,?,?,?,?,?)",
                                    (tenant, aid, at, f, json.dumps(cur["value"]), json.dumps(v), f"{source} outranks {cur['source']}"))
                    fields[f] = cand
                    changed.append(f)
                elif cur["value"] == v and cand["verified"] and not cur.get("verified"):
                    fields[f] = {**cur, "verified": True, "at": at}
                    changed.append(f)
            if row is None:
                self.db.execute("INSERT INTO accounts VALUES (?,?,?,?,?,?)", (tenant, aid, json.dumps(fields), "new", at, at))
            elif changed:
                self.db.execute("UPDATE accounts SET fields=?, updated=? WHERE tenant=? AND id=?", (json.dumps(fields), at, tenant, aid))
        return {"id": aid, "created": row is None, "changed": changed}

    def get_account(self, tenant: str, aid: str) -> Optional[Dict]:
        with self.lock:
            row = self.db.execute("SELECT fields,status,created,updated FROM accounts WHERE tenant=? AND id=?", (tenant, aid)).fetchone()
        if not row:
            return None
        fields = json.loads(row[0])
        return {"id": aid, "status": row[1], "created": row[2], "updated": row[3], "fields": fields,
                "values": {k: v["value"] for k, v in fields.items()}}

    def list_accounts(self, tenant: str, limit: int = 100, after: str = "") -> List[Dict]:
        """Keyset pagination on id (stable under inserts)."""
        with self.lock:
            rows = self.db.execute("SELECT id FROM accounts WHERE tenant=? AND id>? ORDER BY id LIMIT ?", (tenant, after, min(max(limit, 1), 500))).fetchall()
        return [self.get_account(tenant, r[0]) for r in rows]

    def set_status(self, tenant: str, aid: str, status: str) -> None:
        with self.lock:
            self.db.execute("UPDATE accounts SET status=?, updated=? WHERE tenant=? AND id=?", (status, _now(), tenant, aid))

    def stale_fields(self, tenant: str, aid: str, max_age_days: Dict[str, int], now: Optional[datetime] = None) -> List[str]:
        acct = self.get_account(tenant, aid)
        now = now or datetime.now(timezone.utc)
        out = []
        for f, days in max_age_days.items():
            cur = (acct or {}).get("fields", {}).get(f)
            if cur and (now - datetime.fromisoformat(cur["at"])).days > days:
                out.append(f)
        return out

    # --- contacts -----------------------------------------------------------------
    def upsert_contact(self, tenant: str, aid: str, c: Dict[str, Any], *, source: str, verified_email: Optional[bool] = None) -> Dict:
        """verified_email: None = never checked, True = verified deliverable, False = invalid. A missing email stays missing."""
        email = normalize_email(c.get("email"))
        if email and not valid_email(email):
            email = ""
        name = (c.get("name") or "").strip()
        if not email and not name:
            raise ValueError("A contact needs a name or an email.")
        cid = "ct_" + __import__("hashlib").sha256(f"{aid}|{email or name.lower()}|{'' if email else (c.get('title') or '').lower()}".encode()).hexdigest()[:16]
        at = _now()
        with self.lock:
            row = self.db.execute("SELECT fields FROM contacts WHERE tenant=? AND id=?", (tenant, cid)).fetchone()
            fields = json.loads(row[0]) if row else {}
            for k, v in {"name": name, "title": c.get("title"), "email": email, "phone": c.get("phone"), "linkedin_url": c.get("linkedin_url")}.items():
                if v:
                    fields[k] = {"value": v, "source": source, "at": at}
            if verified_email is not None and email:
                fields["email_status"] = {"value": "valid" if verified_email else "invalid", "source": source, "at": at}
            if row is None:
                self.db.execute("INSERT INTO contacts VALUES (?,?,?,?,?,?)", (tenant, cid, aid, json.dumps(fields), at, at))
            else:
                self.db.execute("UPDATE contacts SET fields=?, updated=? WHERE tenant=? AND id=?", (json.dumps(fields), at, tenant, cid))
        return {"id": cid, "created": row is None}

    def contacts_for(self, tenant: str, aid: str) -> List[Dict]:
        with self.lock:
            rows = self.db.execute("SELECT id, fields FROM contacts WHERE tenant=? AND account_id=?", (tenant, aid)).fetchall()
        out = []
        for cid, raw in rows:
            f = json.loads(raw)
            out.append({"id": cid, "account_id": aid, "fields": f, "values": {k: v["value"] for k, v in f.items()}})
        return out

    def delete_account(self, tenant: str, aid: str, actor: str) -> bool:
        """Deletes an account with its contacts, triggers and drafts (privacy deletion). Audited."""
        with self.lock:
            n = self.db.execute("DELETE FROM accounts WHERE tenant=? AND id=?", (tenant, aid)).rowcount
            for t in ("contacts", "triggers", "outreach", "persona_signals"):
                self.db.execute(f"DELETE FROM {t} WHERE tenant=? AND account_id=?", (tenant, aid))
            self.db.execute("DELETE FROM merges WHERE tenant=? AND account_id=?", (tenant, aid))
        if n:
            self.audit(tenant, actor, "delete_account", aid)
        return bool(n)

    # --- triggers -----------------------------------------------------------------
    def add_trigger(self, tenant: str, aid: str, trig: Dict) -> Dict:
        """Idempotent on (account, kind, source, evidence)."""
        tid = "tr_" + __import__("hashlib").sha256(f"{aid}|{trig['kind']}|{trig['source']}|{trig['evidence']}".encode()).hexdigest()[:16]
        with self.lock:
            exists = self.db.execute("SELECT 1 FROM triggers WHERE tenant=? AND id=?", (tenant, tid)).fetchone()
            if not exists:
                self.db.execute("INSERT INTO triggers VALUES (?,?,?,?,?,0)", (tenant, tid, aid, json.dumps(trig), trig["detected_at"]))
        return {"id": tid, "created": not exists}

    def triggers_for(self, tenant: str, aid: str) -> List[Dict]:
        with self.lock:
            rows = self.db.execute("SELECT id, data, processed FROM triggers WHERE tenant=? AND account_id=? ORDER BY detected_at DESC", (tenant, aid)).fetchall()
        return [{**json.loads(d), "id": i, "processed": bool(p)} for i, d, p in rows]

    def mark_triggers_processed(self, tenant: str, aid: str) -> None:
        with self.lock:
            self.db.execute("UPDATE triggers SET processed=1 WHERE tenant=? AND account_id=?", (tenant, aid))

    # --- persona signals (web research, prospect emails, rep notes) ---------------------------
    def add_persona_signal(self, tenant: str, aid: str, source: str, text: str, contact_id: str = "", observed_at: Optional[str] = None) -> Dict:
        """Idempotent on (account, contact, source, text). contact_id '' = about the account/company in general."""
        if source not in ("web", "email", "note"):
            raise ValueError("source must be web, email or note.")
        text = (text or "").strip()[:6000]
        if not text:
            raise ValueError("A signal needs text.")
        sid = "ps_" + __import__("hashlib").sha256(f"{aid}|{contact_id}|{source}|{text}".encode()).hexdigest()[:16]
        with self.lock:
            exists = self.db.execute("SELECT 1 FROM persona_signals WHERE tenant=? AND id=?", (tenant, sid)).fetchone()
            if not exists:
                self.db.execute("INSERT INTO persona_signals VALUES (?,?,?,?,?,?,?,?)", (tenant, sid, aid, contact_id, source, text, observed_at, _now()))
        return {"id": sid, "created": not exists}

    def persona_signals_for(self, tenant: str, aid: str, contact_id: str = "") -> List[Dict]:
        """Signals about this contact plus account-level ones (contact_id ''), oldest first."""
        with self.lock:
            rows = self.db.execute("SELECT source, text, observed_at, created, contact_id FROM persona_signals WHERE tenant=? AND account_id=? "
                                   "AND (contact_id=? OR contact_id='') ORDER BY created", (tenant, aid, contact_id)).fetchall()
        return [{"source": r[0], "text": r[1], "observed_at": r[2] or r[3][:10], "contact_id": r[4]} for r in rows]

    # --- suppression ----------------------------------------------------------------
    def suppress(self, tenant: str, kind: str, value: str, reason: str, actor: str = "system") -> None:
        if kind not in ("email", "domain"):
            raise ValueError("Suppress an email or a domain.")
        value = normalize_email(value) if kind == "email" else domain_of(value)
        if not value:
            raise ValueError("Nothing to suppress.")
        with self.lock:
            self.db.execute("INSERT OR REPLACE INTO suppression VALUES (?,?,?,?,?)", (tenant, kind, value, reason, _now()))
        self.audit(tenant, actor, "suppress", f"{kind}:{value}", reason)

    def is_suppressed(self, tenant: str, email: str) -> Optional[str]:
        email = normalize_email(email)
        with self.lock:
            for kind, val in (("email", email), ("domain", domain_of(email))):
                row = self.db.execute("SELECT reason FROM suppression WHERE tenant=? AND kind=? AND value=?", (tenant, kind, val)).fetchone()
                if row:
                    return row[0] or kind
        return None

    # --- AI cache (tenant-isolated) ---------------------------------------------------
    def cache_get(self, tenant: str, key: str, now: Optional[datetime] = None) -> Optional[str]:
        with self.lock:
            row = self.db.execute("SELECT value, created, ttl_days FROM ai_cache WHERE tenant=? AND key=?", (tenant, key)).fetchone()
        if not row:
            return None
        if ((now or datetime.now(timezone.utc)) - datetime.fromisoformat(row[1])).days >= row[2]:
            return None
        return row[0]

    def cache_put(self, tenant: str, key: str, value: str, ttl_days: int) -> None:
        with self.lock:
            self.db.execute("INSERT OR REPLACE INTO ai_cache VALUES (?,?,?,?,?)", (tenant, key, value, _now(), ttl_days))

    # --- outreach ------------------------------------------------------------------------
    def create_outreach(self, tenant: str, aid: str, contact_id: str, step: int, campaign: str, draft: Dict, send_after: str = "") -> Dict:
        """One row per (contact, step, campaign): asking twice returns the existing row (no duplicate sends)."""
        oid = "out_" + uuid.uuid4().hex[:16]
        at = _now()
        with self.lock:
            try:
                self.db.execute("INSERT INTO outreach VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?)",
                                (tenant, oid, aid, contact_id, step, "draft", campaign, json.dumps(draft), at, at, send_after))
                return {"id": oid, "created": True}
            except sqlite3.IntegrityError:
                row = self.db.execute("SELECT id FROM outreach WHERE tenant=? AND contact_id=? AND step=? AND campaign=?", (tenant, contact_id, step, campaign)).fetchone()
                return {"id": row[0], "created": False}

    def get_outreach(self, tenant: str, oid: str) -> Optional[Dict]:
        with self.lock:
            r = self.db.execute("SELECT id,account_id,contact_id,step,state,campaign,draft,approved_by,send_after FROM outreach WHERE tenant=? AND id=?", (tenant, oid)).fetchone()
        return dict(zip(("id", "account_id", "contact_id", "step", "state", "campaign", "draft", "approved_by", "send_after"), r)) | {"draft": json.loads(r[6])} if r else None

    def transition_outreach(self, tenant: str, oid: str, allowed_from: tuple, to: str, actor: str, approved_by: Optional[str] = None) -> bool:
        """Atomic compare-and-set on state; False if it wasn't in an allowed state (so a double click can't double send)."""
        if to not in OUTREACH_STATES:
            raise ValueError("Unknown state.")
        marks = ",".join("?" * len(allowed_from))
        with self.lock:
            n = self.db.execute(f"UPDATE outreach SET state=?, updated=?, approved_by=COALESCE(?, approved_by) WHERE tenant=? AND id=? AND state IN ({marks})",
                                (to, _now(), approved_by, tenant, oid, *allowed_from)).rowcount
        if n:
            self.audit(tenant, actor, f"outreach_{to}", oid)
        return bool(n)

    def cancel_pending_for_contact(self, tenant: str, contact_id: str, reason: str, actor: str = "system") -> int:
        """Reply, meeting, opt-out, bounce…: stop everything not yet sent."""
        with self.lock:
            ids = [r[0] for r in self.db.execute("SELECT id FROM outreach WHERE tenant=? AND contact_id=? AND state IN ('draft','approved','scheduled')", (tenant, contact_id))]
            for i in ids:
                self.db.execute("UPDATE outreach SET state='cancelled', updated=? WHERE tenant=? AND id=?", (_now(), tenant, i))
        for i in ids:
            self.audit(tenant, actor, "outreach_cancelled", i, reason)
        return len(ids)

    def outreach_for_account(self, tenant: str, aid: str) -> List[Dict]:
        with self.lock:
            ids = [r[0] for r in self.db.execute("SELECT id FROM outreach WHERE tenant=? AND account_id=? ORDER BY step", (tenant, aid))]
        return [self.get_outreach(tenant, i) for i in ids]
