"""Good/better/best cost comparison and spend analysis against hand-worked numbers.

Each scenario states its inputs and the answer worked out on paper, so a change
to the arithmetic that moves any figure fails loudly instead of silently
changing what a customer is quoted.
"""

import pytest

from helpers import upload, xlsx_bytes

CATEGORY_CATALOG = """sku,name,description,category,tier,price,uses_per_case,format
J-G,Can liners 33gal,Black 33 gallon liner,can liner,good,40.00,250,
J-B,Can liners 33gal heavy,Heavy duty liner,can liner,better,36.00,250,
J-X,Can liners roll,Roll-pack liner,can liner,best,30.00,,roll
B-G,Coffee 24ct,Breakroom coffee pods,coffee,good,24.00,24,pod
O-G,Copy paper 10 ream,Copy paper case,copy paper,good,45.00,5000,sheet
O-B,Copy paper recycled,Recycled copy paper,copy paper,better,42.00,5000,sheet
P-G,Business cards 1000,Printed business cards,business cards,good,50.00,1000,card
PR-G,Logo pens 250,Promotional pens with logo,promo pens,good,100.00,250,pen
F-G,Task chair,Ergonomic task chair,task chair,good,200.00,,
"""


@pytest.fixture()
def loaded(client, boss):
    r = client.post("/catalog/upload/", files=upload("cat.csv", CATEGORY_CATALOG.encode()), headers=boss)
    assert r.status_code == 200, r.text
    return client


