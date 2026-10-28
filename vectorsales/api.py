"""HTTP API for VectorSales (mounted by backend.py under /vs).

Every route requires a signed-in user (backend middleware). The tenant is derived
on the server from the signed-in email (VS_TENANTS="email:tenant,…"; unlisted users
share tenant "default"); nothing the client sends can choose or change it, and every
store/ledger call is scoped by it. Approvals and budget changes need the manager role
once any manager is configured. No endpoint sends mail by itself: sending needs an
approved message, a clean suppression check and a configured email integration.
"""
import os
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from . import geo, metrics, outreach, qualification
from .crews import Intelligence, ModelRouter, crewai_available
from .ledger import Ledger
from .models import ICP
from .pipeline import Pipeline
from .providers import Registry
from .store import Store

MAX_IMPORT = 500


class Services:
    """Holds the long-lived objects. Providers/senders are plugged in by the deployer (none are bundled)."""

    def __init__(self, data_dir: str, router: Optional[ModelRouter] = None):
        os.makedirs(data_dir, exist_ok=True)
        self.store = Store(os.path.join(data_dir, "vectorsales.db"))
        self.ledger = Ledger(os.path.join(data_dir, "vectorsales_ledger.db"))
        self.registry = Registry(self.ledger)
        self.router = router if router is not None else ModelRouter.from_env()
        self.ai = Intelligence(self.store, self.ledger, self.router)
        self.pipeline = Pipeline(self.store, self.ledger, self.registry)
        self.sender = None  # callable(tenant, draft, contact) -> provider message id; None = no email integration
        raw = os.environ.get("VS_TENANTS", "")
        self.tenants = {e.split(":", 1)[0].strip().lower(): e.split(":", 1)[1].strip() for e in raw.split(",") if ":" in e}


class ImportBody(BaseModel):
    accounts: List[Dict[str, Any]] = Field(max_length=MAX_IMPORT)
    source: str = Field(max_length=100)


class ContactBody(BaseModel):
    name: str = Field(default="", max_length=120)
    title: str = Field(default="", max_length=120)
    email: str = Field(default="", max_length=254)
    phone: str = Field(default="", max_length=40)


class TriggerBody(BaseModel):
    kind: str
    source: str = Field(max_length=300)
    evidence: str = Field(min_length=20, max_length=600)
    observed_at: Optional[str] = None
    confidence: float = Field(ge=0, le=1, default=0.5)
    relevance: float = Field(ge=0, le=1, default=0.5)
    verified: bool = False


class DocBody(BaseModel):
    source: str = Field(max_length=300)
    text: str = Field(max_length=20000)
    observed_at: Optional[str] = None
    authoritative: bool = False


class AssessBody(BaseModel):
    documents: List[DocBody] = Field(max_length=10)
    mode: str = Field(default="auto", pattern="^(auto|always|never)$")


class DraftBody(BaseModel):
    contact_id: str
    challenge: str = Field(min_length=3, max_length=120)
    resources: List[str] = Field(default=[], max_length=1)
    step: int = Field(default=1, ge=1, le=5)
    campaign: str = Field(default="default", max_length=60)
    sender: str = Field(default="", max_length=120)


class SuppressBody(BaseModel):
    kind: str = Field(pattern="^(email|domain)$")
    value: str = Field(max_length=254)
    reason: str = Field(default="opt-out", max_length=200)


class EventBody(BaseModel):
    type: str = Field(pattern="^(reply|meeting_booked|bounce|unsubscribe|invalid)$")


class BudgetBody(BaseModel):
    scope: str = "tenant"
    key: str = ""
    period: str = "month"
    limit_usd: float = Field(ge=0, le=1_000_000)
    warn_ratio: float = Field(default=0.8, gt=0, le=1)


class GeoBody(BaseModel):
    anchor: Dict[str, Any]
    radius_miles: float = Field(default=20, gt=0, le=100)
    max_stops: int = Field(default=4, ge=1, le=10)
    min_priority: int = Field(default=40, ge=0, le=100)


class QualBody(BaseModel):
    answers: Dict[str, Dict[str, Any]]


