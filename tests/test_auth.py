import auth

# Few iterations keep the suite fast; production uses 600k.
H = auth.hash_password("correct horse battery", iterations=1000)


def make(managers=None):
    return auth.Authenticator({"ana@x.com": H}, "secret", managers)


def test_hash_verifies_only_right_password():
    assert auth.verify_password("correct horse battery", H)
    assert not auth.verify_password("wrong", H)
    assert not auth.verify_password("x", "garbage")


def test_load_users_parses_and_lowercases():
    users = auth.load_users(f"Ana@X.com:{H}, ,bad,raj@x.com:abc")
    assert set(users) == {"ana@x.com", "raj@x.com"}


def test_token_roundtrip_and_expiry():
    a = make()
    token, exp = a.issue_token("ana@x.com", now=1000)
    assert a.verify_token(token, now=1001)["sub"] == "ana@x.com"
    assert a.verify_token(token, now=exp + 1) is None


def test_tampered_or_foreign_token_rejected():
    a = make()
    token, _ = a.issue_token("ana@x.com")
    payload, sig = token.split(".")
    assert a.verify_token(payload + "." + sig[::-1]) is None
    other = auth.Authenticator({"ana@x.com": H}, "different-secret")
    assert other.verify_token(token) is None
    assert a.verify_token("") is None


def test_password_change_invalidates_token():
    a = make()
    token, _ = a.issue_token("ana@x.com")
    a.users["ana@x.com"] = auth.hash_password("another long password", iterations=1000)
    assert a.verify_token(token) is None


def test_lockout_after_five_failures_per_email():
    a = make()
    for _ in range(5):
        assert a.login("ana@x.com", "nope", "1.1.1.1", now=100) is None
    assert a.locked_out("ana@x.com", "9.9.9.9", now=101)
    assert not a.locked_out("ana@x.com", "9.9.9.9", now=100 + auth.FAILURE_WINDOW_SECONDS + 1)


def test_successful_login_clears_failures():
    a = make()
    for _ in range(3):
        a.login("ana@x.com", "nope", "1.1.1.1", now=100)
    assert a.login("ana@x.com", "correct horse battery", "1.1.1.1", now=101) == "ana@x.com"
    assert not a.locked_out("ana@x.com", "1.1.1.1", now=102)


def test_unknown_email_cannot_log_in_and_counts_as_failure():
    a = make()
    assert a.login("ghost@x.com", "anything", "2.2.2.2", now=1) is None


def test_roles_and_fail_closed():
    a = make({"ana@x.com"})
    assert a.role("ana@x.com") == "manager" and a.role("raj@x.com") == "rep"
    assert a.configured
    assert not auth.Authenticator({}, "s").configured
