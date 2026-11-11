"""Buyer persona: how a prospect likes to be talked to, inferred from evidence, and the outreach style that fits.

Evidence comes from three places, weighted by how directly it reflects the person:
    email  (weight 3)  what the prospect wrote back, or an email thread the rep logged
    note   (weight 2)  the rep's own notes from calls, visits and meetings, and CRM / note-taker imports
    web    (weight 1)  research about the person or company (site, reviews, news)
Signals older than 90 days count half. Inference is rules only: no model call, no cost, and every answer
comes with the exact quotes behind it.

Rules that keep it honest:
- Thin or conflicting evidence gives "unknown" and a neutral style.
- A web hint on its own is never "established".
- Frustration the person expressed in an email or note beats every other cue.
- Text that looks like instructions to an AI (from a prospect's reply, a web page or a pasted note) is ignored.
- Nothing here is stored: the app passes the signals in and gets the result back.

The draft written in a persona's style never mentions the inference, always keeps the opt-out line, and can only
be shorter than the neutral draft, never longer.
"""
import re
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Optional

SOURCE_WEIGHT = {"email": 3.0, "note": 2.0, "web": 1.0}
STALE_AFTER_DAYS = 90
MAX_SIGNALS = 40
MAX_SIGNAL_CHARS = 2000
MIN_SCORE = 2.0          # below this there isn't enough evidence
DOMINANCE = 1.5          # the leader must beat the runner-up by this factor
ESTABLISHED_SCORE = 4.0

CUES: Dict[str, "re.Pattern[str]"] = {
    "frustrated": re.compile(
        r"\b(frustrat\w*|fed up|unacceptable|ridiculous|third time|again and again|still waiting|"
        r"nobody (?:called|responded|replied|got back)|disappoint\w*|terrible|worst|angry|upset|"
        r"complain\w*|not happy|sick of|let (?:me|us) down|never (?:got|received|heard))\b", re.I),
    "impatient": re.compile(
        r"\b(asap|urgent\w*|quick(?:ly)?|right away|deadline|short on time|bottom line|"
        r"just (?:give|send|tell) me|how much|don'?t have time|in a hurry|need (?:it|this) (?:now|today)|"
        r"keep it (?:short|brief)|get to the point|by (?:eod|end of day|tomorrow|friday))\b", re.I),
    "methodical": re.compile(
        r"\b(specs?|specifications?|sku|skus|documentation|compliance|sds|data sheets?|certif\w*|"
        r"detailed?|details|compar\w+|in writing|break ?down|line[- ]item\w*|itemi[sz]ed|requirements|"
        r"approval process|procurement policy|rfp|bids?|cost per use|put it in a spreadsheet)\b", re.I),
    "novice": re.compile(
        r"\b(not sure|don'?t know|confus\w*|first time|never (?:done|bought|ordered|used)|new to|"
        r"what is|what does|explain|help me understand|beginner|no idea|walk me through|which one|"
        r"how does (?:it|this|that) work)\b", re.I),
}

# Text that tries to steer an AI rather than say something about the prospect.
INJECTION = re.compile(
    r"(ignore (?:all |any |the )?(?:previous|prior|above)|disregard (?:the |all |your )|system prompt|"
    r"you are (?:now )?(?:a|an|the) |act as |new instructions?|</?(?:system|assistant|user)>|"
    r"\bassistant\s*:|\[inst\]|do not mention|forget (?:everything|your))", re.I)

PERSONAS = {
    "impatient": "Impatient / urgent",
    "methodical": "Methodical / detail-oriented",
    "frustrated": "Frustrated / emotional",
    "novice": "Novice / unsure",
    "unknown": "Not enough evidence",
}