def build_router(auth_module_authenticator, svc: Services) -> APIRouter:
    r = APIRouter(prefix="/vs")
    S = svc

    def who(request: Request) -> tuple:
        email = request.state.user
        return S.tenants.get(email, "default"), email

    def need_manager(request: Request) -> None:
        a = auth_module_authenticator
        if a.managers and a.role(request.state.user) != "manager":
            raise HTTPException(403, "Only a manager can do this.")

    def icp_for(tenant: str) -> ICP:
        saved = S.store.load_icp(tenant)
        return ICP(**saved) if saved else ICP()

    def account_or_404(tenant: str, aid: str) -> Dict:
        a = S.store.get_account(tenant, aid)
        if not a:
            raise HTTPException(404, "No such account.")  # same answer whether it never existed or belongs to another tenant
        return a

    @r.get("/health")
    async def health(request: Request):
        return {"ai_enabled": S.router.enabled, "crewai_installed": crewai_available(), "providers": S.registry.health(),
                "email_integration": S.sender is not None}

    @r.get("/icp")
    async def get_icp(request: Request):
        return icp_for(who(request)[0]).model_dump()

    @r.put("/icp")
    async def put_icp(body: ICP, request: Request):
        tenant, email = who(request)
        S.store.save_icp(tenant, body.model_dump())
        S.store.audit(tenant, email, "icp_update")
        return body.model_dump()

    @r.post("/accounts/import")
    async def import_accounts(body: ImportBody, request: Request):
        tenant, email = who(request)
        res = await run_in_threadpool(S.pipeline.ingest, tenant, body.accounts, source=body.source, icp=icp_for(tenant), actor=email)
        return res

    @r.get("/queue")
    async def queue(request: Request, limit: int = 50):
        tenant, _ = who(request)
        icp = icp_for(tenant)
        out = []
        for a in S.store.list_accounts(tenant, limit=500):
            sc = await run_in_threadpool(S.pipeline.score, tenant, a["id"], icp)
            if sc["icp"]["status"] in ("excluded", "ineligible"):
                continue
            out.append({"id": a["id"], "name": a["values"].get("name"), "status": a["status"], "priority": sc["priority"]["priority"],
                        "fit": sc["icp"]["fit"], "intent": sc["intent"]["score"], "contactability": sc["contactability"]["score"],
                        "evidence": sc["evidence"]["score"], "explanation": sc["priority"]["explanation"], "icp_reasons": sc["icp"]["reasons"],
                        "provenance": {k: {"source": v["source"], "verified": v["verified"], "confidence": v["confidence"], "at": v["at"]} for k, v in a["fields"].items()}})
        out.sort(key=lambda x: -x["priority"])
        return {"accounts": out[:min(max(limit, 1), 200)]}

    @r.get("/accounts/{aid}")
    async def get_account(aid: str, request: Request):
        tenant, _ = who(request)
        a = account_or_404(tenant, aid)
        return {**a, "contacts": S.store.contacts_for(tenant, aid), "triggers": S.store.triggers_for(tenant, aid),
                "outreach": S.store.outreach_for_account(tenant, aid)}

    @r.delete("/accounts/{aid}")
    async def delete_account(aid: str, request: Request):
        tenant, email = who(request)
        need_manager(request)
        if not S.store.delete_account(tenant, aid, email):
            raise HTTPException(404, "No such account.")
        return {"deleted": aid}

    @r.post("/accounts/{aid}/contacts")
    async def add_contact(aid: str, body: ContactBody, request: Request):
        tenant, _ = who(request)
        account_or_404(tenant, aid)
        try:
            return S.store.upsert_contact(tenant, aid, body.model_dump(), source="manual")
        except ValueError as e:
            raise HTTPException(422, str(e))

    @r.post("/accounts/{aid}/triggers")
    async def add_trigger(aid: str, body: TriggerBody, request: Request):
        tenant, _ = who(request)
        account_or_404(tenant, aid)
        from datetime import date
        from .models import TRIGGER_TIER
        if body.kind not in TRIGGER_TIER:
            raise HTTPException(422, f"kind must be one of {sorted(TRIGGER_TIER)}")
        return S.store.add_trigger(tenant, aid, {**body.model_dump(), "detected_at": date.today().isoformat(), "method": "manual"})

    @r.post("/accounts/{aid}/triggers/assess")
    async def assess(aid: str, body: AssessBody, request: Request):
        tenant, _ = who(request)
        account_or_404(tenant, aid)
        return await run_in_threadpool(S.ai.assess_triggers, tenant, aid, [d.model_dump() for d in body.documents], mode=body.mode)

    @r.post("/accounts/{aid}/outreach/draft")
    async def draft(aid: str, body: DraftBody, request: Request):
        tenant, _ = who(request)
        account_or_404(tenant, aid)
        sc = await run_in_threadpool(S.pipeline.score, tenant, aid, icp_for(tenant))
        try:
            return await run_in_threadpool(S.ai.draft_outreach, tenant, aid, body.contact_id, step=body.step, campaign=body.campaign,
                                           challenge=body.challenge, resources=body.resources, sender=body.sender,
                                           priority=sc["priority"]["priority"])
        except LookupError as e:
            raise HTTPException(404, str(e))

    @r.post("/outreach/{oid}/approve")
    async def approve(oid: str, request: Request):
        tenant, email = who(request)
        need_manager(request)
        if not S.store.transition_outreach(tenant, oid, ("draft",), "approved", email, approved_by=email):
            raise HTTPException(409, "Only a draft can be approved.")
        return {"id": oid, "state": "approved"}

    @r.post("/outreach/{oid}/send")
    async def send(oid: str, request: Request):
        tenant, email = who(request)
        o = S.store.get_outreach(tenant, oid)
        if not o:
            raise HTTPException(404, "No such message.")
        acct = S.store.get_account(tenant, o["account_id"])
        contact = next((c for c in S.store.contacts_for(tenant, o["account_id"]) if c["id"] == o["contact_id"]), None)
        try:
            outreach.check_can_send(state=o["state"], store=S.store, tenant=tenant, email=(contact or {}).get("values", {}).get("email", ""),
                                    account_status=(acct or {}).get("status", ""), approved=bool(o["approved_by"]), sender_configured=S.sender is not None)
        except outreach.SendBlocked as e:
            raise HTTPException(409, str(e))
        # claim the message atomically first: a double click or retry can't send twice
        if not S.store.transition_outreach(tenant, oid, ("approved",), "scheduled", email):
            raise HTTPException(409, "This message is already being sent.")
        try:
            await run_in_threadpool(S.sender, tenant, o["draft"], contact)
        except Exception:
            S.store.transition_outreach(tenant, oid, ("scheduled",), "failed", email)
            raise HTTPException(502, "The email provider rejected or failed the send; nothing was sent.")
        S.store.transition_outreach(tenant, oid, ("scheduled",), "sent", email)
        return {"id": oid, "state": "sent"}

    @r.post("/suppression")
    async def suppress(body: SuppressBody, request: Request):
        tenant, email = who(request)
        try:
            S.store.suppress(tenant, body.kind, body.value, body.reason, email)
        except ValueError as e:
            raise HTTPException(422, str(e))
        return {"suppressed": True}

    @r.post("/contacts/{cid}/events")
    async def contact_event(cid: str, body: EventBody, request: Request):
        """Reply, booked meeting, bounce, unsubscribe: stop everything not yet sent and pause the account."""
        tenant, email = who(request)
        row = S.store.db.execute("SELECT account_id FROM contacts WHERE tenant=? AND id=?", (tenant, cid)).fetchone()
        if not row:
            raise HTTPException(404, "No such contact.")
        n = S.store.cancel_pending_for_contact(tenant, cid, body.type, email)
        status = {"reply": "replied", "meeting_booked": "meeting_booked"}.get(body.type)
        if status:
            S.store.set_status(tenant, row[0], status)
        if body.type in ("unsubscribe", "bounce", "invalid"):
            c = next(c for c in S.store.contacts_for(tenant, row[0]) if c["id"] == cid)
            if c["values"].get("email"):
                S.store.suppress(tenant, "email", c["values"]["email"], body.type, email)
        return {"cancelled": n}

    @r.put("/budgets")
    async def set_budget(body: BudgetBody, request: Request):
        tenant, email = who(request)
        need_manager(request)
        try:
            S.ledger.set_budget(tenant, body.scope, body.key, body.period, body.limit_usd, body.warn_ratio)
        except ValueError as e:
            raise HTTPException(422, str(e))
        S.store.audit(tenant, email, "budget_update", f"{body.scope}:{body.key}:{body.period}", str(body.limit_usd))
        return {"ok": True}

    @r.get("/usage")
    async def usage(request: Request):
        tenant, _ = who(request)
        summary = S.ledger.summary(tenant)
        counts = {"discovered": S.store.db.execute("SELECT COUNT(*) FROM accounts WHERE tenant=?", (tenant,)).fetchone()[0],
                  "verified_decision_makers": sum(1 for a in S.store.list_accounts(tenant, 500) for c in S.store.contacts_for(tenant, a["id"]) if c["values"].get("email_status") == "valid")}
        return {"budgets": S.ledger.status(tenant), "summary": summary, "cost_by_operation_usd": {k: v / 1_000_000 for k, v in S.ledger.cost_by(tenant, "operation").items()},
                "unit_costs": metrics.unit_costs(summary["total_usd"], counts),
                "note": "Metrics that need outcomes (qualified leads, meetings) stay unavailable until those events are recorded."}

    @r.post("/geo/clusters")
    async def clusters(body: GeoBody, request: Request):
        tenant, _ = who(request)
        icp = icp_for(tenant)
        pool = []
        for a in S.store.list_accounts(tenant, 500):
            v = a["values"]
            sc = await run_in_threadpool(S.pipeline.score, tenant, a["id"], icp)
            pool.append({"id": a["id"], "name": v.get("name"), "lat": v.get("lat"), "lng": v.get("lng"), "priority": sc["priority"]["priority"]})
        return geo.cluster_around(body.anchor, pool, radius_miles=body.radius_miles, max_stops=body.max_stops, min_priority=body.min_priority)

    @r.post("/qualification")
    async def qualify(body: QualBody, request: Request):
        return qualification.assess(body.answers)

    @r.get("/audit")
    async def audit(request: Request):
        tenant, _ = who(request)
        need_manager(request)
        return {"entries": S.store.audit_log(tenant)}

    return r
