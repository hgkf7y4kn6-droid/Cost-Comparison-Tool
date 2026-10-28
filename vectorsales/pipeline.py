"""Progressive enrichment: cheap discovery, deterministic filters, then spend only where it pays.

Stages: discover -> ICP filter -> dedupe/merge -> reuse stored data -> enrich company (only if
needed and promising) -> find contacts (only if fit clears the bar) -> verify emails ->
escalate to a premium source (only high-priority accounts still without a verified
decision-maker) -> review queue. Each stage reports its calls, incremental cost and yield."""
from typing import Any, Dict, List, Optional

from .icp import match_icp
from .ledger import BudgetExceeded, Ledger
from .models import ICP
from .normalize import FREE_MAIL, domain_of
from .providers import AllProvidersFailed, NoProvider, Registry
from .scoring import contact_score, evidence_score, intent_score, priority
from .store import Store

STAGES = ("discovered", "filtered_out", "merged", "enriched", "contacts_found", "emails_verified", "escalated", "review", "budget_stopped")


class Pipeline:
    def __init__(self, store: Store, ledger: Ledger, registry: Optional[Registry] = None):
        self.store, self.ledger, self.registry = store, ledger, registry

    def _call(self, tenant, capability, payload, workflow, stage, tier=None):
        if not self.registry:
            raise NoProvider("No providers configured.")
        return self.registry.call(capability, payload, tenant=tenant, workflow=workflow, operation=stage, tier=tier)

    def ingest(self, tenant: str, candidates: List[Dict[str, Any]], *, source: str, icp: ICP, workflow: str = "prospecting",
               enrich_min_fit: int = 50, contact_min_fit: int = 60, escalate_min_priority: int = 70, actor: str = "system",
               confidence: float = 0.5) -> Dict[str, Any]:
        # With no paid providers nothing slow happens inside the loop, so commit in chunks (far fewer disk syncs).
        if self.registry is None and len(candidates) > 1:
            merged: Dict[str, Any] = {"ids": [], "stats": {s: 0 for s in STAGES}, "stopped": None}
            for i in range(0, len(candidates), 250):
                with self.store.batch():
                    part = self._ingest(tenant, candidates[i:i + 250], source, icp, workflow, enrich_min_fit, contact_min_fit, escalate_min_priority, actor, confidence)
                merged["ids"] += part["ids"]
                for k, v in part["stats"].items():
                    merged["stats"][k] += v
            merged["stage_costs_usd"] = self.stage_costs(tenant)
            return merged
        return self._ingest(tenant, candidates, source, icp, workflow, enrich_min_fit, contact_min_fit, escalate_min_priority, actor, confidence)

    def _ingest(self, tenant, candidates, source, icp, workflow, enrich_min_fit, contact_min_fit, escalate_min_priority, actor, confidence):
        stats = {s: 0 for s in STAGES}
        ids: List[str] = []
        for cand in candidates:
            if not (cand.get("name") or cand.get("domain") or cand.get("website")):
                continue
            stats["discovered"] += 1
            # Excluded accounts are dropped before they cost anything or enter the store.
            pre = match_icp(icp, {**cand, "domain": domain_of(cand.get("domain") or cand.get("website"))})
            if pre["status"] in ("excluded", "ineligible"):
                stats["filtered_out"] += 1
                continue
            res = self.store.upsert_account(tenant, cand, source=source, confidence=confidence, actor=actor)
            if not res["created"]:
                stats["merged"] += 1
            aid = res["id"]
            ids.append(aid)
            acct = self.store.get_account(tenant, aid)
            m = match_icp(icp, acct["values"])
            try:
                # Fill gaps in hard-criteria data only for promising accounts, and only once.
                if m["status"] == "needs_data" and m["fit"] >= enrich_min_fit and self.registry:
                    _, data = self._call(tenant, "company_enrichment", {"domain": acct["values"].get("domain"), "name": acct["values"].get("name")}, workflow, "enrich_company")
                    self.store.upsert_account(tenant, data.get("account", {}) | {"name": acct["values"].get("name"), "domain": acct["values"].get("domain")},
                                              source=data.get("source", "enrichment"), confidence=float(data.get("confidence", 0.7)), verified=bool(data.get("verified")))
                    stats["enriched"] += 1
                    acct = self.store.get_account(tenant, aid)
                    m = match_icp(icp, acct["values"])
                if not m["eligible"]:
                    self.store.set_status(tenant, aid, "filtered" if m["status"] in ("ineligible", "excluded") else "needs_data")
                    if m["status"] in ("ineligible", "excluded"):
                        stats["filtered_out"] += 1
                    continue
                self.store.set_status(tenant, aid, "eligible")
                if m["fit"] < contact_min_fit:
                    continue
                if not any(c["values"].get("email") for c in self.store.contacts_for(tenant, aid)) and self.registry:
                    _, data = self._call(tenant, "contact_enrichment", {"domain": acct["values"]["domain"], "titles": icp.target_titles}, workflow, "find_contacts", tier=1)
                    n = 0
                    for c in data.get("contacts", []):
                        try:
                            self.store.upsert_contact(tenant, aid, c, source=data.get("source", "contact_enrichment"))
                            n += 1
                        except ValueError:
                            pass
                    stats["contacts_found"] += bool(n)
                for c in self.store.contacts_for(tenant, aid):
                    v = c["values"]
                    if v.get("email") and "email_status" not in v and self.registry and domain_of(v["email"]) not in FREE_MAIL:
                        _, ver = self._call(tenant, "email_verification", {"email": v["email"]}, workflow, "verify_email")
                        self.store.upsert_contact(tenant, aid, {"name": v.get("name"), "email": v["email"], "title": v.get("title")},
                                                  source=ver.get("source", "email_verification"), verified_email=bool(ver.get("valid")))
                        stats["emails_verified"] += 1
                scored = self.score(tenant, aid, icp)
                has_verified = any(c["values"].get("email_status") == "valid" for c in self.store.contacts_for(tenant, aid))
                if scored["priority"]["priority"] >= escalate_min_priority and not has_verified and self.registry:
                    try:
                        _, data = self._call(tenant, "contact_enrichment", {"domain": acct["values"]["domain"], "titles": icp.target_titles}, workflow, "escalate_contacts", tier=2)
                        for c in data.get("contacts", []):
                            try:
                                self.store.upsert_contact(tenant, aid, c, source=data.get("source", "premium"), verified_email=bool(c.get("email_verified")) if "email_verified" in c else None)
                            except ValueError:
                                pass
                        stats["escalated"] += 1
                    except NoProvider:
                        pass
                if not any(c["values"].get("email_status") == "valid" for c in self.store.contacts_for(tenant, aid)):
                    self.store.set_status(tenant, aid, "review")
                    stats["review"] += 1
            except BudgetExceeded as e:
                # Hard limit: stop spending, keep what we have, tell the caller.
                stats["budget_stopped"] += 1
                self.store.audit(tenant, actor, "budget_stop", workflow, str(e))
                return {"ids": ids, "stats": stats, "stopped": str(e), "stage_costs_usd": self.stage_costs(tenant)}
            except (AllProvidersFailed, NoProvider):
                self.store.set_status(tenant, aid, "review")
                stats["review"] += 1
        return {"ids": ids, "stats": stats, "stopped": None, "stage_costs_usd": self.stage_costs(tenant)}

    def stage_costs(self, tenant: str) -> Dict[str, float]:
        return {k: v / 1_000_000 for k, v in self.ledger.cost_by(tenant, "operation").items() if k}

    def score(self, tenant: str, aid: str, icp: ICP, weights: Optional[Dict[str, float]] = None) -> Dict[str, Any]:
        acct = self.store.get_account(tenant, aid)
        m = match_icp(icp, acct["values"])
        trig = self.store.triggers_for(tenant, aid)
        contacts = self.store.contacts_for(tenant, aid)
        intent = intent_score(trig)
        con = contact_score(contacts, icp.target_titles, lambda e: self.store.is_suppressed(tenant, e))
        ev = evidence_score(trig)
        return {"account_id": aid, "icp": m, "intent": intent, "contactability": con, "evidence": ev,
                "priority": priority(m["fit"], intent, con, ev, weights)}
