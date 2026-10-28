"""#1319 — every in-place write of `Segment.text` is a decided one. Fail-closed.

A char-range quote is an offset pair INTO a segment's text, so anything that
rewrites the text in place moves every quote on it onto other words unless it
carries them. #1319 was two such writers (the conversation and document edit
doors) that carried nothing. Both now go through
`services/segment_operations.py::apply_text_edit`, which plans and carries every
quote before it writes; this scan makes the NEXT writer decide too.

**What it finds** (`_writes`), per module under `app/`, keyed by the enclosing
function: an assignment to any `.text` attribute (plain, augmented, annotated,
or inside a tuple target); `setattr(x, "text", …)`; a dict key `Segment.text`
(a bulk `query.update({Segment.text: …})`); a `.values(text=…)` call; and a
string holding `UPDATE segments … SET … text`.

**Why every `.text` write and not only Segment's:** an AST cannot know a
variable's type. The handful of other objects with a `.text` (a docx cell, an XML
element, a search response) are listed below as NOT A SEGMENT, each with its
reason — a new one costs one line, and the alternative is a scan that can be
fooled by naming a segment `cell`.

⚠️ **Blind, and said so:** `obj.__dict__["text"] = …`, `setattr(obj, name, …)`
with a non-literal name, `bulk_update_mappings(Segment, [...])`, and a raw SQL
string assembled at runtime. None exists in `app/` today
(`test_the_blind_spots_are_absent_today` checks the two greppable ones).
"""
from __future__ import annotations

import ast
import re

from tests.guard_support import APP_DIR, app_files


# relpath::function  →  why this write needs no quote rebase.
ALLOWLIST: dict[str, str] = {
    "services/segment_operations.py::apply_text_edit":
        "THE text-edit writer (#1319): it plans every char-range quote with "
        "plan_text_edit_rebase and carries, removes or refuses each one before it writes.",
    "routers/observations.py::update_clip":
        "a clip's text is its LABEL — annotation, not material. Clips carry no "
        "char-range quotes (excerpts.py::_segment_excerpt_shape_error refuses the shape "
        "on an observation), and D22 keeps label edits legal on a frozen observation.",
    "services/withdrawal_redaction.py::apply_withdrawal":
        "withdrawal blanks the person's turns AFTER deleting every excerpt on them, so "
        "no quote is left to carry (#1320 owns this path).",
    "routers/search.py::search_study":
        "NOT A SEGMENT: `response.text` is the search response's text-results field.",
    "services/canvas_export.py::_render_node":
        "NOT A SEGMENT: `cell.text` is a python-docx table cell in the canvas export.",
    "services/codebook_exchange.py::export_codebook_qdc.build_code_element":
        "NOT A SEGMENT: `desc.text` is an XML element in the .qdc codebook export.",
}

# The doors that edit a turn's or paragraph's text, and the one call each must make.
TEXT_EDIT_DOORS = {
    "routers/segments.py::update_segment": "apply_text_edit",
    "routers/documents.py::update_document_segment": "apply_text_edit",
    "routers/segments.py::preview_segment_text_edit": "preview_text_edit",
    "routers/documents.py::preview_document_segment_edit": "preview_text_edit",
    "services/segment_operations.py::apply_text_edit": "plan_text_edit_rebase",
    "services/segment_operations.py::preview_text_edit": "plan_text_edit_rebase",
}

_RAW_SQL = re.compile(r"\bUPDATE\s+segments\b[^;]*\bSET\b[^;]*\btext\b", re.IGNORECASE | re.DOTALL)


def _store_targets(node: ast.AST) -> list[ast.AST]:
    if isinstance(node, ast.Assign):
        return list(node.targets)
    if isinstance(node, (ast.AugAssign, ast.AnnAssign)):
        return [node.target]
    return []


def _writes(tree: ast.AST) -> dict[str, list[str]]:
    """{qualified function name: [a description of each write]} for one module."""
    found: dict[str, list[str]] = {}
    stack: list[str] = []

    def record(kind: str) -> None:
        found.setdefault(".".join(stack) or "<module>", []).append(kind)

    class Visitor(ast.NodeVisitor):
        def visit_FunctionDef(self, node):
            stack.append(node.name)
            self.generic_visit(node)
            stack.pop()

        visit_AsyncFunctionDef = visit_FunctionDef

        def visit_ClassDef(self, node):
            stack.append(node.name)
            self.generic_visit(node)
            stack.pop()

        def generic_visit(self, node):
            for target in _store_targets(node):
                for sub in ast.walk(target):
                    if isinstance(sub, ast.Attribute) and sub.attr == "text" and isinstance(sub.ctx, ast.Store):
                        record(f"assign {ast.unparse(sub)}")
            if isinstance(node, ast.Call):
                func = node.func
                if (
                    isinstance(func, ast.Name) and func.id == "setattr" and len(node.args) >= 2
                    and isinstance(node.args[1], ast.Constant) and node.args[1].value == "text"
                ):
                    record("setattr text")
                if isinstance(func, ast.Attribute) and func.attr == "values" and any(
                    kw.arg == "text" for kw in node.keywords
                ):
                    record(".values(text=)")
            if isinstance(node, ast.Dict):
                for key in node.keys:
                    if key is not None and ast.unparse(key) == "Segment.text":
                        record("dict key Segment.text")
            if isinstance(node, ast.Constant) and isinstance(node.value, str) and _RAW_SQL.search(node.value):
                record("raw UPDATE segments SET text")
            super().generic_visit(node)

    Visitor().visit(tree)
    return found


