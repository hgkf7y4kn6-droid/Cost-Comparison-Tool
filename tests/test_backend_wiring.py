import json
import os

import pytest

for _lib in ("starlette", "pydantic", "numpy", "pandas", "openpyxl", "pdfplumber", "docx", "PIL"):
    pytest.importorskip(_lib)

import wiring  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GOLDEN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "golden_wiring.json")


@pytest.fixture
def backend(tmp_path):
    return wiring.load_backend(tmp_path, ROOT)


def test_wiring_matches_golden_snapshot(backend):
    got = wiring.wiring(backend)
    if os.environ.get("UPDATE_GOLDEN"):
        with open(GOLDEN, "w") as f:
            json.dump(got, f, indent=1, sort_keys=True)
            f.write("\n")
    with open(GOLDEN) as f:
        want = json.load(f)
    assert got == want


def test_cors_stays_outside_sign_in_check(backend):
    """Registration order = inner to outer: sign-in check first, then CORS, then gzip,
    so 401s and preflights still carry CORS headers."""
    names = [m[0] for m in backend.app.stack]
    assert names == ["@middleware(http)", "CORSMiddleware", "GZipMiddleware"]


def test_every_route_but_health_login_and_static_requires_sign_in(backend):
    open_paths = {"/health", "/auth/login"}
    assert open_paths == backend.PUBLIC_PATHS