STYLES: Dict[str, Dict[str, Any]] = {
    "impatient": {"id": "concierge", "name": "Efficient Concierge", "max_words": 80,
                  "guidance": "Efficient Concierge: 80 words or fewer, lead with the point, make one ask, no filler."},
    "methodical": {"id": "specialist", "name": "Analytical Specialist", "max_words": 100,
                   "guidance": "Analytical Specialist: precise and specific; offer a written line-item comparison, "
                               "item numbers and spec sheets so they can verify each point."},
    "frustrated": {"id": "empathic", "name": "Empathic Problem-Solver", "max_words": 90,
                   "guidance": "Empathic Problem-Solver: acknowledge the frustration first, do not pitch, ask what "
                               "went wrong, and make opting out effortless."},
    "novice": {"id": "advisor", "name": "Proactive Advisor", "max_words": 100,
               "guidance": "Proactive Advisor: plain language, one idea, no jargon, offer a short walkthrough."},
    "unknown": {"id": "neutral", "name": "Neutral Professional", "max_words": 100,
                "guidance": "Neutral Professional: friendly, brief, one clear ask."},
}
OPT_OUT_LINE = 'If this isn\'t for you, just let me know, or reply "unsubscribe" and I won\'t contact you again.'


def _parse_date(value: Any) -> Optional[date]:
    try:
        return date.fromisoformat(str(value)[:10])
    except (TypeError, ValueError):
        return None


def _sentences(text: str) -> List[str]:
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+|\n+", text) if s.strip()]


def clean_signals(signals: Any) -> List[Dict[str, Any]]:
    """Keeps well-formed signals, drops instruction-like text, caps the number and length."""
    out: List[Dict[str, Any]] = []
    for s in signals if isinstance(signals, list) else []:
        if not isinstance(s, dict) or s.get("source") not in SOURCE_WEIGHT:
            continue
        text = re.sub(r"\s+", " ", str(s.get("text") or "")).strip()[:MAX_SIGNAL_CHARS]
        if not text or INJECTION.search(text):
            continue
        out.append({"source": s["source"], "text": text, "date": _parse_date(s.get("date"))})
        if len(out) >= MAX_SIGNALS:
            break
    return out


def infer(signals: Any, today: Optional[date] = None) -> Dict[str, Any]:
    today = today or datetime.now(timezone.utc).date()
    sigs = clean_signals(signals)
    scores = {k: 0.0 for k in CUES}
    evidence: List[Dict[str, Any]] = []
    direct_frustration = False
    non_web = {k: False for k in CUES}
    for s in sigs:
        factor = 0.5 if s["date"] and (today - s["date"]).days > STALE_AFTER_DAYS else 1.0
        weight = SOURCE_WEIGHT[s["source"]] * factor
        for persona, pattern in CUES.items():
            hits = [(sent, m.group(0).lower()) for sent in _sentences(s["text"]) for m in [pattern.search(sent)] if m]
            if not hits:
                continue
            scores[persona] += weight * min(len(hits), 2)
            if s["source"] != "web":
                non_web[persona] = True
                if persona == "frustrated":
                    direct_frustration = True
            sent, cue = hits[0]
            evidence.append({"persona": persona, "source": s["source"], "date": s["date"].isoformat() if s["date"] else "",
                             "quote": sent[:180], "cue": cue})
    ranked = sorted(scores.items(), key=lambda kv: -kv[1])
    (top, top_score), (_, second_score) = ranked[0], ranked[1]
    persona, reason = "unknown", "Not enough evidence yet."
    if direct_frustration:
        persona, reason = "frustrated", "Frustration was expressed directly, which comes before every other cue."
    elif top_score < MIN_SCORE:
        reason = "Not enough evidence yet." if top_score else "No clear signals."
    elif second_score and top_score < DOMINANCE * second_score:
        reason = "The evidence points in more than one direction."
    else:
        persona, reason = top, f"Strongest signals: {PERSONAS[top].lower()}."
    confidence = "unknown"
    if persona != "unknown":
        confidence = "established" if scores[persona] >= ESTABLISHED_SCORE and non_web[persona] else "tentative"
    shown = [e for e in evidence if e["persona"] == persona] if persona != "unknown" else evidence
    shown.sort(key=lambda e: (-SOURCE_WEIGHT[e["source"]], e["date"]))
    return {"persona": persona, "label": PERSONAS[persona], "confidence": confidence, "reason": reason,
            "scores": {k: round(v, 1) for k, v in scores.items()}, "evidence": shown[:6],
            "style": {k: STYLES[persona][k] for k in ("id", "name", "max_words", "guidance")},
            "signals_used": len(sigs)}


