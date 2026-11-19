"""#1672 D353 — a drift stamp's coder scope crosses an import through the coders remap.

The client compares a stamp only within the coder view it was read under (`rowDriftState`). The
scope is ``"all"`` or a ``users.id`` — install-global — so an import remaps it as it remaps a
meta-inference's ``author_id``, and DROPS one whose coder did not travel: it then reads as
unknown and nothing is compared under it, where a kept id would name another coder here.
"""
from __future__ import annotations

import json

import tests.test_joint_display_node as jdn
from app.models.canvas import Canvas, CanvasTheme
from app.services import joint_display_node as node
from app.services.canvas import update_theme_content

MAP = {"coders": {1: 7}}


def _row(baseline: dict) -> dict:
    display = {"rows": [{"key": "r1", "construct": "T", "baseline": baseline}]}
    node.remap_display(display, lambda table, old: MAP.get(table, {}).get(old))
    return display["rows"][0]["baseline"]


class TestTheRemap:
    def test_a_coder_scope_is_remapped(self):
        assert _row({"hash": "h", "cells": {}, "stamped_at": "d", "scope": 1})["scope"] == 7

    def test_a_coder_who_did_not_travel_drops_the_scope(self):
        out = _row({"hash": "h", "cells": {}, "stamped_at": "d", "scope": 2})
        assert "scope" not in out
        assert out["hash"] == "h", "only the scope goes"

    def test_every_coder_and_an_absent_scope_are_kept_as_they_are(self):
        assert _row({"hash": "h", "cells": {}, "stamped_at": "d", "scope": "all"})["scope"] == "all"
        assert "scope" not in _row({"hash": "h", "cells": {}, "stamped_at": "d"})

    def test_a_cleared_stamp_keeps_its_date_and_scope(self):
        out = _row({"stamped_at": "2026-11-15", "cleared": "withdrawal", "scope": "all"})
        assert out == {"stamped_at": "2026-11-15", "cleared": "withdrawal", "scope": "all"}


class TestARealImport:
    def test_the_scope_lands_on_the_same_person(self, db_session):
        db = db_session
        rt = jdn.TestARoundTrip()
        pid, _ = rt._project(db)
        theme = db.query(CanvasTheme).join(Canvas).filter(Canvas.project_id == pid).one()
        doc = json.loads(theme.content)
        rows = doc["content"][0]["attrs"]["display"]["rows"]
        rows[0]["baseline"] = {"hash": "h", "cells": {}, "stamped_at": "2026-11-15", "scope": 1}
        rows[1]["baseline"] = {"hash": "h", "cells": {}, "stamped_at": "2026-11-15", "scope": 2}
        update_theme_content(db, theme, doc)
        db.flush()

        new_pid = rt._import(db, pid)
        new = db.query(CanvasTheme).join(Canvas).filter(Canvas.project_id == new_pid).one()
        first, second = json.loads(new.content)["content"][0]["attrs"]["display"]["rows"]
        assert first["baseline"]["scope"] == 1, "a coder in the file resolves (the same install)"
        assert "scope" not in second["baseline"], "a coder not in the file is dropped, never kept"
