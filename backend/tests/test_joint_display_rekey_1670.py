"""#1670 D349 — the server re-keys a joint display where IT copies one.

A display's `displayKey` identifies it on the page (its export table, its dialogs, the kept
open rows, view choice and drafts). A copy that keeps the key acts as the original in a page
session that opens both, so `duplicate_canvas` and the `.mmproject` import's canvas remap give
every display a fresh key; nothing else about the display changes. (The client's half, a paste
or drop, is `extensions/joint-display-rekey-1670.test.ts`.)
"""
from __future__ import annotations

import json

import tests.test_joint_display_node as jdn
from app.models.canvas import Canvas, CanvasTheme
from app.services import joint_display_node as node
from app.services.canvas import duplicate_canvas
from app.services.project_portability import _remap_canvas_content


def _two_display_doc() -> dict:
    return {"type": "doc", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": "Prose."}]},
        {"type": "joint-display", "attrs": {"displayKey": "k-1", "figureEpoch": 1,
                                            "display": jdn._display()}},
        {"type": "blockquote", "content": [
            {"type": "joint-display", "attrs": {"displayKey": "k-2", "figureEpoch": 2,
                                                "display": {"rows": []}}}]},
    ]}


def _keys(doc: dict) -> list:
    out = []

    def walk(n):
        if n.get("type") == node.JOINT_DISPLAY_NODE:
            out.append(n["attrs"]["displayKey"])
        for c in n.get("content", []) or []:
            walk(c)

    walk(doc)
    return out


class TestTheHelper:
    def test_every_display_nested_or_not_gets_a_fresh_key_and_nothing_else_moves(self):
        doc = _two_display_doc()
        before = json.loads(json.dumps(doc))
        fresh = iter(["new-1", "new-2"])
        assert node.rekey_displays(doc, lambda: next(fresh)) == 2
        assert _keys(doc) == ["new-1", "new-2"]
        for n in (doc, before):  # everything but the keys is as it was
            n["content"][1]["attrs"].pop("displayKey")
            n["content"][2]["content"][0]["attrs"].pop("displayKey")
        assert doc == before

    def test_the_default_mint_gives_distinct_uuids(self):
        doc = _two_display_doc()
        node.rekey_displays(doc)
        keys = _keys(doc)
        assert len(set(keys)) == 2 and "k-1" not in keys and all(len(k) == 36 for k in keys)

    def test_stored_text_without_a_display_or_unreadable_is_returned_unchanged(self):
        prose = json.dumps({"type": "doc", "content": [{"type": "paragraph"}]})
        assert node.rekey_displays_in_json(prose) is prose
        assert node.rekey_displays_in_json("{not json") == "{not json"
        assert node.rekey_displays_in_json(None) is None


class TestWhereTheServerCopies:
    def test_a_duplicated_canvas_re_keys_its_displays_and_leaves_the_original(self, db_session):
        db = db_session
        pid, _ = jdn.TestARoundTrip()._project(db)
        original = db.query(Canvas).filter_by(project_id=pid).one()
        theme = db.query(CanvasTheme).filter_by(canvas_id=original.id).one()
        before = json.loads(theme.content)

        copy = duplicate_canvas(db, pid, original)
        copied = json.loads(db.query(CanvasTheme).filter_by(canvas_id=copy.id).one().content)

        assert _keys(json.loads(theme.content)) == ["k"], "the original keeps its key"
        assert _keys(copied) != ["k"] and len(_keys(copied)) == 1
        assert (copied["content"][0]["attrs"]["display"]
                == before["content"][0]["attrs"]["display"]), "the display itself is copied"

    def test_the_import_re_keys_every_display(self, db_session):
        db = db_session
        rt = jdn.TestARoundTrip()
        pid, _ = rt._project(db)
        new_pid = rt._import(db, pid)
        theme = (db.query(CanvasTheme).join(Canvas)
                 .filter(Canvas.project_id == new_pid).one())
        keys = _keys(json.loads(theme.content))
        assert len(keys) == 1 and keys != ["k"]

    def test_the_canvas_remap_re_keys(self):
        content, _ = _remap_canvas_content(json.dumps(_two_display_doc()), {})
        keys = _keys(json.loads(content))
        assert len(set(keys)) == 2 and not {"k-1", "k-2"} & set(keys)
