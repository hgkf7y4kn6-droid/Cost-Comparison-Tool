from decimal import Decimal

import pytest

import pricing


def test_sell_price_uses_margin_not_markup():
    # $60 cost at a 25% target margin -> $80 (a 25% markup would be $75).
    assert pricing.price_for_margin(60, 25) == Decimal("80.00")
    assert pricing.margin_pct(60, 80) == Decimal(25)
    assert pricing.markup_pct(60, 80) == Decimal("33.33333333333333333333333333")


def test_sell_price_rounds_up_to_the_cent_and_never_below_margin():
    price = pricing.price_for_margin("10.00", 30)  # 14.2857...
    assert price == Decimal("14.29")
    assert pricing.margin_pct(10, price) >= Decimal(30)


def test_no_binary_float_noise():
    # 60 / (1 - 0.25) in floats is 80.00000000000001, which would round up to 80.01.
    assert pricing.price_for_margin(60.0, 25.0) == Decimal("80.00")
    assert pricing.price_for_margin(0.1, 0) == Decimal("0.10")


@pytest.mark.parametrize("margin", [100, 150, -1, "abc", None, float("nan")])
def test_invalid_margin_is_refused(margin):
    with pytest.raises(ValueError):
        pricing.price_for_margin(10, margin)


@pytest.mark.parametrize("cost", [-0.01, None, "x", float("inf")])
def test_invalid_cost_is_refused(cost):
    with pytest.raises(ValueError):
        pricing.price_for_margin(cost, 20)


def test_margin_and_markup_undefined_cases():
    assert pricing.margin_pct(5, 0) is None
    assert pricing.markup_pct(0, 5) is None


@pytest.mark.parametrize(
    "price,uses,expected",
    [
        (Decimal("48.00"), 4000, Decimal("0.012000")),      # c-fold towels, 4,000 sheets/case
        ("96.00", "6000", Decimal("0.016000")),
        (30, 12, Decimal("2.500000")),                       # breakroom: cups per sleeve
        (1, 3, Decimal("0.333333")),
    ],
)
def test_cost_per_use(price, uses, expected):
    assert pricing.cost_per_use(price, uses) == expected


@pytest.mark.parametrize("price,uses", [(10, 0), (10, -5), (10, None), (None, 10), (-1, 10), ("n/a", 10), (10, float("nan"))])
def test_cost_per_use_is_none_when_unsupported(price, uses):
    assert pricing.cost_per_use(price, uses) is None


def test_savings_amount_and_percent():
    s = pricing.savings(Decimal("0.0200"), Decimal("0.0150"))
    assert s["amount"] == Decimal("0.0050") and s["pct"] == Decimal("25.00")
    worse = pricing.savings(10, 12)
    assert worse["amount"] == Decimal(-2) and worse["pct"] == Decimal("-20.00")
    assert pricing.savings(0, 5)["pct"] is None
    assert pricing.savings(None, 5) is None
    assert pricing.savings(-1, 5) is None


def test_money_rounds_half_up():
    assert pricing.money(Decimal("2.675")) == Decimal("2.68")  # float math gives 2.67
    assert pricing.money(Decimal("1.004")) == Decimal("1.00")


@pytest.mark.parametrize("raw,expected", [("$1,234.50", Decimal("1234.50")), (" 7 ", Decimal(7)), (0.1, Decimal("0.1")), (True, None), ("", None), ("1e999999", None)])
def test_to_decimal(raw, expected):
    got = pricing.to_decimal(raw)
    assert got == expected
