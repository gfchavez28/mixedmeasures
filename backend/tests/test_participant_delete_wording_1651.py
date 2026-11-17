"""#1651 (D338) — a plain participant delete refuses an unreadable canvas copy in ITS words.

`DELETE …/participants/{id}` walks the project's canvas for the joint displays' cases that
don't fit (D314), and a copy it cannot read refuses the delete (fail closed). Until #1651 the
refusal was the withdrawal's — *"…so a withdrawal cannot confirm it holds none of this
person's quotes"* — though nothing is being withdrawn and the delete never looks for quotes.
FOUR raises reach the delete (the filing named one): a section, a snapshot that does not parse,
a snapshot that is not an object, a snapshot's section, and a joint display it cannot walk.
Each is driven through the endpoint; the withdrawal keeps its own words (the control).
"""
from __future__ import annotations

import json

import pytest
from fastapi import HTTPException

from app.models.canvas import CanvasSnapshot, CanvasTheme
from app.models.participant import Participant
from app.models.user import User
from app.services import canvas_embed_scrub as scrub
from tests.test_joint_display_pins import _section
from tests.test_withdrawal_deleted_history import _project, _withdraw

DELETE_WORDS = ("cannot be checked whether a joint display there lists this person among its "
                "cases that don't fit.")
#: #1667 (D341): a DISPLAY is the damaged part, so its sentence names it once — it read "A joint
#: display on a canvas could not be read, so it cannot be checked whether a joint display there…".
DISPLAY_DELETE_WORDS = "cannot be checked whether it lists this person among its cases that don't fit."


def _delete(db, participant_id=1):
    from app.routers.participants import delete_participant
    return delete_participant(1, participant_id, user=db.get(User, 1), db=db)


def _broken_section(db):
    _, theme_id = _section(db, {"type": "paragraph"})
    db.get(CanvasTheme, theme_id).content = "{not json"


def _snapshot(db, data: str):
    canvas_id, _ = _section(db, {"type": "paragraph"})
    db.add(CanvasSnapshot(canvas_id=canvas_id, name="Before", snapshot_data=data, theme_count=1))


def _broken_display(db):
    _section(db, {"type": "joint-display", "attrs": {"displayKey": "k", "display": {
        "rows": [{"key": "r", "pins": [], "misfit": {"added": "not a list"}}]}}})


#: #1667 (D341): every opening NAMES its copy — a section with its canvas ("Main"), a snapshot
#: with its canvas — as the report's unplaced-quotes note names them.
SHAPES = {
    "section": (_broken_section, "The canvas section “Main › Findings” could not be read, ",
                DELETE_WORDS),
    "snapshot-json": (lambda db: _snapshot(db, "{not json"),
                      "The canvas snapshot “Before” of “Main” could not be read, ", DELETE_WORDS),
    "snapshot-not-an-object": (lambda db: _snapshot(db, "[1, 2]"),
                               "The canvas snapshot “Before” of “Main” could not be read, ",
                               DELETE_WORDS),
    "snapshot-section": (lambda db: _snapshot(db, json.dumps({"themes": [{"content": "{bad"}]})),
                         "A section of the canvas snapshot “Before” of “Main” could not be read, ",
                         DELETE_WORDS),
    "display": (_broken_display,
                "A joint display in the canvas section “Main › Findings” could not be read, ",
                DISPLAY_DELETE_WORDS),
}


@pytest.mark.parametrize("shape", list(SHAPES))
def test_the_delete_says_what_it_could_not_check_never_a_withdrawal(db_session, shape):
    db = db_session
    _project(db)
    plant, opening, tail = SHAPES[shape]
    plant(db)
    db.commit()  # the refusal rolls back: the planted copy must not be what it rolls back
    with pytest.raises(HTTPException) as refused:
        _delete(db)
    assert refused.value.status_code == 409
    detail = refused.value.detail
    assert detail == ("Could not delete this participant, so nothing was changed. "
                      f"{opening}so it {tail}"), detail
    assert detail.count("joint display") <= 1, detail  # D341: never "a joint display … a joint display there"
    assert "withdraw" not in detail and "quotes" not in detail
    db.expire_all()
    assert db.get(Participant, 1) is not None


@pytest.mark.parametrize("shape", ["section", "display"])
def test_control_the_withdrawal_keeps_its_own_words(db_session, shape):
    """…and names the copy too (#1667, D341): the withdraw act's 500 carries this sentence."""
    db = db_session
    _project(db)
    SHAPES[shape][0](db)
    with pytest.raises(scrub.CanvasScrubError) as refused:
        _withdraw(db)
    assert "so a withdrawal cannot confirm" in str(refused.value)
    assert str(refused.value).startswith(SHAPES[shape][1]), str(refused.value)


def test_an_unknown_act_is_refused_never_worded_as_either():
    with pytest.raises(ValueError):
        scrub._unreadable("export", "cases")


def test_every_act_has_every_tail():
    """Population: each act — the two acts and, since #1667 (D341), the report — words each
    thing that can fail to read: a whole copy, a display walked for quotes, one for cases."""
    for act in (scrub.ACT_WITHDRAWAL, scrub.ACT_DELETE, scrub.ACT_REPORT):
        for about in ("copy", "quotes", "cases"):
            assert scrub._unreadable(act, about).startswith("so ")
