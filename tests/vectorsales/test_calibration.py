import random
from datetime import date, timedelta

import pytest

from vectorsales import calibration as cal
from vectorsales.store import Store

AS_OF = date(2026, 12, 31)


def rows(n, rate_fn, seed=1, parts=None, age_days=120):
    rng = random.Random(seed)
    out = []
    for i in range(n):
        pr = rng.randint(0, 100)
        snap = AS_OF - timedelta(days=age_days)
        conv = rng.random() < rate_fn(pr)
        out.append({"account_id": f"a{i}", "snapshot_at": snap.isoformat(), "priority": pr,
                    "fit": pr if not parts else rng.randint(0, 100), "intent": pr, "contactability": rng.randint(0, 100), "evidence": rng.randint(0, 100),
                    "outcome_at": (snap + timedelta(days=rng.randint(1, 50))).isoformat() if conv else None})
    return out


def test_auc_known_values():
    assert cal.auc([1, 2, 3, 4], [False, False, True, True]) == 1.0
    assert cal.auc([4, 3, 2, 1], [False, False, True, True]) == 0.0
    assert cal.auc([1, 1, 1, 1], [False, True, False, True]) == 0.5       # ties count half
    assert cal.auc([1, 2], [True, True]) is None


def test_wilson_interval_is_sane():
    lo, hi = cal.wilson(5, 10)
    assert 0.2 < lo < 0.5 < hi < 0.8 and cal.wilson(0, 0) is None and cal.wilson(0, 10)[0] == 0.0


def test_open_accounts_are_excluded_not_counted_as_failures():
    recent = {"account_id": "r", "snapshot_at": (AS_OF - timedelta(days=10)).isoformat(), "priority": 90, "outcome_at": None}
    old_miss = {**recent, "account_id": "o", "snapshot_at": (AS_OF - timedelta(days=100)).isoformat()}
    quick_win = {**recent, "account_id": "w", "outcome_at": (AS_OF - timedelta(days=5)).isoformat()}
    late = {**old_miss, "account_id": "l", "outcome_at": (AS_OF - timedelta(days=2)).isoformat()}     # converted, but after the window
    pre = {**old_miss, "account_id": "p", "outcome_at": (AS_OF - timedelta(days=200)).isoformat()}   # outcome before the prediction
    lab = cal.label_rows([recent, old_miss, quick_win, late, pre], 60, AS_OF)
    assert lab["open"] == 1 and lab["converted_after_window"] == 1
    assert sorted((r["account_id"], r["converted"]) for r in lab["matured"]) == [("l", False), ("o", False), ("w", True)]


def test_predictive_score_is_detected_with_monotone_buckets_and_calibration_map():
    r = cal.calibrate(rows(1500, lambda p: 0.05 + 0.6 * p / 100), window_days=60, as_of=AS_OF)
    assert r["sufficient_data"] and r["auc"] > 0.65 and r["monotonic"]
    assert r["buckets"][-1]["rate"] > r["buckets"][0]["rate"] + 0.3
    assert r["suggested_weights"] and r["suggested_weights"]["intent"] > r["suggested_weights"]["contactability"]
    assert sum(r["suggested_weights"].values()) == pytest.approx(1.0, abs=0.01)
    hi, lo = cal.probability(r, 95), cal.probability(r, 3)
    assert hi > lo and 0 <= lo <= hi <= 1
    maps = [s["rate"] for s in r["calibration_map"]]
    assert maps == sorted(maps)                                            # isotonic: never decreasing


def test_useless_score_is_called_out():
    r = cal.calibrate(rows(1500, lambda p: 0.3), window_days=60, as_of=AS_OF)
    assert r["sufficient_data"] and abs(r["auc"] - 0.5) < 0.06
    assert any("chance" in n for n in r["notes"])


def test_too_little_data_gives_no_recommendation_and_says_so():
    r = cal.calibrate(rows(40, lambda p: 0.5), as_of=AS_OF)
    assert not r["sufficient_data"] and r["suggested_weights"] is None and r["calibration_map"] is None
    assert any("Too little data" in n for n in r["notes"]) and cal.probability(r, 50) is None


def test_empty_input_is_safe():
    r = cal.calibrate([], as_of=AS_OF)
    assert r["matured"] == 0 and r["base_rate"] is None and r["auc"] is None


def test_isotonic_pools_violations():
    out = cal.isotonic([1, 2, 3, 4], [True, False, True, True])
    rates = [o["rate"] for o in out]
    assert rates == sorted(rates) and out[0]["n"] == 2 and out[0]["rate"] == 0.5


# ---- store: snapshots and outcomes ------------------------------------------------------------------
def scored(priority=70):
    return {"priority": {"priority": priority, "parts": {"fit": 80, "intent": 60, "contactability": 40, "evidence": 20}, "weights": {"fit": 1}, "explanation": ["x"]}}


def test_first_snapshot_is_the_prediction_and_repeat_views_do_not_create_new_ones():
    st = Store()
    t0 = __import__("datetime").datetime(2026, 1, 1, tzinfo=__import__("datetime").timezone.utc)
    assert st.snapshot_score("t", "a1", scored(70), now=t0)
    assert not st.snapshot_score("t", "a1", scored(95), now=t0 + timedelta(days=2))        # too soon
    assert st.snapshot_score("t", "a1", scored(30), now=t0 + timedelta(days=9))
    st.record_outcome("t", "a1", "meeting_booked", "2026-01-20")
    assert not st.record_outcome("t", "a1", "meeting_booked", "2026-03-01")                # first time stands
    row = st.calibration_rows("t", "meeting_booked")[0]
    assert row["priority"] == 70 and row["outcome_at"] == "2026-01-20"                     # later re-scores don't rewrite history
    assert st.calibration_rows("other", "meeting_booked") == []
    assert st.calibration_rows("t", "won")[0]["outcome_at"] is None
