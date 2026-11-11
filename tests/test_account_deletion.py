import pytest

import auth
import notes
import personas
from accounts_store import RecordStore

H = auth.hash_password("correct horse battery", iterations=1000)


def test_erasing_a_user_removes_owned_data_only(tmp_path):
    """The same steps routes_auth.delete_account runs, against the real stores."""
    records = RecordStore(str(tmp_path / "r.db"))
    inbox = notes.NoteInbox(str(tmp_path / "n.db"))
    kb = personas.KnowledgeStore(str(tmp_path / "k.db"))
    a = auth.Authenticator({"ana@x.com": H, "raj@x.com": H}, "s", None, str(tmp_path / "d.json"))

    records.save("leads", "L1", {"company": "Ana Lead"}, "ana@x.com", False)
    records.save("leads", "L2", {"company": "Raj Lead"}, "raj@x.com", False)
    records.save("accounts", "A1", {"company": "Ana Acct"}, "ana@x.com", False)
    inbox.add("ana@x.com", {"notes": "hi"})
    kb.add("ana@x.com", False, "Mine", "private", [], False)

    for kind in ("accounts", "leads"):
        full, _ = records.list_visible(kind, "ana@x.com", False)
        for rec in full:
            if rec["ownerEmail"] == "ana@x.com":
                assert records.delete(kind, rec["id"], "ana@x.com", False)
    assert inbox.erase_user("ana@x.com") == 1 and kb.erase_user("ana@x.com") == 1
    a.deactivate("ana@x.com")

    full, _ = records.list_visible("leads", "raj@x.com", False)
    assert [r["id"] for r in full] == ["L2"]
    assert records.list_visible("accounts", "raj@x.com", False) == ([], [])
    assert a.login("ana@x.com", "correct horse battery", "ip") is None
    assert a.login("raj@x.com", "correct horse battery", "ip") == "raj@x.com"
