"""Cost ledger and budget enforcement.

Amounts are integer micro-dollars (1 USD = 1_000_000) so sums are exact. A
reservation books the *estimated* cost before work starts; settle() replaces it
with the actual cost (provider-reported when available, otherwise flagged as
estimated). Reservation, limit check and insert happen in one SQLite
`BEGIN IMMEDIATE` transaction, so concurrent requests can't both slip under a limit.
No prompts, contact details or credentials are stored — only counts and cost.
"""
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from typing import Dict, List, Optional

USD = 1_000_000

# (input, output) micro-dollars per 1M tokens. Operators override via set_price().
DEFAULT_PRICES: Dict[str, tuple] = {}


class BudgetExceeded(Exception):
    def __init__(self, scope: str, limit: int, would_be: int):
        super().__init__(f"{scope} budget of ${limit / USD:,.2f} would be exceeded (${would_be / USD:,.2f}).")
        self.scope, self.limit, self.would_be = scope, limit, would_be


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def period_start(period: str, now: Optional[datetime] = None) -> str:
    now = now or datetime.now(timezone.utc)
    if period == "day":
        return now.strftime("%Y-%m-%dT00:00:00")
    if period == "month":
        return now.strftime("%Y-%m-01T00:00:00")
    return "0000"


class Ledger:
    SCOPES = ("tenant", "workflow", "provider", "campaign", "operation")

    def __init__(self, path: str = ":memory:"):
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None, timeout=30)
        self.lock = threading.Lock()
        self.prices = dict(DEFAULT_PRICES)
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS usage (
              id TEXT PRIMARY KEY, tenant TEXT NOT NULL, ts TEXT NOT NULL, kind TEXT NOT NULL,
              provider TEXT, model TEXT, workflow TEXT, campaign TEXT, operation TEXT,
              units_in INTEGER DEFAULT 0, units_out INTEGER DEFAULT 0, cost_micro INTEGER NOT NULL,
              estimated INTEGER NOT NULL, state TEXT NOT NULL, cache_hit INTEGER DEFAULT 0, ok INTEGER DEFAULT 1,
              attempt INTEGER DEFAULT 1);
            CREATE INDEX IF NOT EXISTS usage_tenant_ts ON usage (tenant, ts);
            CREATE TABLE IF NOT EXISTS budgets (
              tenant TEXT NOT NULL, scope TEXT NOT NULL, scope_key TEXT NOT NULL, period TEXT NOT NULL,
              limit_micro INTEGER NOT NULL, warn_ratio REAL NOT NULL DEFAULT 0.8,
              PRIMARY KEY (tenant, scope, scope_key, period));
        """)

    # --- configuration ------------------------------------------------------
    def set_price(self, model: str, in_per_mtok_usd: float, out_per_mtok_usd: float) -> None:
        self.prices[model] = (round(in_per_mtok_usd * USD), round(out_per_mtok_usd * USD))

    def set_budget(self, tenant: str, scope: str, scope_key: str, period: str, limit_usd: float, warn_ratio: float = 0.8) -> None:
        if scope not in self.SCOPES or period not in ("day", "month", "total"):
            raise ValueError("Unknown budget scope or period.")
        if limit_usd < 0 or not 0 < warn_ratio <= 1:
            raise ValueError("Budget must be zero or more; warn ratio between 0 and 1.")
        with self.lock:
            self.db.execute(
                "INSERT INTO budgets VALUES (?,?,?,?,?,?) ON CONFLICT(tenant,scope,scope_key,period) DO UPDATE SET limit_micro=excluded.limit_micro, warn_ratio=excluded.warn_ratio",
                (tenant, scope, scope_key, period, round(limit_usd * USD), warn_ratio))

    def estimate_ai_cost(self, model: str, tokens_in: int, tokens_out: int) -> tuple:
        """(cost_micro, estimated?) — estimated unless prices for this model were configured."""
        price = self.prices.get(model)
        if not price:
            return 0, True
        return (tokens_in * price[0] + tokens_out * price[1]) // 1_000_000, False

    # --- spending -----------------------------------------------------------
    def _spent(self, tenant: str, scope: str, key: str, period: str) -> int:
        col = {"tenant": None, "workflow": "workflow", "provider": "provider", "campaign": "campaign", "operation": "operation"}[scope]
        sql = "SELECT COALESCE(SUM(cost_micro),0) FROM usage WHERE tenant=? AND ts>=? AND state IN ('reserved','final')"
        args: list = [tenant, period_start(period)]
        if col:
            sql += f" AND {col}=?"
            args.append(key)
        return self.db.execute(sql, args).fetchone()[0]

    def reserve(self, tenant: str, cost_micro: int, *, kind: str, provider: str = "", model: str = "", workflow: str = "",
                campaign: str = "", operation: str = "", estimated: bool = True) -> str:
        """Books `cost_micro` or raises BudgetExceeded. Returns a reservation id."""
        rid = uuid.uuid4().hex
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                keys = {"tenant": tenant, "workflow": workflow, "provider": provider, "campaign": campaign, "operation": operation}
                for scope, key, period, limit, _warn in self.db.execute(
                        "SELECT scope, scope_key, period, limit_micro, warn_ratio FROM budgets WHERE tenant=?", (tenant,)).fetchall():
                    if scope == "tenant" or keys.get(scope) == key:
                        spent = self._spent(tenant, scope, key if scope != "tenant" else "", period)
                        if spent + cost_micro > limit:
                            raise BudgetExceeded(f"{scope} {period}" + (f" ({key})" if scope != "tenant" else ""), limit, spent + cost_micro)
                self.db.execute(
                    "INSERT INTO usage (id,tenant,ts,kind,provider,model,workflow,campaign,operation,cost_micro,estimated,state) VALUES (?,?,?,?,?,?,?,?,?,?,?,'reserved')",
                    (rid, tenant, _now(), kind, provider, model, workflow, campaign, operation, cost_micro, int(estimated)))
                self.db.execute("COMMIT")
            except BaseException:
                self.db.execute("ROLLBACK")
                raise
        return rid

    def settle(self, rid: str, *, cost_micro: Optional[int] = None, estimated: Optional[bool] = None,
               units_in: int = 0, units_out: int = 0, ok: bool = True, cache_hit: bool = False, attempt: int = 1) -> None:
        with self.lock:
            row = self.db.execute("SELECT cost_micro, estimated FROM usage WHERE id=? AND state='reserved'", (rid,)).fetchone()
            if not row:
                return
            self.db.execute(
                "UPDATE usage SET cost_micro=?, estimated=?, units_in=?, units_out=?, ok=?, cache_hit=?, attempt=?, state='final' WHERE id=?",
                (row[0] if cost_micro is None else cost_micro, int(row[1] if estimated is None else estimated),
                 units_in, units_out, int(ok), int(cache_hit), attempt, rid))

    def release(self, rid: str) -> None:
        """Gives a reservation back (work never started)."""
        with self.lock:
            self.db.execute("DELETE FROM usage WHERE id=? AND state='reserved'", (rid,))

    def record_cache_hit(self, tenant: str, *, kind: str, workflow: str = "", operation: str = "") -> None:
        with self.lock:
            self.db.execute(
                "INSERT INTO usage (id,tenant,ts,kind,workflow,operation,cost_micro,estimated,state,cache_hit) VALUES (?,?,?,?,?,?,0,0,'final',1)",
                (uuid.uuid4().hex, tenant, _now(), kind, workflow, operation))

    # --- reporting ----------------------------------------------------------
    def status(self, tenant: str) -> List[Dict]:
        """Each budget with spend, and whether the warning threshold has been crossed."""
        out = []
        with self.lock:
            for scope, key, period, limit, warn in self.db.execute(
                    "SELECT scope, scope_key, period, limit_micro, warn_ratio FROM budgets WHERE tenant=?", (tenant,)).fetchall():
                spent = self._spent(tenant, scope, key if scope != "tenant" else "", period)
                out.append({"scope": scope, "key": key, "period": period, "limit_usd": limit / USD, "spent_usd": spent / USD,
                            "warning": limit > 0 and spent >= warn * limit, "exhausted": spent >= limit})
        return out

    def summary(self, tenant: str, since: Optional[str] = None) -> Dict:
        since = since or "0000"
        with self.lock:
            rows = self.db.execute(
                "SELECT kind, COALESCE(provider,''), COUNT(*), SUM(cost_micro), SUM(estimated), SUM(cache_hit), SUM(1-ok), SUM(units_in), SUM(units_out) "
                "FROM usage WHERE tenant=? AND ts>=? AND state='final' GROUP BY kind, provider", (tenant, since)).fetchall()
        lines = [{"kind": k, "provider": p, "calls": n, "cost_usd": (c or 0) / USD, "estimated_calls": e or 0,
                  "cache_hits": h or 0, "failures": f or 0, "units_in": ui or 0, "units_out": uo or 0}
                 for k, p, n, c, e, h, f, ui, uo in rows]
        return {"lines": lines, "total_usd": sum(l["cost_usd"] for l in lines)}

    def cost_by(self, tenant: str, column: str = "workflow", since: Optional[str] = None) -> Dict[str, int]:
        """Final cost (micro-USD) grouped by workflow, operation, campaign, provider or model."""
        if column not in ("workflow", "operation", "campaign", "provider", "model", "kind"):
            raise ValueError("Unknown grouping.")
        with self.lock:
            return dict(self.db.execute(
                f"SELECT COALESCE({column},''), SUM(cost_micro) FROM usage WHERE tenant=? AND ts>=? AND state='final' GROUP BY {column}",
                (tenant, since or "0000")).fetchall())