def spend(client, headers, rows, tier="good"):
    header = ["date", "location", "product", "quantity", "unit_price", "competitor_uses_per_case"]
    r = client.post("/analysis/spend/", files=upload("spend.xlsx", xlsx_bytes([header] + rows)), data={"recommended_tier": tier}, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()["summary"]


def test_janitorial_cost_per_use_normalization(loaded, rep):
    # Competitor liners: 10 cases at $42.00, 200 liners/case = 2,000 liners.
    # Ours: $40.00 for 250 liners -> 2,000 liners = 8 cases = $320.00. Current = $420.00. Savings $100.00.
    s = spend(loaded, rep, [["2025-02-01", "HQ", "black can liners 33 gallon", 10, 42.00, 200]])
    assert s["total_current_spend"] == 420.00
    assert s["total_recommended_spend"] == 320.00
    assert s["total_savings"] == 100.00
    assert s["rows_cost_per_use"] == 1 and s["rows_case_for_case"] == 0
    assert s["savings_cost_per_use"] == 100.00 and s["savings_case_for_case"] == 0


def test_missing_usage_data_is_labelled_an_estimate_not_measured(loaded, rep):
    # No competitor_uses_per_case: assume case-for-case, 5 x $24.00 = $120 vs 5 x $24.00 -> flagged, not measured.
    s = spend(loaded, rep, [["2025-02-01", "HQ", "coffee pods breakroom", 5, 30.00, None]])
    assert s["rows_case_for_case"] == 1 and s["rows_cost_per_use"] == 0
    assert s["savings_case_for_case"] == s["total_savings"] == 30.00   # 5 x (30 - 24)


def test_office_paper_cents_do_not_drift(loaded, rep):
    # 3 cases at $44.99 vs recycled at $42.00: 3 x 44.99 = 134.97 ; 3 x 42.00 = 126.00 ; savings 8.97
    s = spend(loaded, rep, [["2025-03-01", "HQ", "copy paper recycled", 3, 44.99, 5000]], tier="better")
    assert (s["total_current_spend"], s["total_recommended_spend"], s["total_savings"]) == (134.97, 126.00, 8.97)


def test_printing_and_promotional_rounding_to_cents(loaded, rep):
    # Competitor cards: 3 boxes of 500 at $27.33 = $81.99. Ours: $50.00/1000 -> 1,500 cards = 1.5 cases = $75.00.
    s = spend(loaded, rep, [["2025-04-01", "HQ", "printed business cards", 3, 27.33, 500]])
    assert (s["total_current_spend"], s["total_recommended_spend"], s["total_savings"]) == (81.99, 75.00, 6.99)
    # Promotional pens: 7 cases of 144 at $61.17 = $428.19 -> 1,008 pens / 250 = 4.032 cases x $100 = $403.20
    s = spend(loaded, rep, [["2025-04-01", "HQ", "promotional pens logo", 7, 61.17, 144]])
    assert (s["total_current_spend"], s["total_recommended_spend"], s["total_savings"]) == (428.19, 403.20, 24.99)


def test_furniture_without_usage_data_is_case_for_case(loaded, rep):
    s = spend(loaded, rep, [["2025-05-01", "HQ", "ergonomic task chair", 4, 229.50, None]])
    assert (s["total_current_spend"], s["total_recommended_spend"], s["total_savings"]) == (918.00, 800.00, 118.00)
    assert s["rows_case_for_case"] == 1


def test_a_more_expensive_recommendation_shows_negative_savings_not_hidden(loaded, rep):
    s = spend(loaded, rep, [["2025-05-01", "HQ", "ergonomic task chair", 1, 150.00, None]])
    assert s["total_savings"] == -50.00


def test_invalid_rows_are_reported_not_crashed_or_silently_priced(loaded, rep):
    rows = [
        ["2025-06-01", "HQ", "ergonomic task chair", 1, 200.00, None],       # fine
        ["2025-06-01", "HQ", "ergonomic task chair", "lots", 200.00, None],  # quantity not a number
        ["2025-06-01", "HQ", "ergonomic task chair", 2, -5.00, None],        # negative price
        ["2025-06-01", "HQ", "ergonomic task chair", 2, None, None],         # price missing
    ]
    s = spend(loaded, rep, rows)
    assert s["rows_analyzed"] == 1 and s["rows_invalid"] == 3
    assert [r["row"] for r in s["invalid_rows"]] == [3, 4, 5]
    assert "lots" not in str(s["invalid_rows"])  # names the problem, never echoes cell contents


def test_all_rows_invalid_is_a_clear_422(loaded, rep):
    r = loaded.post("/analysis/spend/", files=upload("s.xlsx", xlsx_bytes([["date", "location", "product", "quantity", "unit_price"], ["2025-01-01", "HQ", "x", "abc", 1]])), headers=rep)
    assert r.status_code == 422 and "row 2" in r.json()["detail"]


def test_unusable_uses_per_case_falls_back_instead_of_dividing_by_zero(loaded, rep):
    s = spend(loaded, rep, [["2025-02-01", "HQ", "black can liners 33 gallon", 1, 42.00, 0]])
    assert s["rows_case_for_case"] == 1 and s["total_recommended_spend"] == 40.00


def test_total_price_column_is_used_when_present(loaded, rep):
    header = ["date", "location", "product", "quantity", "total_price"]
    r = loaded.post("/analysis/spend/", files=upload("s.xlsx", xlsx_bytes([header, ["2025-01-01", "HQ", "ergonomic task chair", 2, 410.00]])), headers=rep)
    assert r.json()["summary"]["total_current_spend"] == 410.00


def test_missing_columns_and_unknown_catalog(client, rep, boss):
    r = client.post("/analysis/spend/", files=upload("s.xlsx", xlsx_bytes([["date", "product"], ["2025-01-01", "x"]])), headers=rep)
    assert r.status_code in (400, 422)
    r = client.post("/analysis/spend/", files=upload("s.xlsx", xlsx_bytes([["date", "location", "product", "quantity"], ["2025-01-01", "HQ", "x", 1]])), headers=boss)
    assert r.status_code == 422 and "unit_price" in r.json()["detail"]


def test_single_comparison_endpoint_and_workbook(loaded, rep):
    pdf_like = b"%PDF-1.4"  # not parseable: should be a clean 422, not a 500
    r = loaded.post("/compare/", files=upload("c.pdf", pdf_like), headers=rep)
    assert r.status_code == 422
    r = loaded.post("/compare/", files=upload("c.xlsx", xlsx_bytes([["Black can liners 33 gallon heavy duty"], ["Price", "$42.00"]])), data={"competitor_uses_per_case": "0"}, headers=rep)
    assert r.status_code == 422
    r = loaded.post("/compare/download/", files=upload("c.xlsx", xlsx_bytes([["Black can liners 33 gallon"], ["Price", "$42.00"]])), data={"competitor_uses_per_case": "200"}, headers=rep)
    assert r.status_code == 200, r.text
    comp = r.json()["comparison"]
    assert comp["competitor_price"] == 42.0 and comp["competitor_cost_per_use"] == 0.21
    # (Which SKUs match depends on the real CLIP model; the tests stub it, so only the arithmetic is asserted.)
    assert isinstance(comp["tiers"], dict) and comp["competitor_uses_per_case"] == 200
    assert loaded.get(r.json()["download_url"], headers=rep).status_code == 200


def test_feedback_confirmation_is_validated_and_persisted_atomically(loaded, rep, backend):
    r = loaded.post("/compare/", files=upload("c.xlsx", xlsx_bytes([["Black can liners 33 gallon"], ["Price", "$42.00"]])), headers=rep)
    cid = r.json()["comparison_id"]
    assert loaded.post("/feedback/confirm/", json={"comparison_id": cid, "good_sku": "NOPE"}, headers=rep).status_code == 422
    assert loaded.post("/feedback/confirm/", json={"comparison_id": "unknown"}, headers=rep).status_code == 404
    ok = loaded.post("/feedback/confirm/", json={"comparison_id": cid, "good_sku": "J-B"}, headers=rep)
    assert ok.status_code == 200 and ok.json()["tier_skus"]["good"] == "J-B"
    import json, os
    assert json.load(open(backend.FEEDBACK_PATH))[-1]["tier_skus"]["good"] == "J-B"
    assert not [f for f in os.listdir(backend.REPORTS_DIR) if f.endswith(".tmp")]


def test_corrupt_feedback_file_is_set_aside_not_overwritten(tmp_path, backend):
    path = tmp_path / "fb.json"
    path.write_text("{ truncated")
    store = backend.FeedbackStore(backend.engine, str(path))
    assert store.entries == []
    assert any(".corrupt-" in f.name for f in tmp_path.iterdir())
    assert not path.exists()
