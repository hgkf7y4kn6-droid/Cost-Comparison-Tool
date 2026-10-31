"""Office Basics Good/Better/Best Comparison Engine: the FastAPI app. Wires middleware and routers;
the work lives in the modules it imports."""
import os
import sys

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

import routes_analysis
import routes_auth
import routes_catalog
import routes_compare
import routes_leads
import routes_records
from config import REPORTS_DIR
from deps import authenticator

app = FastAPI(title="Office Basics Good/Better/Best Comparison Engine")

# Every endpoint except these requires a signed-in user (see auth.py).
PUBLIC_PATHS = {"/health", "/auth/login"}
# The web app itself (frontend/) is served from "/" so the whole product runs
# from this one service. Those static files are public; the data they show
# comes from the protected API.
FRONTEND_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend")


def _is_frontend_file(path: str) -> bool:
    if path == "/":
        return os.path.isdir(FRONTEND_DIR)
    full = os.path.realpath(os.path.join(FRONTEND_DIR, path.lstrip("/")))
    return full.startswith(os.path.realpath(FRONTEND_DIR) + os.sep) and os.path.isfile(full)


# Registered before CORSMiddleware so CORS stays the outer layer: preflights are
# answered and 401s still carry CORS headers the browser can read.
@app.middleware("http")
async def require_sign_in(request: Request, call_next):
    if request.method == "OPTIONS" or request.url.path in PUBLIC_PATHS:
        return await call_next(request)
    if request.method in ("GET", "HEAD") and _is_frontend_file(request.url.path):
        return await call_next(request)
    if not authenticator.configured:
        return JSONResponse(
            {"detail": "Sign-in isn't set up on the server yet (AUTH_USERS is empty)."}, status_code=503
        )
    header = request.headers.get("authorization", "")
    token = header[7:].strip() if header.lower().startswith("bearer ") else ""
    user = authenticator.verify_token(token) if token else None
    if not user:
        return JSONResponse({"detail": "Please sign in."}, status_code=401, headers={"WWW-Authenticate": "Bearer"})
    request.state.user = user["sub"]
    return await call_next(request)


# The web app normally comes from this same service (its own domain or the
# Render URL), which needs no CORS. Only a frontend on a different origin
# (e.g. Cloudflare) does: ALLOWED_ORIGINS is a comma-separated list such as
# "https://cost-comparison-tool.example.workers.dev". Unset means same-origin
# only; "*" allows any origin.
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]
if "*" in ALLOWED_ORIGINS:
    print("WARNING: ALLOWED_ORIGINS is '*'; set it to your frontend URL(s) before real customer data.", file=sys.stderr)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/reports", StaticFiles(directory=REPORTS_DIR), name="reports")
# Compress API responses and the web app's files (JS/CSS/JSON shrink ~70-80%).
app.add_middleware(GZipMiddleware, minimum_size=1024)

# Registered last, so it is the outermost layer and every response gets these,
# including 401s and CORS preflights.
FRONTEND_SUFFIXES = (".html", ".js", ".css")


@app.middleware("http")
async def web_headers(request: Request, call_next):
    response = await call_next(request)
    h = response.headers
    h.setdefault("X-Content-Type-Options", "nosniff")
    h.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    # Nobody can frame the app (clickjacking).
    h.setdefault("X-Frame-Options", "DENY")
    h.setdefault("Content-Security-Policy", "frame-ancestors 'none'")
    # Behind Render's HTTPS proxy (uvicorn --proxy-headers): browsers stick to HTTPS.
    if request.url.scheme == "https":
        h.setdefault("Strict-Transport-Security", "max-age=31536000")
    # The page and its scripts revalidate on each load, so a deploy shows up
    # right away instead of mixing old and new files.
    path = request.url.path
    if request.method in ("GET", "HEAD") and (path == "/" or path.endswith(FRONTEND_SUFFIXES)):
        h.setdefault("Cache-Control", "no-cache")
    return response

for _routes in (routes_auth, routes_records, routes_catalog, routes_leads, routes_compare, routes_analysis):
    app.include_router(_routes.router)


@app.get("/health")
async def health():
    return {"status": "ok"}


# The web app, last so every API route above takes precedence.
if os.path.isdir(FRONTEND_DIR):
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