def _scan() -> dict[str, list[str]]:
    sites: dict[str, list[str]] = {}
    for path in app_files(floor=100, sentinels=(
        "services/segment_operations.py", "routers/segments.py", "routers/documents.py",
        "routers/observations.py", "services/withdrawal_redaction.py",
    )):
        rel = path.relative_to(APP_DIR).as_posix()
        for func, kinds in _writes(ast.parse(path.read_text())).items():
            sites[f"{rel}::{func}"] = kinds
    return sites


def _function(rel_and_name: str) -> ast.AST:
    rel, qualname = rel_and_name.split("::")
    tree = ast.parse((APP_DIR / rel).read_text())
    node: ast.AST = tree
    for part in qualname.split("."):
        node = next(
            n for n in ast.iter_child_nodes(node)
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == part
        )
    return node


def _calls(node: ast.AST) -> set[str]:
    names = set()
    for n in ast.walk(node):
        if isinstance(n, ast.Call):
            if isinstance(n.func, ast.Name):
                names.add(n.func.id)
            elif isinstance(n.func, ast.Attribute):
                names.add(n.func.attr)
    return names


def test_every_in_place_text_write_is_a_decided_one():
    sites = _scan()
    unknown = sorted(set(sites) - set(ALLOWLIST))
    assert not unknown, (
        f"New in-place write(s) of a `.text` attribute: {unknown}. If it is a "
        "Segment's text, it moves every char-range quote on that segment onto other "
        "words (#1319) — route it through services/segment_operations.py::"
        "apply_text_edit. If it is not a Segment, or it cannot leave a quote behind, "
        "add it to ALLOWLIST with the reason."
    )


def test_the_allowlist_has_no_stale_entries():
    """Non-empty expected set, so a scan gone blind fails here (tests/the internal design notes #729)."""
    stale = sorted(set(ALLOWLIST) - set(_scan()))
    assert not stale, f"ALLOWLIST names writes the scan no longer finds: {stale}"


def test_both_edit_doors_and_their_previews_go_through_the_planner():
    missing = {
        site: call for site, call in TEXT_EDIT_DOORS.items()
        if call not in _calls(_function(site))
    }
    assert not missing, (
        f"These text-edit paths no longer make their call: {missing}. A door that "
        "writes text without planning its quotes is #1319 again."
    )


def test_the_doors_themselves_write_no_text():
    """The doors DELEGATE the write; a door assigning `.text` itself bypasses the plan
    even while it still calls the planner somewhere."""
    sites = _scan()
    for door in ("routers/segments.py::update_segment", "routers/documents.py::update_document_segment"):
        assert door not in sites, f"{door} writes text itself: {sites[door]}"


# ── Guard the guard ──────────────────────────────────────────────────────────

PLANTED = {
    "plain": "def f(seg):\n    seg.text = 'x'\n",
    "tuple": "def f(seg, n):\n    seg.text, n.word_count = 'x', 1\n",
    "augmented": "def f(seg):\n    seg.text += 'x'\n",
    "annotated": "def f(seg):\n    seg.text: str = 'x'\n",
    "setattr": "def f(seg):\n    setattr(seg, 'text', 'x')\n",
    "bulk update": "def f(db):\n    db.query(Segment).update({Segment.text: 'x'})\n",
    "core update": "def f(db):\n    db.execute(update(Segment).values(text='x'))\n",
    "raw sql": "def f(db):\n    db.execute(text('UPDATE segments SET text = :t WHERE id = :i'))\n",
}


def test_the_predicate_fires_on_every_planted_form():
    """A PREDICATE falsifier per form: each planted write is found, under its function."""
    for label, source in PLANTED.items():
        assert list(_writes(ast.parse(source))) == ["f"], label


def test_the_predicate_ignores_reads():
    source = (
        "def f(seg, db):\n"
        "    t = seg.text\n"
        "    db.query(Segment.text).all()\n"
        "    return {'text': seg.text}\n"
    )
    assert _writes(ast.parse(source)) == {}


def test_the_blind_spots_are_absent_today():
    for path in app_files(floor=100):
        source = path.read_text()
        assert "bulk_update_mappings(Segment" not in source, path
        assert '__dict__["text"]' not in source and "__dict__['text']" not in source, path
