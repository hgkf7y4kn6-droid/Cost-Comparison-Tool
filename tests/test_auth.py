import json

import auth
from conftest import MANAGER_PASSWORD, TEST_PASSWORD


def make(users=None):
    return auth.Authenticator(users or {"a@example.com": auth.hash_password("pw-long-enough-1", 1000)}, "s" * 40, {"boss@example.com"})


def test_password_hash_roundtrip_and_salt():
    h1, h2 = auth.hash_password("abc", 1000), auth.hash_password("abc", 1000)
    assert h1 != h2 and h1.startswith("pbkdf2_sha256$1000$")
    assert auth.verify_password("abc", h1) and not auth.verify_password("abd", h1)
    assert not auth.verify_password("abc", "garbage") and not auth.verify_password("abc", "md5$1$a$b")


def test_default_iterations_are_strong():
    assert auth.PBKDF2_ITERATIONS >= 600_000


def test_token_roundtrip_expiry_and_revocation():
    a = make()
    token, exp = a.issue_token("a@example.com", now=1000)
    assert a.verify_token(token, now=1001)["sub"] == "a@example.com"
    assert a.verify_token(token, now=exp + 1) is None
    a.users["a@example.com"] = auth.hash_password("new-password-here", 1000)  # password changed
    assert a.verify_token(token, now=1001) is None


def test_tampered_and_malformed_tokens_are_rejected_not_raised():
    a = make()
    token, _ = a.issue_token("a@example.com")
    payload, sig = token.split(".")
    assert a.verify_token(payload + "." + "A" * len(sig)) is None
    for bad in ["", "x", "a.b.c", None, "....", payload]:
        assert a.verify_token(bad) is None


def _signed(a, body):
    payload = auth._b64(json.dumps(body).encode())
    return f"{payload}.{a._sign(payload)}"


def test_validly_signed_but_odd_payloads_never_raise():
    a = make()
    for body in [[1, 2], "str", {"sub": ["x"]}, {"sub": {"a": 1}}, {"sub": "a@example.com", "exp": "soon"}, {"sub": "a@example.com", "exp": True}, {"sub": 5}]:
        assert a.verify_token(_signed(a, body)) is None


def test_lockout_after_repeated_failures():
    a = make()
    for _ in range(auth.MAX_FAILURES_PER_EMAIL):
        assert a.login("a@example.com", "wrong", "1.1.1.1") is None
    assert a.locked_out("a@example.com", "2.2.2.2")
    assert not a.locked_out("other@example.com", "2.2.2.2")
    assert a.locked_out("a@example.com", "2.2.2.2", now=1e12) is False  # window expires


def test_unknown_user_and_wrong_password_are_indistinguishable(client):
    unknown = client.post("/auth/login", json={"email": "nobody@example.com", "password": "whatever-123"})
    wrong = client.post("/auth/login", json={"email": "rep@example.com", "password": "whatever-123"})
    assert unknown.status_code == wrong.status_code == 401
    assert unknown.json() == wrong.json()


def test_login_endpoint_roles_and_me(client):
    r = client.post("/auth/login", json={"email": " BOSS@example.com ", "password": MANAGER_PASSWORD})
    assert r.status_code == 200 and r.json()["role"] == "manager"
    me = client.get("/auth/me", headers={"Authorization": f"Bearer {r.json()['token']}"})
    assert me.json() == {"email": "boss@example.com", "role": "manager"}


def test_login_rejects_oversized_fields(client):
    assert client.post("/auth/login", json={"email": "a" * 300, "password": "x"}).status_code == 422
    assert client.post("/auth/login", json={"email": "rep@example.com", "password": "x" * 5000}).status_code == 422


def test_http_lockout_returns_429(client):
    for _ in range(5):
        assert client.post("/auth/login", json={"email": "rep@example.com", "password": "nope-nope-nope"}).status_code == 401
    assert client.post("/auth/login", json={"email": "rep@example.com", "password": TEST_PASSWORD}).status_code == 429
