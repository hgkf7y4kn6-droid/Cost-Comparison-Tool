"""Rules for education-first outreach. Drafting is not sending: nothing here contacts anyone."""
import re
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional

from .models import EmailDraft

MAX_WORDS = 125
MAX_PARAGRAPHS = 3
MAX_LINKS = 1
URL_RE = re.compile(r"https?://[^\s)>\"']+", re.I)
SUBJECT_RE = re.compile(r"^An idea for .+ re: .+$")
# claims we can't back unless the caller supplies evidence for them
UNSUPPORTED = re.compile(r"\b(\d+(\.\d+)?\s?%|\d+x\b|guarantee[sd]?|case study|benchmark|industry[- ]leading|proven)", re.I)

DEFAULT_CADENCE = [  # (day offset, step name, channel)
    (0, "insight", "email"), (2, "counterpoint", "email"), (4, "direct_or_meeting", "email"),
    (7, "micro_case_study", "email"), (11, "resource_or_close", "email"),
]


def subject_for(company: str, challenge: str) -> str:
    return f"An idea for {company} re: {challenge}"[:150]


def validate_draft(d: EmailDraft, *, evidence: List[str], allowed_resources: Optional[List[str]] = None,
                   company: str = "") -> List[str]:
    """Returns the list of problems (empty = acceptable)."""
    problems: List[str] = []
    body = d.body.strip()
    words = len(re.findall(r"\b\w[\w'’-]*\b", body))
    if words > MAX_WORDS:
        problems.append(f"{words} words (max {MAX_WORDS})")
    paras = [p for p in re.split(r"\n\s*\n", body) if p.strip()]
    if len(paras) > MAX_PARAGRAPHS:
        problems.append(f"{len(paras)} paragraphs (max {MAX_PARAGRAPHS})")
    links = set(URL_RE.findall(body))
    if d.resource_url:
        links.add(d.resource_url)
    if len(links) > MAX_LINKS:
        problems.append(f"{len(links)} links (max {MAX_LINKS})")
    if allowed_resources is not None:
        for l in links:
            if l not in allowed_resources:
                problems.append(f"link not on the approved resource list: {l}")
    if not SUBJECT_RE.match(d.subject):
        problems.append("subject must follow 'An idea for [Company] re: [Challenge]'")
    if company and company.lower() not in d.subject.lower():
        problems.append("subject doesn't name the company")
    if not evidence:
        problems.append("no evidence supplied for personalization")
    else:
        refs = [r for r in d.evidence_refs if r in evidence]
        if not refs:
            problems.append("draft doesn't cite any known evidence")
    ev_text = " ".join(evidence).lower()
    for m in UNSUPPORTED.finditer(body):
        if m.group(0).lower() not in ev_text:
            problems.append(f"unsupported claim: '{m.group(0)}'")
    if "unsubscribe" not in body.lower() and "opt out" not in body.lower() and "not relevant" not in body.lower():
        problems.append("no opt-out line")
    return problems


def fallback_draft(company: str, contact_first: str, challenge: str, evidence_excerpt: str, resource_url: Optional[str] = None,
                   sender: str = "") -> EmailDraft:
    """Used when no model is configured/allowed or the model's draft fails validation. Quotes the evidence verbatim, invents nothing."""
    excerpt = evidence_excerpt.strip().rstrip(".")[:160]
    p1 = f"Hi {contact_first or 'there'}, I noticed this about {company}: \"{excerpt}\"."
    p2 = f"Teams in that position often find {challenge} becomes harder to manage at the same time." + (f" This may help: {resource_url}" if resource_url else "")
    p3 = "Worth a short conversation? If this isn't relevant, tell me and I won't follow up (reply \"opt out\" any time)." + (f"\n{sender}" if sender else "")
    return EmailDraft(subject=subject_for(company, challenge), body="\n\n".join([p1, p2, p3]), resource_url=resource_url, evidence_refs=[evidence_excerpt])


def plan_cadence(start: date, steps: Optional[list] = None, *, business_days_only: bool = True, holidays: Optional[List[date]] = None) -> List[Dict[str, Any]]:
    """Dates for each step; weekends/holidays roll forward to the next business day."""
    holidays = set(holidays or [])
    out = []
    for offset, name, channel in (steps or DEFAULT_CADENCE):
        d = start + timedelta(days=offset)
        while business_days_only and (d.weekday() >= 5 or d in holidays):
            d += timedelta(days=1)
        out.append({"step": len(out) + 1, "name": name, "channel": channel, "date": d.isoformat()})
    return out


def within_send_window(now: datetime, start_hour: int = 8, end_hour: int = 17) -> bool:
    return now.weekday() < 5 and start_hour <= now.hour < end_hour


class SendBlocked(Exception):
    pass


def check_can_send(*, state: str, store, tenant: str, email: str, account_status: str, approved: bool, sender_configured: bool) -> None:
    """Every reason a message must NOT go out; raises SendBlocked with the first one."""
    if not sender_configured:
        raise SendBlocked("No email integration is configured, so nothing can be sent.")
    if state != "approved" or not approved:
        raise SendBlocked("This message hasn't been approved.")
    reason = store.is_suppressed(tenant, email)
    if reason:
        raise SendBlocked(f"Recipient is suppressed ({reason}).")
    if account_status in ("disqualified", "customer", "meeting_booked", "replied"):
        raise SendBlocked(f"Account status '{account_status}' pauses outreach.")
