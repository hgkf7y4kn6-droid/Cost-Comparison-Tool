"""Test setup.

The real backend loads PyTorch, FAISS and the CLIP model at import, which is far
too heavy (and needs a model download) for unit tests. This file installs small
deterministic stand-ins for those three libraries *before* backend.py is
imported, so every route, validator and report builder runs for real while the
"embedding" is a hashed bag of words (similar text -> similar vector).
"""
import os
import sys
import tempfile
import types
import zlib
from contextlib import contextmanager

import numpy as np
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

DIM = 512
TEST_PASSWORD = "correct horse battery staple"
MANAGER_PASSWORD = "manager horse battery staple"


def _token_vec(token: str) -> np.ndarray:
    rng = np.random.default_rng(zlib.crc32(token.encode()))
    return rng.standard_normal(DIM).astype("float32")


class _Features:
    def __init__(self, arr):
        self.arr = arr

    def cpu(self):
        return self

    def numpy(self):
        return self.arr


class _Inputs(dict):
    def to(self, _device):
        return self


class _FakeModel:
    def to(self, _device):
        return self

    def get_text_features(self, texts=None, **_):
        vecs = []
        for t in texts:
            words = [w for w in "".join(c.lower() if c.isalnum() else " " for c in t).split() if w]
            vecs.append(sum((_token_vec(w) for w in words), np.zeros(DIM, dtype="float32")))
        return _Features(np.array(vecs, dtype="float32"))

    def get_image_features(self, images=None, **_):
        return _Features(np.array([_token_vec(str(im.size) + str(im.tobytes()[:64])) for im in images], dtype="float32"))


class _FakeProcessor:
    def __call__(self, text=None, images=None, **_):
        return _Inputs(texts=text) if text is not None else _Inputs(images=[images])


class _FlatIP:
    def __init__(self, dim):
        self.dim = dim
        self.vectors = np.zeros((0, dim), dtype="float32")

    @property
    def ntotal(self):
        return len(self.vectors)

    def add(self, arr):
        self.vectors = np.vstack([self.vectors, np.asarray(arr, dtype="float32")])

    def search(self, vec, k):
        scores = self.vectors @ np.asarray(vec, dtype="float32").T
        order = np.argsort(-scores[:, 0])[:k]
        out_s = np.full((1, k), -1.0, dtype="float32")
        out_i = np.full((1, k), -1, dtype="int64")
        out_s[0, : len(order)] = scores[order, 0]
        out_i[0, : len(order)] = order
        return out_s, out_i


def _install_fakes():
    faiss = types.ModuleType("faiss")
    faiss.IndexFlatIP = _FlatIP

    def normalize_L2(vec):
        norms = np.linalg.norm(vec, axis=1, keepdims=True)
        vec /= np.where(norms == 0, 1, norms)

    faiss.normalize_L2 = normalize_L2

    torch = types.ModuleType("torch")
    torch.cuda = types.SimpleNamespace(is_available=lambda: False)

    @contextmanager
    def no_grad():
        yield

    torch.no_grad = no_grad

    transformers = types.ModuleType("transformers")
    transformers.CLIPModel = types.SimpleNamespace(from_pretrained=lambda *_a, **_k: _FakeModel())
    transformers.CLIPProcessor = types.SimpleNamespace(from_pretrained=lambda *_a, **_k: _FakeProcessor())
    sys.modules.update({"faiss": faiss, "torch": torch, "transformers": transformers})


_install_fakes()

import auth  # noqa: E402  (after sys.path setup)

DATA_DIR = tempfile.mkdtemp(prefix="saleshub-test-")
os.environ.update({
    "DATA_DIR": DATA_DIR,
    "DISABLE_MAINTENANCE": "1",
    "AUTH_SECRET": "x" * 48,
    "AUTH_USERS": ",".join([
        f"rep@example.com:{auth.hash_password(TEST_PASSWORD, iterations=1000)}",
        f"rep2@example.com:{auth.hash_password(TEST_PASSWORD, iterations=1000)}",
        f"boss@example.com:{auth.hash_password(MANAGER_PASSWORD, iterations=1000)}",
    ]),
    "AUTH_MANAGERS": "boss@example.com",
})


@pytest.fixture(scope="session")
def backend():
    import backend as module

    return module


@pytest.fixture()
def client(backend):
    from fastapi.testclient import TestClient

    backend.authenticator._failures.clear()
    return TestClient(backend.app)


def _login(client, email, password):
    r = client.post("/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


@pytest.fixture()
def rep(client):
    return _login(client, "rep@example.com", TEST_PASSWORD)


@pytest.fixture()
def rep2(client):
    return _login(client, "rep2@example.com", TEST_PASSWORD)


@pytest.fixture()
def boss(client):
    return _login(client, "boss@example.com", MANAGER_PASSWORD)
