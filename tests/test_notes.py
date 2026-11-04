from datetime import date

import pytest

import auth
import notes

TODAY = date(2026, 11, 4)  # a Wednesday
H = auth.hash_password("correct horse battery", iterations=1000)


def test_parse_when_relative_and_explicit():
    assert notes.parse_when("call him tomorrow", TODAY) == "2026-11-05"
    assert notes.parse_when("check back next week", TODAY) == "2026-11-11"
    assert notes.parse_when("in two weeks", TODAY) == "2026-11-18"
    assert notes.parse_when("send samples on friday", TODAY) == "2026-11-06"
    assert notes.parse_when("on wednesday", TODAY) == "2026-11-11"  # never "today"
    assert notes.parse_when("review on Dec 3rd", TODAY) == "2026-12-03"
    assert notes.parse_when("by 2026-12-01", TODAY) == "2026-12-01"
    assert notes.parse_when("nothing dated here", TODAY) is None


def test_parse_when_past_month_day_rolls_to_next_year():
    assert notes.parse_when("meet on Jan 5", TODAY) == "2027-01-05"


def test_heuristic_finds_type_next_action_and_date():
    out = notes.heuristic_structure(
        "Stopped by the warehouse and walked the floor with Dana. They go through lots of gloves. "
        "I will send glove samples on friday.", TODAY)
    assert out["type"] == "visit"
    assert notes.heuristic_structure("Called Pat. Send quote on friday.", TODAY)["nextAction"] == "Send quote on friday"
    assert out["nextAction"].lower().startswith("send glove samples")
    assert out["nextActionDate"] == "2026-11-06"
    assert out["source"] == "rules"
    assert out["summary"].startswith("Stopped by")


@pytest.mark.parametrize("text,kind", [
    ("Quick zoom call with the CFO", "virtual"),
    ("Left a voicemail for Sam", "call"),
    ("Met with the facilities team", "meeting"),
    ("They had a problem with a damaged pallet", "issue"),
    ("Remember they like the blue ones", "note"),
])
def test_heuristic_type_guess(text, kind):
    assert notes.heuristic_structure(text, TODAY)["type"] == kind


def test_structure_note_rejects_empty_and_falls_back_without_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with pytest.raises(ValueError):
        notes.structure_note("   ")
    assert notes.structure_note("Called Pat, follow up tomorrow", today=TODAY)["source"] == "rules"


def test_structure_note_falls_back_when_ai_fails(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "x")

    def boom(*a):
        raise OSError("network down")
    monkeypatch.setattr(notes, "_call_anthropic", boom)
    assert notes.structure_note("Called Pat", today=TODAY)["source"] == "rules"


def test_structure_note_uses_ai_result_and_sanitizes_it(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "x")
    monkeypatch.setattr(notes, "_call_anthropic", lambda *a: {
        "summary": "Pat wants a quote", "notes": "- Wants a quote", "type": "DROP TABLE",
        "nextAction": "Send quote", "nextActionDate": "not-a-date", "extra": "ignored"})
    out = notes.structure_note("raw", today=TODAY)
    assert out == {"summary": "Pat wants a quote", "notes": "- Wants a quote", "type": "note",
                   "nextAction": "Send quote", "nextActionDate": "", "source": "ai"}


def test_integration_key_roundtrip_and_revocation():
    a = auth.Authenticator({"ana@x.com": H}, "secret")
    key = a.integration_key("ana@x.com")
    assert a.verify_integration_key(key) == "ana@x.com"
    assert a.verify_integration_key(key[:-2] + "xx") is None
    assert a.verify_integration_key("ik_garbage.zzz") is None
    assert a.verify_integration_key("") is None
    # A signed-in session token is not an integration key, and vice versa.
    token, _ = a.issue_token("ana@x.com")
    assert a.verify_integration_key(token) is None
    assert a.verify_token(key) is None
    # Changing the password, another server secret, or removing the user revokes it.
    assert auth.Authenticator({"ana@x.com": auth.hash_password("another passphrase", iterations=1000)}, "secret").verify_integration_key(key) is None
    assert auth.Authenticator({"ana@x.com": H}, "other").verify_integration_key(key) is None
    assert auth.Authenticator({"raj@x.com": H}, "secret").verify_integration_key(key) is None


def test_clean_inbound_accepts_common_spellings_and_rejects_empty():
    item = notes.clean_inbound({"account": "Acme Co", "transcript": " Talked pricing ", "type": "CALL",
                                "date": "2026-11-03T10:00:00Z", "source": "Otter"}, TODAY)
    assert item["company"] == "Acme Co" and item["notes"] == "Talked pricing"
    assert item["type"] == "call" and item["date"] == "2026-11-03" and item["source"] == "Otter"
    assert notes.clean_inbound({"text": "x", "type": "bogus", "date": "junk"}, TODAY)["date"] == "2026-11-04"
    with pytest.raises(ValueError):
        notes.clean_inbound({"company": "Acme"}, TODAY)
    with pytest.raises(ValueError):
        notes.clean_inbound(["nope"], TODAY)


def test_inbox_is_per_user_and_capped(tmp_path, monkeypatch):
    inbox = notes.NoteInbox(str(tmp_path / "n.db"))
    first = inbox.add("ana@x.com", {"notes": "one"})
    inbox.add("raj@x.com", {"notes": "other"})
    assert [n["notes"] for n in inbox.pending("ana@x.com")] == ["one"]
    assert not inbox.remove("raj@x.com", first)  # can't delete someone else's
    assert inbox.remove("ana@x.com", first)
    assert inbox.pending("ana@x.com") == []
    monkeypatch.setattr(notes, "MAX_INBOX_PER_USER", 2)
    inbox.add("ana@x.com", {"notes": "a"})
    inbox.add("ana@x.com", {"notes": "b"})
    with pytest.raises(ValueError):
        inbox.add("ana@x.com", {"notes": "c"})
