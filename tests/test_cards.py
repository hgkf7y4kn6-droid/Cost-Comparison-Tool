import io

import pytest

PIL = pytest.importorskip("PIL")
from PIL import Image  # noqa: E402

import cards  # noqa: E402

CARD = """ACME SUPPLY CO.
Dana Whitfield
Director of Facilities
Tel: 610.555.0142   Fax: 610-555-0199
Cell: (484) 555-0111
dana.whitfield@acmesupply.com
www.acmesupply.com
1200 Hamilton St, Suite 4
Allentown, PA 18102
"""


def test_parse_card_text_full_card():
    out = cards.parse_card_text(CARD)
    assert out["name"] == "Dana Whitfield"
    assert out["title"] == "Director of Facilities"
    assert out["company"] == "ACME SUPPLY CO."
    assert out["email"] == "dana.whitfield@acmesupply.com"
    assert out["phone"] == "(610) 555-0142"      # fax line ignored
    assert out["mobile"] == "(484) 555-0111"
    assert out["website"] == "acmesupply.com"
    assert out["address"] == "1200 Hamilton St, Suite 4"
    assert (out["city"], out["state"], out["zip"]) == ("Allentown", "PA", "18102")


def test_parse_card_text_sparse_and_garbage():
    out = cards.parse_card_text("Sam Lee\nsam@brightdental.com\n(215) 555 0100 ext 22")
    assert out["email"] == "sam@brightdental.com"
    assert out["phone"] == "(215) 555-0100 x22"
    assert out["company"] == "Brightdental"          # from the email domain
    assert cards.parse_card_text("")["email"] == ""
    assert cards.parse_card_text("!!! ??? 123")["name"] == ""


def test_parse_ignores_free_mail_domain_for_company():
    out = cards.parse_card_text("Pat Doe\npat@gmail.com")
    assert out["company"] == "" and out["website"] == ""


def test_coerce_fields_sanitizes_model_output():
    out = cards.coerce_fields({"name": "  A   B ", "email": "not-an-email", "state": "pennsylvania", "zip": "1810",
                               "phone": "6105550142", "website": "https://Acme.com/", "evil": "x", "title": "T" * 500})
    assert out["name"] == "A B" and out["email"] == "" and out["state"] == "" and out["zip"] == ""
    assert out["phone"] == "(610) 555-0142" and out["website"] == "acme.com" and len(out["title"]) == 160
    assert "evil" not in out
    with pytest.raises(ValueError):
        cards.coerce_fields(["x"])


def _jpeg(size=(300, 200)):
    buf = io.BytesIO()
    Image.new("RGB", size, "white").save(buf, "PNG")
    return buf.getvalue()


def test_prepare_image_validates_and_shrinks():
    with pytest.raises(ValueError):
        cards.prepare_image(b"not an image")
    with pytest.raises(ValueError):
        cards.prepare_image(b"x" * (cards.MAX_IMAGE_BYTES + 1))
    big = cards.prepare_image(_jpeg((4000, 3000)))
    assert max(Image.open(io.BytesIO(big)).size) == cards.MAX_SIDE


def test_scan_prefers_ai_then_falls_back_to_ocr(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "x")
    monkeypatch.setattr(cards, "_call_vision", lambda jpeg: {"name": "Dana W", "company": "Acme"})
    out = cards.scan_card(_jpeg())
    assert out["source"] == "ai" and out["fields"]["name"] == "Dana W"

    def boom(jpeg):
        raise OSError("down")
    monkeypatch.setattr(cards, "_call_vision", boom)
    monkeypatch.setattr(cards, "_ocr", lambda jpeg: CARD)
    out = cards.scan_card(_jpeg())
    assert out["source"] == "ocr" and out["fields"]["email"] == "dana.whitfield@acmesupply.com"


def test_scan_without_any_reader_or_text(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr(cards, "_ocr", lambda jpeg: None)
    with pytest.raises(RuntimeError):
        cards.scan_card(_jpeg())
    monkeypatch.setattr(cards, "_ocr", lambda jpeg: "  \n ")
    with pytest.raises(ValueError):
        cards.scan_card(_jpeg())
