"""Prospect personas and the agent styles that suit them.

The email/outreach agents should write for the person reading, so we infer how a
prospect likely communicates from three kinds of evidence, strongest first:

- email   what the prospect actually wrote to us (behaviour)
- note    what a rep observed in a call or meeting
- web     public research about the person/company (a weak, inferred hint)

Inference is rules-only: no model call, no spend, and every result lists the exact
quotes behind it. It is a hint about *communication preference*, not a verdict on the
person: when evidence is thin or split the answer is "unknown" and drafts stay neutral.
Prospect text is untrusted data, so documents with instruction-like text contribute nothing.
"""
import re
from datetime import date, datetime
from typing import Any, Dict, List, Optional

from .safety import clean_text, injection_flags

SOURCE_WEIGHT = {"email": 3.0, "note": 2.0, "web": 1.0}
MAX_HITS_PER_SIGNAL = 2          # one long rant or page can't outvote several independent signals
STALE_DAYS = 90                   # older signals count half: people and situations change
MIN_SCORE = 2.0                   # below this there isn't enough evidence to say anything
MIN_LEAD = 1.0                    # the leading persona must beat the runner-up by this much
ESTABLISHED_SCORE, ESTABLISHED_CONFIDENCE = 3.0, 0.6

# How a prospect likes to be written to, and the style of agent that serves them best.
PERSONAS: Dict[str, Dict[str, Any]] = {
    "impatient": {
        "label": "Impatient / Urgent",
        "summary": "Wants a fast, direct answer with minimal friction; values speed over small talk.",
        "style": "efficient",
        "max_words": 80,
        "directive": "Lead with the point in the first sentence. No pleasantries or preamble. One short ask. Keep it under 80 words.",
    },
    "methodical": {
        "label": "Methodical / Detailed",
        "summary": "Asks deep, technical or policy-driven questions; needs documentation, step-by-step logic and accurate facts.",
        "style": "analytical",
        "max_words": 125,
        "directive": "Be precise and structured. State exactly what the evidence says and what you do not know. Offer documentation or specifics as the next step. No vague claims.",
    },
    "frustrated": {
        "label": "Frustrated / Emotional",
        "summary": "Feels let down by a product or service; needs listening, empathy and de-escalation before any fix.",
        "style": "empathic",
        "max_words": 100,
        "directive": "Acknowledge the situation first and do not pitch. Calm, warm wording, no exclamation marks, no urgency. Make declining easy. Never say you know how they feel or label their emotions.",
    },
    "novice": {
        "label": "Novice / Confused",
        "summary": "Struggles with basic navigation or terminology; benefits from patient guidance and plain language.",
        "style": "proactive",
        "max_words": 110,
        "directive": "Use plain language, no jargon or acronyms. One idea only. Say what the first step is and offer to walk them through it.",
    },
}

AGENT_STYLES: Dict[str, Dict[str, str]] = {
    "empathic": {
        "label": "Empathic Problem-Solver",
        "goal": "Lead with emotional intelligence and calm language so a stressed or unhappy prospect feels heard before anything is proposed",
        "backstory": "You write calm, warm B2B emails that de-escalate before they propose. You never invent facts or label how someone feels.",
    },
    "analytical": {
        "label": "Analytical Specialist",
        "goal": "Give an exact, well-structured email that respects a detail-oriented reader and offers specifics on request",
        "backstory": "You understand the mechanics behind the subject and write precise, step-by-step B2B emails. You never invent facts.",
    },
    "efficient": {
        "label": "Efficient Concierge",
        "goal": "Deliver the point and one clear next step in as few words as courtesy allows",
        "backstory": "You write fast, direct, courteous B2B emails for busy people. You never invent facts.",
    },
    "proactive": {
        "label": "Proactive Advisor",
        "goal": "Anticipate the reader's next question and guide them in plain language so they feel fully supported",
        "backstory": "You write patient, plain-language B2B emails that anticipate follow-up questions. You never invent facts.",
    },
}

_P = lambda *alts: re.compile(r"\b(?:" + "|".join(alts) + r")", re.I)  # noqa: E731
CUES: Dict[str, re.Pattern] = {
    "impatient": _P(r"asap\b", r"urgent", r"right away", r"short on time", r"busy", r"bottom line", r"get to the point", r"cut to the chase",
                    r"just (tell|send|give) me", r"how (soon|quickly|fast)", r"deadline", r"quick (answer|question|call|reply)", r"in a hurry",
                    r"tl;?dr", r"keep it (short|brief)", r"no time"),
    "methodical": _P(r"documentation", r"specifications?\b", r"\bspecs?\b", r"compliance", r"soc ?2", r"security review", r"api docs?", r"step[- ]by[- ]step",
                     r"white ?paper", r"\bsla\b", r"data retention", r"audit", r"\brfp\b", r"procurement", r"in detail", r"exactly how", r"technical details?",
                     r"integration (details|requirements)", r"policy", r"due diligence", r"before we proceed", r"(please|can you) (provide|send|confirm)\b[^.?]{0,40}\b(details|documentation|in writing)"),
    "frustrated": _P(r"frustrat", r"disappoint", r"unacceptable", r"fed up", r"waste of (my )?time", r"terrible", r"awful", r"annoy", r"ridiculous",
                     r"still (not|haven.t|no)", r"never (heard|got|received)", r"no response", r"bad experience", r"poor support", r"let (us|me) down",
                     r"switch(ed|ing) away", r"not (working|happy)", r"again and again", r"third time"),
    "novice": _P(r"not sure what", r"confus", r"don.t understand", r"do not understand", r"what does .{1,40} mean", r"new to\b", r"first time", r"can you explain",
                 r"not (very )?technical", r"jargon", r"how do i", r"where do i", r"i.m lost", r"no (dedicated )?it (team|staff|person)", r"owner[- ]operator",
                 r"never (used|done)", r"explain (it )?(simply|like)"),
}


