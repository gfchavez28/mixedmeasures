"""#1674 D356–D357 and #1676 D362–D363 — what a withdrawal does to a joint display, and how
often it reads the canvas to do it.

- D356: a pin of their quote loses its ``purpose`` with its quote — the researcher's line about
  why THAT quote is there ("the only Franklin teacher who opposed it") — in sections, snapshot
  copies and the search index. Someone else's pin keeps its line.
- D357: every drift stamp's figures are cleared (``hash`` and ``cells``), the date and the coder
  scope kept, ``cleared: "withdrawal"``; the report counts the stamps first.
- D362 / D363: the report reads the canvas ONCE, and the act reads it once (after the backup),
  where each count and each scrub used to parse every copy again.
"""
from __future__ import annotations

import json

from app.models.canvas import CanvasSnapshot, CanvasTheme
from app.models.participant import Participant
from app.services import canvas_embed_scrub as scrub
from app.services.canvas import create_snapshot
from app.services.withdrawal_report import build_withdrawal_report
from tests.test_joint_display_pins import _node, _pin, _pins_in, _section, _whole_quote
from tests.test_withdrawal_deleted_history import OLA, WREN, _project, _withdraw

PURPOSE = "Wren Ortiz, the only Franklin teacher who opposed it"
CELLS = {"variable:7:Franklin": "Opposed the merger 1, n 1", "code:3:Franklin": "1 of 1"}


def _discrepant(eid, text, group="High", purpose=PURPOSE):
    p = _pin(eid, text, group=group)
    p["role"] = "discrepant"
    p["purpose"] = purpose
    return p


def _stamped(node: dict, stamp: dict) -> dict:
    for row in node["attrs"]["display"]["rows"]:
        row["baseline"] = json.loads(json.dumps(stamp))
    return node


def _stamps_in(doc_json: str) -> list:
    doc = json.loads(doc_json)
    out = []
    for node in doc["content"]:
        if node.get("type") == "joint-display":
            out += [r.get("baseline") for r in node["attrs"]["display"]["rows"]]
    return out


STAMP = {"hash": "h", "cells": CELLS, "stamped_at": "2026-11-15", "scope": "all"}


class TestD356APinsPurposeGoesWithTheirQuote:
    def test_in_the_section_and_its_index_and_someone_elses_stays(self, db_session):
        db = db_session
        _project(db)
        wren, ola = _whole_quote(db, 1), _whole_quote(db, 2)
        _, theme_id = _section(db, _node(
            [_discrepant(wren.id, WREN), _discrepant(ola.id, OLA, group="Low", purpose="Ola control")]))
        assert PURPOSE in db.get(CanvasTheme, theme_id).searchable_text, "precondition: indexed"
        _withdraw(db)
        theme = db.get(CanvasTheme, theme_id)
        theirs, olas = _pins_in(theme.content)
        assert theirs["displayText"] != WREN
        assert theirs["purpose"] is None
        assert PURPOSE not in (theme.searchable_text or "")
        assert olas["purpose"] == "Ola control", "CONTROL: a pin not theirs keeps its line"

    def test_in_a_snapshot_copy(self, db_session):
        db = db_session
        _project(db)
        wren = _whole_quote(db, 1)
        canvas_id, _ = _section(db, _node([_discrepant(wren.id, WREN)]))
        create_snapshot(db, canvas_id, "Before")
        _withdraw(db)
        (copy,) = json.loads(db.query(CanvasSnapshot).one().snapshot_data)["themes"]
        (pin,) = _pins_in(copy["content"])
        assert pin["purpose"] is None
        assert PURPOSE not in (copy.get("searchable_text") or "")


class TestD357EveryDriftStampIsCleared:
    def test_section_and_snapshot_cleared_counted_first_date_and_scope_kept(self, db_session):
        db = db_session
        _project(db)
        ola = _whole_quote(db, 2)
        # A display that draws on nobody in particular, and one already cleared: every stamp
        # with figures goes (D357's over-clearing is deliberate); a cleared one is not counted.
        canvas_id, theme_id = _section(
            db, _stamped(_node([_pin(ola.id, OLA)]), STAMP),
            _stamped(_node([]), {"stamped_at": "2026-11-01", "cleared": "withdrawal"}))
        create_snapshot(db, canvas_id, "Before")
        report = build_withdrawal_report(db, db.get(Participant, 1))
        assert report.canvas_drift_stamps == 2, "the section's stamp and the snapshot's copy"
        out = _withdraw(db)
        assert out.canvas_drift_stamps_cleared == report.canvas_drift_stamps
        live, old = _stamps_in(db.get(CanvasTheme, theme_id).content)
        assert live == {"stamped_at": "2026-11-15", "scope": "all", "cleared": "withdrawal"}
        assert old == {"stamped_at": "2026-11-01", "cleared": "withdrawal"}
        (copy,) = json.loads(db.query(CanvasSnapshot).one().snapshot_data)["themes"]
        snap_live, _ = _stamps_in(copy["content"])
        assert snap_live == {"stamped_at": "2026-11-15", "scope": "all", "cleared": "withdrawal"}
        assert "Opposed the merger" not in db.get(CanvasTheme, theme_id).content

    def test_CONTROL_no_stamp_no_count(self, db_session):
        db = db_session
        _project(db)
        _section(db, _node([]))
        assert build_withdrawal_report(db, db.get(Participant, 1)).canvas_drift_stamps == 0
        assert _withdraw(db).canvas_drift_stamps_cleared == 0


class TestTheCanvasIsReadOnce:
    def _count_reads(self, monkeypatch):
        calls = []
        real = scrub._read_copies

        def spy(*a, **k):
            calls.append(1)
            return real(*a, **k)

        monkeypatch.setattr(scrub, "_read_copies", spy)
        return calls

    def test_D362_the_report_parses_every_copy_once(self, db_session, monkeypatch):
        db = db_session
        _project(db)
        _section(db, _stamped(_node([_pin(_whole_quote(db, 2).id, OLA)]), STAMP))
        calls = self._count_reads(monkeypatch)
        build_withdrawal_report(db, db.get(Participant, 1))
        assert len(calls) == 1, f"the report parsed the canvas {len(calls)} times"

    def test_D363_the_act_parses_every_copy_once(self, db_session, monkeypatch):
        db = db_session
        _project(db)
        _section(db, _stamped(_node([_discrepant(_whole_quote(db, 1).id, WREN)]), STAMP))
        calls = self._count_reads(monkeypatch)
        out = _withdraw(db)
        assert len(calls) == 1, f"the act parsed the canvas {len(calls)} times"
        assert out.canvas_embeds_scrubbed == 1 and out.canvas_drift_stamps_cleared == 1, (
            "the shared copies carried all three passes' writes")