# --- Drafting ---------------------------------------------------------------------------------

def _clean(v: Any, limit: int = 120) -> str:
    return re.sub(r"[\r\n]+", " ", str(v or "")).strip()[:limit]


def count_words(text: str) -> int:
    return len(re.findall(r"\S+", text))


def draft_email(base: Dict[str, Any], persona: str, signature: str = "") -> Dict[str, str]:
    """A subject and body in the persona's style. `base` carries first, company, pitch and optional hook."""
    first, company = _clean(base.get("first"), 40) or "there", _clean(base.get("company"), 80) or "your team"
    pitch = _clean(base.get("pitch"), 80) or "supply"
    hook = _clean(base.get("hook"), 220)
    sig = _clean(signature, 200) or "[Your name] · Office Basics · [Business mailing address]"
    persona = persona if persona in STYLES else "unknown"

    if persona == "impatient":
        subject = f"{company}: {pitch} costs, 15 minutes?"
        body = [f"Hi {first},", f"Quick one: we can compare what {company} pays for {pitch} supplies with lower-cost "
                "options, free. Open to 15 minutes this week?"]
    elif persona == "methodical":
        subject = f"Line-item comparison for {company}'s {pitch} spend"
        body = [f"Hi {first},", (hook + " " if hook else "") + f"I'd like to prepare a written, line-item comparison of what "
                f"{company} buys in {pitch}, normalized to cost per use, with item numbers and spec sheets so your "
                "team can check every substitution.",
                "If you can share a recent invoice or item list, I'll send the comparison in writing. Would that be useful?"]
    elif persona == "frustrated":
        subject = f"Checking in, {company}"
        body = [f"Hi {first},", "I can tell this has been frustrating, and I'm sorry for the trouble. I'm not going to "
                "pitch you.", "If it helps, reply with a line about what went wrong and I'll see what I can do to put it right."]
    elif persona == "novice":
        subject = f"A simple way to check your {pitch} costs"
        body = [f"Hi {first},", f"Many teams aren't sure whether they're paying a fair price for {pitch} supplies. "
                f"I can look at what {company} buys today and explain, in plain terms, where it could cost less.",
                "Would a short walkthrough, about 15 minutes, be helpful?"]
    else:
        subject = f"{pitch[0].upper() + pitch[1:]} costs for {company}"
        body = [f"Hi {first},", (hook + " " if hook else "") + f"Office Basics helps local teams lower their {pitch} costs. "
                "We start with a free good/better/best cost comparison against what you buy today.",
                "Worth a quick look? I can send the comparison first, no call needed."]
    text = "\n\n".join(body + ["Best,\n" + sig, OPT_OUT_LINE])
    return {"subject": subject, "body": text}


def validate_draft(draft: Dict[str, str], persona: str) -> List[str]:
    """Problems with a draft; empty means it can be shown."""
    problems = []
    body = draft.get("body", "")
    if OPT_OUT_LINE not in body:
        problems.append("missing opt-out line")
    limit = STYLES.get(persona, STYLES["unknown"])["max_words"]
    if count_words(body) > limit:  # the whole body, signature and opt-out line included
        problems.append(f"over the {limit}-word style limit")
    if re.search(r"persona|impatient|methodical|frustrat\w* (?:prospect|buyer)|inferred|profile", body + draft.get("subject", ""), re.I):
        problems.append("mentions the inference")
    return problems


def draft(base: Dict[str, Any], signals: Any, signature: str = "", today: Optional[date] = None) -> Dict[str, Any]:
    result = infer(signals, today)
    persona = result["persona"]
    # Only act on a persona when the evidence is solid enough; a tentative one still shapes tone, never length upward.
    out = draft_email(base, persona, signature)
    if validate_draft(out, persona):
        persona = "unknown"
        out = draft_email(base, persona, signature)
    return {**out, "persona": persona, "style": STYLES[persona]["name"], "confidence": result["confidence"],
            "evidence": result["evidence"], "reason": result["reason"], "words": count_words(out["body"])}