def _age_weight(observed_at: Optional[str], today: date) -> float:
    if not observed_at:
        return 1.0
    try:
        d = datetime.fromisoformat(str(observed_at)[:10]).date()
    except ValueError:
        return 1.0
    return 0.5 if (today - d).days > STALE_DAYS else 1.0


def _sentence_around(text: str, start: int, end: int) -> str:
    left = max(text.rfind(".", 0, start), text.rfind("\n", 0, start), text.rfind("?", 0, start), text.rfind("!", 0, start)) + 1
    right_candidates = [i for i in (text.find(c, end) for c in ".\n?!") if i != -1]
    right = min(right_candidates) + 1 if right_candidates else len(text)
    return text[left:right].strip()[:240]


def _behaviour_cues(source: str, text: str) -> Dict[str, str]:
    """Signals from how a reply is written, not just what it says. Only a prospect's own email counts."""
    out: Dict[str, str] = {}
    if source != "email":
        return out
    words = re.findall(r"\b\w[\w'’-]*\b", text)
    if 0 < len(words) <= 12 and ("?" in text or re.search(r"\b(price|pricing|cost|how much)\b", text, re.I)):
        out["impatient"] = text.strip()[:240]
    if len(words) >= 120 and text.count("?") >= 3:
        out["methodical"] = text.strip()[:240]
    return out


def infer_persona(signals: List[Dict[str, Any]], *, today: Optional[date] = None) -> Dict[str, Any]:
    """signals: [{source: web|email|note, text, observed_at?}]. Returns the likely persona, how sure we are, and why.

    status: 'established' (strong, repeated or behavioural evidence), 'likely' (some evidence), 'unknown' (not enough or split)."""
    today = today or date.today()
    scores = {p: 0.0 for p in PERSONAS}
    evidence: List[Dict[str, Any]] = []
    skipped: List[str] = []
    behavioural = {p: 0.0 for p in PERSONAS}    # email/note only: what the prospect or a rep actually saw
    for s in signals:
        source = s.get("source", "")
        if source not in SOURCE_WEIGHT:
            continue
        text = clean_text(s.get("text", ""))
        if not text:
            continue
        if injection_flags(text):
            skipped.append(f"A {source} signal contains instruction-like text and was ignored.")
            continue
        w = SOURCE_WEIGHT[source] * _age_weight(s.get("observed_at"), today)
        for persona, rx in CUES.items():
            # one point per distinct sentence, not per keyword: "urgent, asap" is one cue, not two
            quotes = list(dict.fromkeys(_sentence_around(text, m.start(), m.end()) for m in rx.finditer(text)))[:MAX_HITS_PER_SIGNAL]
            for q in quotes:
                scores[persona] += w
                if source != "web":
                    behavioural[persona] += w
                evidence.append({"persona": persona, "source": source, "excerpt": q, "weight": round(w, 2)})
        for persona, q in _behaviour_cues(source, text).items():
            scores[persona] += w
            behavioural[persona] += w
            evidence.append({"persona": persona, "source": source, "excerpt": q, "weight": round(w, 2), "kind": "reply style"})
    ranked = sorted(scores.items(), key=lambda kv: -kv[1])
    (top, top_score), (_, second_score) = ranked[0], ranked[1]
    total = sum(scores.values())
    result: Dict[str, Any] = {"persona": None, "agent_style": None, "status": "unknown", "confidence": 0.0,
                              "scores": {k: round(v, 2) for k, v in scores.items()}, "evidence": evidence[:12], "notes": skipped,
                              "reason": "Not enough evidence to infer how this prospect likes to be written to; drafts stay neutral."}
    # Someone who has told us (or a rep) they're unhappy is addressed with empathy first, even if other cues are louder.
    override = behavioural["frustrated"] >= MIN_SCORE
    if override:
        top, top_score = "frustrated", scores["frustrated"]
        second_score = 0.0
    if top_score < MIN_SCORE or top_score - second_score < MIN_LEAD:
        if top_score >= MIN_SCORE:
            result["reason"] = "Evidence points in more than one direction; drafts stay neutral."
        return result
    confidence = round(top_score / (total + 1.0), 2)
    established = top_score >= ESTABLISHED_SCORE and confidence >= ESTABLISHED_CONFIDENCE
    p = PERSONAS[top]
    sources = sorted({e["source"] for e in evidence if e["persona"] == top})
    result.update(persona=top, agent_style=p["style"], status="established" if established else "likely", confidence=confidence,
                  reason=f"{p['label']} ({'established' if established else 'likely'}) from {', '.join(sources)} evidence; "
                         f"write as the {AGENT_STYLES[p['style']]['label']}.")
    return result


def writing_directive(profile: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """What the drafting agent should do for this profile, or None when drafts should stay neutral."""
    if not profile or not profile.get("persona"):
        return None
    p, st = PERSONAS[profile["persona"]], AGENT_STYLES[profile["agent_style"]]
    return {"persona": profile["persona"], "persona_label": p["label"], "agent_style": profile["agent_style"], "style_label": st["label"],
            "max_words": p["max_words"], "directive": p["directive"], "goal": st["goal"], "backstory": st["backstory"],
            "status": profile["status"], "confidence": profile["confidence"]}
