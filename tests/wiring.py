"""Imports backend.py with stand-ins for the heavy libraries (fastapi, torch,
faiss, transformers) and records how the app is wired: every route, the
middleware stack in registration order, and mounts. Used to prove refactors
of backend.py don't change what the server exposes."""
import importlib
import os
import sys
import types
from unittest.mock import MagicMock

PROJECT_MODULES = ("backend", "deps", "config", "extraction", "engine", "excel_style", "comparison", "analysis",
                   "routes_auth", "routes_records", "routes_catalog", "routes_compare",
                   "routes_analysis", "routes_leads")


class _Routes:
    def __init__(self):
        self.routes = []

    def _make(self, method):
        def decorator(path, **kw):
            def wrap(fn):
                self.routes.append([method, path, fn.__name__])
                return fn
            return wrap
        return decorator

    def __getattr__(self, name):
        if name in ("get", "post", "put", "delete", "patch"):
            return self._make(name.upper())
        raise AttributeError(name)


class StubRouter(_Routes):
    def __init__(self, *a, **kw):
        super().__init__()


class StubApp(_Routes):
    def __init__(self, *a, **kw):
        super().__init__()
        self.stack, self.mounts = [], []

    def middleware(self, kind):
        def wrap(fn):
            self.stack.append([f"@middleware({kind})", fn.__name__])
            return fn
        return wrap

    def add_middleware(self, cls, **kw):
        self.stack.append([cls.__name__, {k: kw[k] for k in sorted(kw)}])

    def mount(self, path, app, name=None):
        self.mounts.append([path, name, type(app).__name__])

    def include_router(self, router, **kw):
        self.routes.extend(router.routes)


class StubHTTPException(Exception):
    def __init__(self, status_code, detail=None):
        super().__init__(detail)
        self.status_code, self.detail = status_code, detail


def install_stubs():
    import starlette.middleware.cors as cors
    import starlette.middleware.gzip as gz
    import starlette.responses as resp
    import starlette.staticfiles as st

    fastapi = types.ModuleType("fastapi")
    fastapi.FastAPI, fastapi.APIRouter = StubApp, StubRouter
    fastapi.HTTPException, fastapi.UploadFile, fastapi.Request = StubHTTPException, type("UploadFile", (), {}), type("Request", (), {})
    fastapi.File = fastapi.Form = lambda *a, **kw: None
    mods = {
        "fastapi": fastapi,
        "fastapi.middleware": types.ModuleType("fastapi.middleware"),
        "fastapi.middleware.cors": cors,
        "fastapi.middleware.gzip": gz,
        "fastapi.responses": resp,
        "fastapi.staticfiles": st,
        "faiss": MagicMock(),
        "torch": MagicMock(),
        "transformers": MagicMock(),
    }
    sys.modules.update(mods)


def load_backend(data_dir, root):
    os.environ["DATA_DIR"] = str(data_dir)
    os.environ["ALLOWED_ORIGINS"] = "https://example.test"
    for name in PROJECT_MODULES:
        sys.modules.pop(name, None)
    if root not in sys.path:
        sys.path.insert(0, root)
    install_stubs()
    return importlib.import_module("backend")


def wiring(backend):
    app = backend.app
    return {
        "routes": sorted(app.routes),
        "middleware_in_registration_order": app.stack,
        "mounts_in_order": app.mounts,
    }
