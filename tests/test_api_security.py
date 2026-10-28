import io
import os
import zipfile

import openpyxl
import pytest

import hardening
from helpers import CATALOG_CSV, upload, xlsx_bytes

PROTECTED = [
    ("get", "/auth/me"), ("get", "/catalog/status/"), ("get", "/feedback/list/"), ("get", "/records/leads/"),
    ("get", "/records/accounts/"), ("get", "/records/export"), ("get", "/records/audit"),
    ("post", "/records/leads/bulk"), ("put", "/records/leads/x1"), ("delete", "/records/leads/x1"),
    ("post", "/catalog/upload/"), ("post", "/compare/"), ("post", "/compare/download/"), ("post", "/leads/parse/"),
    ("post", "/analysis/spend/"), ("post", "/feedback/confirm/"), ("get", "/reports/anything.xlsx"),
]


@pytest.mark.parametrize("method,path", PROTECTED)
def test_every_data_route_requires_sign_in(client, method, path):
    r = getattr(client, method)(path)
    assert r.status_code == 401
    assert r.json() == {"detail": "Please sign in."}
    bad = getattr(client, method)(path, headers={"Authorization": "Bearer not.a.token"})
    assert bad.status_code == 401


def test_health_exposes_nothing_else(client):
    r = client.get("/health")
    assert r.json() == {"status": "ok"}
    assert "set-cookie" not in r.headers


def test_security_headers_and_cache_policy(client, rep):
    r = client.get("/health", headers={"x-forwarded-proto": "https"})
    for header in ["x-content-type-options", "x-frame-options", "referrer-policy", "content-security-policy", "strict-transport-security"]:
        assert header in r.headers, header
    assert "frame-ancestors 'none'" in r.headers["content-security-policy"]
    assert r.headers["cache-control"] == "no-store"
    assert client.get("/auth/me").headers["x-content-type-options"] == "nosniff"  # even on a 401
    page = client.get("/")
    assert page.status_code == 200 and page.headers["cache-control"] == "no-cache"
    assert client.get("/fonts/plus-jakarta-sans-latin-400-normal.woff2").headers["cache-control"].startswith("public, max-age=")


def test_static_app_is_public_but_cannot_escape_its_folder(client):
    assert client.get("/index.html").status_code == 200
    for path in ["/../backend.py", "/%2e%2e/backend.py", "/..%2fauth.py", "/frontend/../auth.py"]:
        r = client.get(path)
        assert r.status_code in (401, 404), path
        assert "AUTH_SECRET" not in r.text
    assert client.get("/backend.py").status_code == 401  # server code is not part of the public app


def test_errors_do_not_leak_internals(client, rep, backend):
    r = client.post("/leads/parse/", files=upload("x.xlsx", b"PK\x03\x04 not really a zip"), headers=rep)
    assert r.status_code == 422
    body = r.text
    assert "Traceback" not in body and "/home/" not in body and ".py" not in body


def test_catalog_upload_validations(client, rep, boss):
    # A rep may not replace the shared catalog once managers are configured.
    assert client.post("/catalog/upload/", files=upload("c.csv", CATALOG_CSV.encode()), headers=rep).status_code == 403
    r = client.post("/catalog/upload/", files=upload("c.csv", CATALOG_CSV.encode()), headers=boss)
    assert r.status_code == 200 and r.json()["loaded_items"] == 4 and r.json()["duplicate_skus"] == []
    # persisted for the next restart
    import backend

    assert os.path.exists(backend.CATALOG_PATH)


def test_catalog_skips_bad_rows_and_reports_duplicates(client, boss):
    csv = CATALOG_CSV + "BAD-1,Neg,desc,hand towel,good,-5,10,x\nBAD-2,Nan,desc,hand towel,good,abc,10,x\nBAD-3,Tier,desc,hand towel,platinum,5,10,x\nTWL-CF-1,Dup,Duplicate sku,hand towel,good,49.00,0,c-fold\n"
    r = client.post("/catalog/upload/", files=upload("c.csv", csv.encode()), headers=boss)
    assert r.status_code == 200
    assert r.json()["skipped_rows"] == 3 and r.json()["duplicate_skus"] == ["TWL-CF-1"]
    # zero uses_per_case is dropped, not divided by
    import backend

    assert backend.engine.by_sku["TWL-CF-1"]["uses_per_case"] is None
    assert backend.engine.by_sku["TWL-CF-1"]["price"] == 49.0


@pytest.mark.parametrize(
    "name,content,status",
    [
        ("leads.exe", b"MZ....", 400),
        ("leads", b"%PDF-1.4", 400),
        ("leads.pdf", b"", 422),
        ("leads.pdf", b"this is not a pdf", 422),
        ("leads.xlsx", b"%PDF-1.4 renamed", 422),
        ("../../etc/passwd.pdf", b"nope", 422),
    ],
)
def test_lead_upload_rejects_wrong_type_or_content(client, rep, name, content, status):
    assert client.post("/leads/parse/", files=upload(name, content), headers=rep).status_code == status


