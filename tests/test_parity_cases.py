import json
import os
from decimal import Decimal

import pytest

import pricing
from accounts_store import order_spend

CASES = json.load(open(os.path.join(os.path.dirname(__file__), "fixtures", "calc_cases.json")))


@pytest.mark.parametrize("c", CASES["price_for_margin"])
def test_price_for_margin_cases(c):
    assert pricing.price_for_margin(c["cost"], c["margin"]) == Decimal(str(c["expect"])).quantize(Decimal("0.01"))


@pytest.mark.parametrize("c", CASES["price_for_margin_invalid"])
def test_price_for_margin_invalid_cases(c):
    with pytest.raises(ValueError):
        pricing.price_for_margin(c["cost"], c["margin"])


@pytest.mark.parametrize("c", CASES["cost_per_use"])
def test_cost_per_use_cases(c):
    assert pricing.cost_per_use(c["price"], c["uses"]) == Decimal(str(c["expect"])).quantize(Decimal("0.000001"))


@pytest.mark.parametrize("c", CASES["cost_per_use_unsupported"])
def test_cost_per_use_unsupported_cases(c):
    assert pricing.cost_per_use(c["price"], c["uses"]) is None


@pytest.mark.parametrize("c", CASES["order_merchandise"])
def test_order_merchandise_cases(c):
    assert order_spend({"lines": c["lines"]}) == c["expect"]
