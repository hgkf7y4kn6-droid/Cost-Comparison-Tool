"""Treat everything fetched from the outside as data, never as instructions.

Websites, news, emails and CRM notes can contain text aimed at the model
("ignore previous instructions…"). We (1) strip control characters and cap length,
(2) flag instruction-like phrases so a human can look, (3) wrap content in
delimiters the prompts name as untrusted, and (4) give the agents no tools, so
even a successful injection has nothing privileged to call. Model output is then
checked against the original text (crews.verify_*), which catches invented evidence.
"""
import re
from typing import List, Tuple

MAX_DOC_CHARS = 6000
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
INJECTION_PATTERNS = [
    r"ignore (all |any |the )?(previous|prior|above) (instructions|prompts?)",
    r"disregard (all |any |the )?(previous|prior|above)",
    r"you are now\b", r"new instructions?:", r"system prompt", r"reveal (your|the) (prompt|instructions|keys?|secrets?)",
    r"(send|forward|email) (this|the|all) .{0,40}(to|@)", r"api[_ -]?key", r"</?(system|assistant|tool)>",
    r"act as\b", r"jailbreak", r"do anything now",
]
_INJECTION = re.compile("|".join(INJECTION_PATTERNS), re.I)


def clean_text(text: str, limit: int = MAX_DOC_CHARS) -> str:
    text = _CONTROL.sub(" ", str(text or ""))
    return re.sub(r"[ \t]+", " ", text).strip()[:limit]


def injection_flags(text: str) -> List[str]:
    return sorted({m.group(0).lower() for m in _INJECTION.finditer(text or "")})


def wrap_untrusted(source: str, text: str) -> Tuple[str, List[str]]:
    """Returns (delimited text for a prompt, injection flags found)."""
    body = clean_text(text)
    body = body.replace("<untrusted_source", "&lt;untrusted_source").replace("</untrusted_source", "&lt;/untrusted_source")
    label = clean_text(source, 200).replace('"', "'")
    return f'<untrusted_source name="{label}">\n{body}\n</untrusted_source>', injection_flags(body)