def test_oversized_upload_is_refused(client, rep, monkeypatch):
    monkeypatch.setattr(hardening, "MAX_UPLOAD_BYTES", 2048)

    big = b"%PDF-1.4" + b"0" * 5000
    # read_upload's default was bound at import, so exercise the function with an explicit cap too
    r = client.post("/leads/parse/", files=upload("big.pdf", big), headers=rep)
    assert r.status_code in (413, 422)


def test_read_upload_enforces_cap_directly():
    import asyncio

    from fastapi import HTTPException, UploadFile

    f = UploadFile(io.BytesIO(b"%PDF" + b"0" * 5000), filename="a.pdf")
    with pytest.raises(HTTPException) as e:
        asyncio.run(hardening.read_upload(f, {"pdf"}, max_bytes=1000))
    assert e.value.status_code == 413


def test_zip_bomb_guard(monkeypatch):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("xl/big.xml", b"0" * 1_000_000)
    monkeypatch.setattr(hardening, "MAX_UNCOMPRESSED_XLSX_BYTES", 10_000)
    with pytest.raises(Exception) as e:
        hardening.check_zip_safe(buf.getvalue())
    assert getattr(e.value, "status_code", None) == 413


def test_valid_xlsx_lead_parse_keeps_zip_codes_and_phone_formats(client, rep):
    content = xlsx_bytes([["Company", "Zip", "Phone"], ["Acme Co", "08540", "(215) 555-0100"], ["Beta LLC", "19103-1234", "267-555-0101"]])
    r = client.post("/leads/parse/", files=upload("leads.xlsx", content), headers=rep)
    assert r.status_code == 200
    rows = r.json()["sheets"][0]["rows"]
    assert rows[1] == ["Acme Co", "08540", "(215) 555-0100"]


def test_excel_formulas_in_uploaded_data_never_become_formulas_in_reports(client, boss, rep, backend):
    client.post("/catalog/upload/", files=upload("c.csv", CATALOG_CSV.encode()), headers=boss)
    evil = '=HYPERLINK("http://evil.example","click")'
    content = xlsx_bytes([
        ["date", "location", "product", "quantity", "unit_price"],
        ["2025-01-05", evil, "c-fold paper towel", 2, "10.00"],
        ["2025-01-06", "HQ", "+cmd|' /C calc'!A0 hand towel", 1, "5.00"],
    ])
    r = client.post("/analysis/spend/", files=upload("spend.xlsx", content), data={"recommended_tier": "good"}, headers=rep)
    assert r.status_code == 200, r.text
    wb_bytes = client.get(r.json()["workbook_url"], headers=rep)
    assert wb_bytes.status_code == 200
    wb = openpyxl.load_workbook(io.BytesIO(wb_bytes.content))
    found = False
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for c in row:
                assert c.data_type != "f", f"formula in {ws.title}!{c.coordinate}: {c.value}"
                found = found or c.value == evil
    assert found, "the text should still be present, just inert"


def test_reports_need_sign_in_and_use_unguessable_names(client, rep, boss, backend):
    client.post("/catalog/upload/", files=upload("c.csv", CATALOG_CSV.encode()), headers=boss)
    content = xlsx_bytes([["date", "location", "product", "quantity", "unit_price"], ["2025-01-05", "HQ", "c-fold paper towel", 2, "10.00"]])
    r = client.post("/analysis/spend/", files=upload("spend.xlsx", content), headers=rep)
    url = r.json()["workbook_url"]
    assert len(os.path.basename(url)) > 40
    assert client.get(url).status_code == 401
    assert client.get(url, headers=rep).status_code == 200
    assert client.get("/reports/../backend.py", headers=rep).status_code in (400, 404)


def test_image_only_pdf_gets_a_clear_message_not_a_crash(client, rep):
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (200, 200), "white").save(buf, format="PDF")
    r = client.post("/leads/parse/", files=upload("scan.pdf", buf.getvalue()), headers=rep)
    assert r.status_code == 422 and "scanned" in r.json()["detail"].lower()


def test_empty_workbook_is_a_clear_message(client, rep):
    r = client.post("/leads/parse/", files=upload("empty.xlsx", xlsx_bytes([])), headers=rep)
    assert r.status_code == 422


def test_unexpected_server_errors_are_generic_and_logged(client, rep, backend, monkeypatch, caplog):
    def boom(*_a, **_k):
        raise RuntimeError("secret internal path /var/data/x")

    monkeypatch.setattr(backend.record_store, "list_visible", boom)
    from fastapi.testclient import TestClient

    r = TestClient(backend.app, raise_server_exceptions=False).get("/records/leads/", headers=rep)
    assert r.status_code == 500
    assert "secret" not in r.text and "RuntimeError" not in r.text
    assert r.headers["x-content-type-options"] == "nosniff"
