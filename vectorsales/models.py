"""Plain data shapes shared across the package."""
from typing import Dict, List, Literal, Optional

from pydantic import BaseModel, Field

TriggerKind = Literal[
    "exec_appointment", "funding", "acquisition", "expansion", "tech_migration", "initiative",
    "hiring", "engagement", "growth", "other",
]
# Tier 1 = high-priority signals, tier 2 = emerging signals (configurable weights in scoring.py)
TRIGGER_TIER: Dict[str, int] = {
    "exec_appointment": 1, "funding": 1, "acquisition": 1, "expansion": 1, "tech_migration": 1, "initiative": 1,
    "hiring": 2, "engagement": 2, "growth": 2, "other": 2,
}


class ICP(BaseModel):
    """Hard requirements (must pass) and weighted preferences (score)."""
    industries: List[str] = []
    employee_min: Optional[int] = None
    employee_max: Optional[int] = None
    revenue_min: Optional[float] = None
    revenue_max: Optional[float] = None
    countries: List[str] = []
    states: List[str] = []
    technologies: List[str] = []
    target_titles: List[str] = []
    exclude_industries: List[str] = []
    exclude_domains: List[str] = []
    # which criteria are mandatory; the rest only add to the fit score
    hard: List[Literal["industry", "employees", "revenue", "geography", "excluded"]] = ["employees", "excluded"]


class Trigger(BaseModel):
    kind: TriggerKind = "other"
    source: str                      # URL or provider name
    evidence: str                    # excerpt that supports it
    observed_at: Optional[str] = None  # when the event happened/was published (ISO date)
    detected_at: str                 # when we saw it (ISO date)
    confidence: float = Field(ge=0, le=1, default=0.5)
    verified: bool = False           # True only for events confirmed by a source, not inferred
    relevance: float = Field(ge=0, le=1, default=0.5)
    processed: bool = False


class EmailDraft(BaseModel):
    subject: str
    body: str
    resource_url: Optional[str] = None
    evidence_refs: List[str] = []    # triggers (by evidence excerpt) the draft relies on
    # set by the engine after drafting (never by the model): which inferred persona/agent style shaped the tone
    persona: Optional[str] = None
    agent_style: Optional[str] = None
