"""Every module-level and function-level name must resolve. A cheap stand-in for
pyflakes (not installable in every environment): uses the interpreter's own
scoping analysis, so a missing import after moving code between modules fails here
instead of at the first request that touches it."""
import builtins
import glob
import os
import symtable

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FILES = sorted(glob.glob(os.path.join(ROOT, "*.py")))


def undefined_names(code):
    top = symtable.symtable(code, "m", "exec")
    defined = {s.get_name() for s in top.get_symbols() if s.is_assigned() or s.is_imported() or s.is_namespace()}
    bad = set()

    def walk(table, is_module):
        for s in table.get_symbols():
            name = s.get_name()
            if name in defined or hasattr(builtins, name) or name.startswith("__"):
                continue
            if is_module:
                if s.is_referenced() and not s.is_assigned():
                    bad.add(name)
            elif s.is_global() and s.is_referenced():
                bad.add(name)
        for child in table.get_children():
            walk(child, False)

    walk(top, True)
    return bad


@pytest.mark.parametrize("path", FILES, ids=[os.path.basename(p) for p in FILES])
def test_no_undefined_names(path):
    with open(path) as f:
        assert undefined_names(f.read()) == set()


def test_checker_catches_a_missing_import():
    assert undefined_names("def f():\n    return json.dumps({})\n") == {"json"}
