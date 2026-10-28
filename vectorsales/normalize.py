"""Normalisation and identity: one company = one normalised domain."""
import re
from typing import Optional
from urllib.parse import urlparse

_SUFFIX = re.compile(r"\b(inc|llc|l l c|corp|corporation|co|company|ltd|lp|llp|pc|plc|gmbh|the)\b")
_EMAIL = re.compile(r"^[A-Za-z0-9._%+\-]+@([A-Za-z0-9\-]+\.)+[A-Za-z]{2,}$")
FREE_MAIL = {"gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "aol.com", "icloud.com", "proton.me", "protonmail.com", "live.com", "msn.com"}


def domain_of(value: Optional[str]) -> str:
    """'https://www.Acme.com/about' or 'sales@acme.com' -> 'acme.com' ('' if none)."""
    v = (value or "").strip().lower()
    if not v:
        return ""
    if "@" in v and "/" not in v:
        v = v.rsplit("@", 1)[1]
    if "//" not in v:
        v = "//" + v
    host = (urlparse(v).hostname or "").strip(".")
    host = re.sub(r"^www\d?\.", "", host)
    return host if "." in host and re.fullmatch(r"[a-z0-9.\-]+", host) else ""


def company_key(name: Optional[str]) -> str:
    n = re.sub(r"[.,'\"&]", " ", (name or "").lower())
    return re.sub(r"\s+", " ", _SUFFIX.sub(" ", n)).strip()


def valid_email(email: Optional[str]) -> bool:
    return bool(email and _EMAIL.match(email.strip()) and len(email) <= 254)


def normalize_email(email: Optional[str]) -> str:
    return (email or "").strip().lower()


def account_id(domain: str, name: str, state: str = "") -> str:
    """Stable id: the domain when known, else normalised name (+state) — never random, so re-imports merge."""
    base = domain or f"name:{company_key(name)}|{(state or '').lower()}"
    import hashlib
    return "acc_" + hashlib.sha256(base.encode()).hexdigest()[:16]
