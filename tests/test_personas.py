import pytest

import personas

PERCEPTION = personas.KNOWLEDGE[0]


@pytest.fixture
def store(tmp_path):
    return personas.KnowledgeStore(str(tmp_path / "coach.db"))


@pytest.fixture(autouse=True)
def no_ai(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)


def test_perception_text_is_in_every_persona_knowledge_verbatim():
    assert PERCEPTION["id"] == "perception-matters" and PERCEPTION["personas"] == ["*"]
    body = PERCEPTION["body"]
    for line in ("PERCEPTION MATTERS IN SALES", "customers cannot buy value they cannot see.".capitalize().replace("Customers", "Because customers"),
                 "• Can they see the value before they buy?", "“Why should I pay this much?”",
                 "What signals influence your perception of a business before you buy from them?"):
        assert line in body
    for p in personas.PERSONAS:
        ids = [e["id"] for e in personas.retrieve(personas.all_knowledge(None, "u"), p["id"],
                                                  "does my customer see the value? how professional is our presentation")]
        assert "perception-matters" in ids, p["id"]


def test_retrieval_prefers_specific_entries_and_respects_persona():
    entries = personas.all_knowledge(None, "u")
    top = personas.retrieve(entries, "objections", "they say they are happy with their current vendor")[0]
    assert top["id"] == "objection-happy-vendor"
    assert all(e["id"] != "onboarding-growth" for e in personas.retrieve(entries, "discovery", "onboarding account growth review"))


def test_fallback_answer_without_ai_cites_sources():
    out = personas.ask(None, "u", "proposal", "How do I show value in the proposal?")
    assert out["ai"] is False and out["sources"] and "Checklist" in out["answer"]


def test_unknown_persona_and_empty_question():
    with pytest.raises(ValueError):
        personas.ask(None, "u", "nope", "hi")
    with pytest.raises(ValueError):
        personas.ask(None, "u", "discovery", "   ")


def test_ai_path_sends_knowledge_and_only_safe_deal_fields(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
    seen = {}

    def fake(system, messages):
        seen["system"], seen["messages"] = system, messages
        return "Do this."

    monkeypatch.setattr(personas, "_call_anthropic", fake)
    deal = {"company": "Acme Dental", "stage": "qualified", "cost": 123.45, "margin": 0.31, "notes": "secret", "contactEmail": "a@b.com"}
    out = personas.ask(None, "u", "outreach", "Write a voicemail for a facilities manager", deal=deal,
                       history=[{"role": "assistant", "text": "orphan"}, {"role": "user", "text": "hi"}, {"role": "assistant", "text": "hello"}])
    assert out == {"answer": "Do this.", "sources": out["sources"], "ai": True}
    assert "PERCEPTION MATTERS IN SALES" in seen["system"] and "Acme Dental" in seen["system"]
    for leaked in ("123.45", "0.31", "secret", "a@b.com"):
        assert leaked not in seen["system"]
    assert [m["role"] for m in seen["messages"]] == ["user", "assistant", "user"]


def test_ai_failure_falls_back(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
    monkeypatch.setattr(personas, "_call_anthropic", lambda *a: (_ for _ in ()).throw(ValueError("bad")))
    assert personas.ask(None, "u", "discovery", "first call questions")["ai"] is False


def test_custom_knowledge_private_shared_and_erased(store):
    mine = store.add("ana@x.com", False, "Our delivery promise", "Next-day delivery on stocked items.", ["proposal"], False)
    assert [e["id"] for e in store.visible("ana@x.com")] == [mine["id"]]
    assert store.visible("raj@x.com") == []
    with pytest.raises(PermissionError):
        store.add("ana@x.com", False, "t", "b", [], True)
    shared = store.add("boss@x.com", True, "Pricing floor policy", "Never below 18%.", [], True)
    assert shared["personas"] == ["*"]
    assert {e["id"] for e in store.visible("raj@x.com")} == {shared["id"]}
    with pytest.raises(PermissionError):
        store.remove("raj@x.com", False, mine["id"])
    assert store.remove("ana@x.com", False, mine["id"]) and not store.remove("ana@x.com", False, mine["id"])
    out = personas.ask(store, "raj@x.com", "proposal", "pricing floor policy", None)
    assert any(s["id"] == shared["id"] for s in out["sources"])
    assert store.erase_user("boss@x.com") == 1 and store.visible("raj@x.com") == []


def test_entry_validation_and_limit(store, monkeypatch):
    with pytest.raises(ValueError):
        store.add("u", False, "", "x", [], False)
    monkeypatch.setattr(personas, "MAX_CUSTOM_PER_USER", 1)
    store.add("u", False, "a", "b", [], False)
    with pytest.raises(ValueError):
        store.add("u", False, "c", "d", [], False)


def test_no_ai_without_the_users_consent(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
    monkeypatch.setattr(personas, "_call_anthropic", lambda *a: pytest.fail("sent to the AI without consent"))
    assert personas.ask(None, "u", "discovery", "first call questions", allow_ai=False)["ai"] is False


def test_notes_and_cards_respect_consent(monkeypatch):
    import cards
    import notes
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
    monkeypatch.setattr(notes, "_call_anthropic", lambda *a: pytest.fail("note sent without consent"))
    out = notes.structure_note("Called Pat, send samples Friday", allow_ai=False)
    assert out
    monkeypatch.setattr(cards, "_call_vision", lambda *a: pytest.fail("card sent without consent"))
    monkeypatch.setattr(cards, "_ocr", lambda jpeg: "Pat Smith\nOffice Manager\npat@acme.com")
    monkeypatch.setattr(cards, "prepare_image", lambda b: b)
    assert cards.scan_card(b"x", allow_ai=False)["source"] == "ocr"
