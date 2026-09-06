"""The guard that makes ``guard_support.app_files()`` unavoidable — and the proof that
its own floor can fire (#729).

**Why a population guard and not a paragraph.** Six test modules walked ``app/`` on
2026-09-04, and every one carried its own copy of the population floor — the #730
lesson had propagated, but by COPY, which is how a defect propagates too (#733). A
technique that reaches guard N+1 only through the author's memory is the finding
#729 exists to describe; the remedy this codebase has already proven is a single
source that the suite enforces (``strip-comments.test.ts`` on the frontend, #838).

⚠️ This is NOT the "meta-guard over the guard set" #730 refused. That refusal was of
a guard asserting every scan HAS a population check — a property no scan can read.
This asserts one source for one operation, which an AST can read exactly.
"""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

from tests.guard_support import APP_DIR, app_files

TESTS_DIR = Path(__file__).resolve().parent
_SELF = {"guard_support.py", Path(__file__).name}


def _py_glob_calls(tree: ast.Module) -> list[int]:
    """Line numbers of ``<x>.glob("*.py")`` / ``<x>.rglob("*.py")`` calls.

    An AST walk rather than a text scan, deliberately: this file's own docstring
    names the pattern in prose, and a guard's parser must not read prose as
    markup (#772).
    """
    hits: list[int] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
            continue
        if node.func.attr not in ("glob", "rglob") or not node.args:
            continue
        arg = node.args[0]
        if isinstance(arg, ast.Constant) and isinstance(arg.value, str) and arg.value.endswith(".py"):
            hits.append(node.lineno)
    # `ast.walk` is breadth-first, so a call nested inside `sorted(...)` is
    # reported after a shallower one that comes later in the file.
    return sorted(hits)


def test_no_test_module_walks_the_app_tree_itself():
    """Every ``.py`` walk in a test goes through ``app_files()``.

    A hand-rolled ``rglob`` carries neither the floor nor the tree-identity check,
    and ``rglob`` on a mistyped root yields ``[]`` without raising — so a scan built
    on one can go silently blind. Walk through the helper instead.
    """
    offenders: list[str] = []
    modules = sorted(p for p in TESTS_DIR.glob("*.py") if p.name not in _SELF)
    # POPULATION self-check (#730): a scan over an empty test directory would
    # report a clean sweep. 182 test modules on 2026-09-04; the floor detects a
    # bad TESTS_DIR, not growth.
    assert len(modules) >= 150, f"only {len(modules)} test modules under {TESTS_DIR} — wrong directory?"
    for path in modules:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for lineno in _py_glob_calls(tree):
            offenders.append(f"{path.name}:{lineno}")
    assert not offenders, (
        "These tests walk the .py tree themselves instead of through "
        "tests/guard_support.py::app_files(), which carries the population floor "
        "(#730) and the tree-identity check that a bare rglob cannot: \n  "
        + "\n  ".join(offenders)
        + "\n\nFix: `from tests.guard_support import app_files` and pass the floor and "
        "the sentinel modules the scan exists to police (#729)."
    )


def test_the_detector_fires_on_a_real_walk():
    """PREDICATE falsifier: the AST matcher sees both spellings and ignores prose."""
    src = (
        'files = sorted(APP_DIR.rglob("*.py"))\n'
        'for p in ROUTERS.glob("*.py"):\n'
        '    pass\n'
        '# a comment that says rglob("*.py") must not count\n'
        'x = "rglob(\\"*.py\\")"\n'
        'others = list(d.glob("*.json"))\n'
    )
    assert _py_glob_calls(ast.parse(src)) == [1, 2]


def test_the_floor_fires_on_a_bad_root():
    """``rglob`` on a mistyped sub-directory yields ``[]`` silently; the floor does not."""
    with pytest.raises(AssertionError, match="below the floor"):
        app_files("routerz", floor=1)
    with pytest.raises(AssertionError, match="below the floor"):
        app_files(floor=10_000)


def test_the_sentinel_fires_even_when_the_count_is_fine():
    with pytest.raises(AssertionError, match="cannot see"):
        app_files(floor=1, sentinels=("services/does_not_exist.py",))


def test_the_failure_frame_states_what_was_walked_and_the_remedy():
    with pytest.raises(AssertionError) as exc:
        app_files("routers", floor=10_000, recursive=False)
    message = str(exc.value)
    assert "under app/routers" in message
    assert "floor of 10000" in message
    assert "do NOT lower the floor" in message


def test_the_walk_is_the_application_tree():
    files = app_files(floor=100)
    rels = {p.relative_to(APP_DIR).as_posix() for p in files}
    assert "main.py" in rels
    assert "routers/coding.py" in rels
    assert files == sorted(files)
    routers = app_files("routers", floor=30, recursive=False)
    assert all(p.parent == APP_DIR / "routers" for p in routers)
