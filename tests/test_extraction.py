import pytest

for _lib in ("starlette", "pandas", "pdfplumber", "PIL"):
    pytest.importorskip(_lib)

import wiring  # noqa: E402

wiring.install_stubs()  # extraction imports fastapi's HTTPException
import extraction  # noqa: E402


@pytest.mark.parametrize("text,expected", [
    ("Unit price $12.99 each", 12.99),
    ("Total: $1,234.50", 1234.50),
    ("$ 7", 7.0),
    ("no money here", None),
    ("", None),
])
def test_extract_price(text, expected):
    assert extraction.extract_price(text) == expected


def test_price_near_keywords_prefers_a_priced_label_over_the_first_dollar_amount():
    text = "Shipping $5.00\nCase of 12\nList price $48.00\nSave $3"
    assert extraction.extract_price_near_keywords(text) == 48.00


def test_price_near_keywords_falls_back_to_first_price_in_text():
    assert extraction.extract_price_near_keywords("Special $9.99 today") == 9.99
    assert extraction.extract_price_near_keywords("nothing") is None


@pytest.mark.parametrize("price,uses,expected", [
    (10.0, 500, 0.02), (10.0, None, None), (10.0, 0, None), (None, 100, None),
])
def test_cost_per_use(price, uses, expected):
    assert extraction.cost_per_use(price, uses) == expected


def test_spreadsheet_text_is_extracted_and_unknown_types_rejected(tmp_path):
    import io

    import pandas as pd

    pytest.importorskip("openpyxl")
    buf = io.BytesIO()
    pd.DataFrame({"item": ["Towels"], "price": ["$4.25"]}).to_excel(buf, index=False)
    text, image = extraction.extract_text_and_image(buf.getvalue(), "xlsx")
    assert "Towels" in text and "$4.25" in text and image is None
    with pytest.raises(Exception) as err:
        extraction.extract_text_and_image(b"x", "exe")
    assert getattr(err.value, "status_code", None) == 400
