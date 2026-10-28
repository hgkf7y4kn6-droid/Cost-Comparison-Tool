"""Money and cost-per-use arithmetic for the comparison engine.

Everything here uses `Decimal` so cents never pick up binary floating-point
noise, and every function refuses inputs it cannot support (missing, zero,
negative, NaN or infinite values) by returning None / raising ValueError
instead of inventing a number.

The browser has its own copy of the sell-price / margin rules in
frontend/calc.js; tests/test_pricing.py and tests/js/calc.test.js check both
against the same worked examples so they cannot drift apart.
"""
from decimal import ROUND_CEILING, ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any, Dict, Optional

CENT = Decimal("0.01")
MICRO = Decimal("0.000001")
HUNDRED = Decimal(100)
LIMIT = Decimal("1e12")  # larger values are data-entry or file errors, and keep arithmetic bounded


def to_decimal(value: Any) -> Optional[Decimal]:
    """A finite Decimal, or None for anything missing, non-numeric, NaN or infinite."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, float):
        value = repr(value)  # 0.1 -> Decimal("0.1"), not the binary expansion
    if isinstance(value, str):
        value = value.strip().replace(",", "").lstrip("$")
        if not value:
            return None
    try:
        d = Decimal(value)
    except (InvalidOperation, ValueError, TypeError):
        return None
    return d if d.is_finite() and abs(d) < LIMIT else None


def money(value: Decimal) -> Decimal:
    """Round to whole cents, halves away from zero (how invoices round)."""
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def cost_per_use(price: Any, uses_per_case: Any) -> Optional[Decimal]:
    """Price of one use. None unless both inputs are present, price >= 0 and uses > 0."""
    p, u = to_decimal(price), to_decimal(uses_per_case)
    if p is None or u is None or p < 0 or u <= 0:
        return None
    return (p / u).quantize(MICRO, rounding=ROUND_HALF_UP)


def savings(baseline: Any, option: Any) -> Optional[Dict[str, Decimal]]:
    """Savings of `option` versus `baseline` (both on the same basis, e.g. per use).

    pct is None when the baseline is zero. A negative amount means the option costs more.
    """
    b, o = to_decimal(baseline), to_decimal(option)
    if b is None or o is None or b < 0 or o < 0:
        return None
    amount = b - o
    pct = (amount / b * HUNDRED).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP) if b > 0 else None
    return {"amount": amount, "pct": pct}


def price_for_margin(cost: Any, margin_pct: Any) -> Decimal:
    """Sell price = cost / (1 - margin), rounded UP to the cent so the price never
    lands below the requested margin. $60 at 25% -> $80.00 (a 25% *markup* would be $75).

    Raises ValueError for a missing/negative cost or a margin outside 0 <= m < 100.
    """
    c, m = to_decimal(cost), to_decimal(margin_pct)
    if c is None or c < 0:
        raise ValueError("Cost must be zero or more.")
    if m is None or m < 0 or m >= 100:
        raise ValueError("Margin must be at least 0% and below 100%.")
    return (c / (1 - m / HUNDRED)).quantize(CENT, rounding=ROUND_CEILING)


def margin_pct(cost: Any, sell: Any) -> Optional[Decimal]:
    """(sell - cost) / sell as a percentage; None when the sell price is not positive."""
    c, s = to_decimal(cost), to_decimal(sell)
    if c is None or s is None or s <= 0:
        return None
    return (s - c) / s * HUNDRED


def markup_pct(cost: Any, sell: Any) -> Optional[Decimal]:
    """(sell - cost) / cost as a percentage; None when the cost is not positive."""
    c, s = to_decimal(cost), to_decimal(sell)
    if c is None or s is None or c <= 0:
        return None
    return (s - c) / c * HUNDRED
