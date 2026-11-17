"""#1667 (D340, D341) — the withdrawal report REFUSES an unreadable canvas copy, naming it.

`GET …/participants/{id}/withdrawal-report` reads every canvas copy (the unplaced quotes, D158;
the cases that don't fit, D314). One it could not read raised `CanvasScrubError` UNCAUGHT — a
500 — so both Participants-page confirms said only "Something went wrong", and the copy that
stood in the way reached the server log alone (MEASURED by the review's probe). Now:

- the route answers **409** with the scrub's sentence (D340) — the confirms show a refusal's
  words through `LoadState`, and keep the act unavailable;
- the sentence NAMES the copy — a section "Canvas › Section", a snapshot "of" its canvas, a
  display INSIDE either (it named none) — in the REPORT's words (D341): the report serves the
  delete confirm, the withdrawal confirm and the panel, so it claims neither act.

The delete's own refusal is `test_participant_delete_wording_1651.py`'s; the withdrawal act's
control is there too.
"""
from __future__ import annotations

import asyncio
import json

import pytest
from fastapi import HTTPException

from app.models.canvas import CanvasSnapshot
from app.models.user import User
from app.services import canvas_embed_scrub as scrub
from tests.test_joint_display_pins import _section
from tests.test_participant_delete_wording_1651 import _broken_display, _broken_section, _snapshot
from tests.test_withdrawal_deleted_history import _project

REPORT_TAIL = "so what it holds of this person cannot be checked."


def _report(db, participant_id=1):
    from app.routers.participants import get_withdrawal_report
    result = get_withdrawal_report(1, participant_id, user=db.get(User, 1), db=db)
    return asyncio.run(result) if asyncio.iscoroutine(result) else result


def _display_in_snapshot(db):
    """A snapshot whose section copy parses but holds a display it cannot walk."""
    canvas_id, _ = _section(db, {"type": "paragraph"})
    doc = {"type": "doc", "content": [{"type": "joint-display", "attrs": {"displayKey": "k", "display": {
        "rows": [{"key": "r", "pins": "not a list"}]}}}]}
    db.add(CanvasSnapshot(canvas_id=canvas_id, name="Before", theme_count=1,
                          snapshot_data=json.dumps({"themes": [{"content": json.dumps(doc)}]})))


SHAPES = {
    "section": (_broken_section, "The canvas section “Main › Findings” could not be read, "),
    "snapshot-json": (lambda db: _snapshot(db, "{not json"),
                      "The canvas snapshot “Before” of “Main” could not be read, "),
    "snapshot-not-an-object": (lambda db: _snapshot(db, "[1, 2]"),
                               "The canvas snapshot “Before” of “Main” could not be read, "),
    "snapshot-section": (lambda db: _snapshot(db, json.dumps({"themes": [{"content": "{bad"}]})),
                         "A section of the canvas snapshot “Before” of “Main” could not be read, "),
    "display-in-section": (_broken_display,
                           "A joint display in the canvas section “Main › Findings” could not be read, "),
    "display-in-snapshot": (_display_in_snapshot,
                            "A joint display in the snapshot “Before” of “Main” could not be read, "),
}


@pytest.mark.parametrize("shape", list(SHAPES))
def test_the_report_refuses_naming_the_copy_in_its_own_words(db_session, shape):
    db = db_session
    _project(db)
    plant, opening = SHAPES[shape]
    plant(db)
    db.flush()
    with pytest.raises(HTTPException) as refused:
        _report(db)
    assert refused.value.status_code == 409
    assert refused.value.detail == f"{opening}{REPORT_TAIL}", refused.value.detail
    # It serves both confirms and the panel: it claims neither act.
    assert "withdraw" not in refused.value.detail and "delete" not in refused.value.detail


def test_control_an_undamaged_canvas_is_reported(db_session):
    """Positive control: the same project, every copy readable — the report answers."""
    db = db_session
    _project(db)
    _section(db, {"type": "paragraph"})
    db.flush()
    report = _report(db)
    assert report["participant_id"] == 1
    assert report["canvas_misfit_cases"] == 0


def test_the_report_act_has_its_own_tail():
    """D341: the report's tail is neither act's."""
    tails = {scrub._unreadable(act, "copy") for act in (scrub.ACT_REPORT, scrub.ACT_WITHDRAWAL,
                                                         scrub.ACT_DELETE)}
    assert len(tails) == 3
    assert scrub._unreadable(scrub.ACT_REPORT, "copy") == REPORT_TAIL
