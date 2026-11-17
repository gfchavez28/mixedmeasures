"""#1653 (D346, D347) — what the joint display's reads say when a variable they name is gone.

**D346 — the *Also show* variable (`display.attribution.column_id`).** `pin-facts` resolved it with
`grouping_column`; with it deleted the route answered **404** (MEASURED by the review's probe), the
client marked the whole read failed, and every pinned quote lost who said it and where with the
value — "Its attribution could not be read." in the display and every export. A retype to a type
that cannot form groups refused **400** the same way. Now every pin keeps its facts, `column_value`
is null, and the answer says why: `column_unusable` = "gone" / "ineligible" (with the name).

**D347 — the grouping variable.** The pin picker's `passages` and the case view's `cases` answered
its 404 in plain text; the compute had sent `{"code": GROUPING_GONE}` since D324. They send it now.
⚠️ `pin-facts` does NOT: its variable is the attribution variable, never the grouping one (the
filed Direction was refuted by the review there).
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.models.dataset import ColumnType
from app.models.excerpt import Excerpt
from app.routers.joint_display import case_rows, passages, pin_attribution_facts
from app.schemas.joint_display import (
    JointDisplayCasesRequest,
    JointDisplayPassagesRequest,
    JointDisplayPinFactsRequest,
    JointDisplayPinFactsResponse,
)
from app.services import joint_display as jd
from app.services import joint_display_pins as jdp
from tests.test_joint_display_id_reuse_1639 import _user, _World


def _quote(w: _World) -> int:
    """A whole quote of H1's turn — a pin's `excerptId`."""
    seg = w.turn(w.conv, "H1", [w.planning], text="We planned every week.")
    ex = Excerpt(project_id=w.pid, segment_id=seg.id)
    w.db.add(ex)
    w.db.flush()
    return ex.id


def _school(w: _World):
    return w.column("School", ColumnType.NOMINAL,
                    {"H1": "North", "H2": "North", "L1": "South", "L2": "South"})


def _facts(w: _World, excerpt_id: int, column_id: int | None) -> dict:
    out = pin_attribution_facts(
        w.pid, JointDisplayPinFactsRequest(excerpt_ids=[excerpt_id], column_id=column_id),
        user=_user(w.db), db=w.db)
    JointDisplayPinFactsResponse.model_validate(out)  # the wire carries every key (extra='forbid')
    return out


def _who(pin: dict) -> tuple:
    return pin["participant_identifier"], pin["source_name"]


def test_control_a_live_variable_is_read(db_session):
    w = _World(db_session)
    eid, school = _quote(w), _school(w)
    out = _facts(w, eid, school.id)
    assert out["column_unusable"] is None and out["column_name"] is None
    [pin] = out["pins"]
    assert _who(pin) == ("H1", "Interview A") and pin["column_value"] == "North"


def test_a_deleted_attribution_variable_keeps_who_and_where(db_session):
    w = _World(db_session)
    eid, school = _quote(w), _school(w)
    gone = school.id
    w.db.delete(school)
    w.db.flush()
    out = _facts(w, eid, gone)
    assert out["column_unusable"] == jdp.PIN_ATTRIBUTION_GONE == "gone"
    assert out["column_name"] is None and out["column_withheld"] is False
    [pin] = out["pins"]
    assert _who(pin) == ("H1", "Interview A"), pin  # the provenance survives the variable
    assert pin["column_value"] is None


def test_an_attribution_variable_that_cannot_form_groups_keeps_who_and_where(db_session):
    w = _World(db_session)
    eid, school = _quote(w), _school(w)
    school.column_type = ColumnType.NUMERIC  # the Variables view's retype
    w.db.flush()
    out = _facts(w, eid, school.id)
    assert out["column_unusable"] == jdp.PIN_ATTRIBUTION_INELIGIBLE == "ineligible"
    assert out["column_name"] == "School"
    [pin] = out["pins"]
    assert _who(pin) == ("H1", "Interview A") and pin["column_value"] is None


def test_no_attribution_variable_is_nothing_to_say(db_session):
    w = _World(db_session)
    out = _facts(w, _quote(w), None)
    assert out["column_unusable"] is None and out["pins"][0]["column_value"] is None


def test_pin_facts_never_answers_as_the_grouping_variable(db_session):
    """D347's ⚠️: no 404 at all now, and certainly not `GROUPING_GONE`."""
    w = _World(db_session)
    eid, school = _quote(w), _school(w)
    gone = school.id
    w.db.delete(school)
    w.db.flush()
    out = _facts(w, eid, gone)
    assert jd.GROUPING_GONE not in str(out)


def _gone_grouping(w: _World) -> int:
    gone = w.group.id
    w.db.delete(w.group)
    w.db.flush()
    return gone


def test_the_pin_pickers_passages_name_a_gone_grouping_variable(db_session):
    w = _World(db_session)
    gone = _gone_grouping(w)
    with pytest.raises(HTTPException) as refused:
        passages(w.pid, JointDisplayPassagesRequest(group_by_column_id=gone, group="H",
                                                    code_id=w.planning.id),
                 user=_user(w.db), db=w.db)
    assert refused.value.status_code == 404
    assert refused.value.detail["code"] == jd.GROUPING_GONE


def test_the_case_views_cases_name_a_gone_grouping_variable(db_session):
    w = _World(db_session)
    gone = _gone_grouping(w)
    with pytest.raises(HTTPException) as refused:
        case_rows(w.pid, JointDisplayCasesRequest(group_by_column_id=gone, row_key="r1"),
                  user=_user(w.db), db=w.db)
    assert refused.value.status_code == 404
    assert refused.value.detail["code"] == jd.GROUPING_GONE


def test_control_another_grouping_refusal_stays_plain(db_session):
    """A grouping variable that EXISTS but cannot form groups is a 400 in words, never 'gone'."""
    w = _World(db_session)
    w.group.column_type = ColumnType.NUMERIC
    w.db.flush()
    with pytest.raises(HTTPException) as refused:
        passages(w.pid, JointDisplayPassagesRequest(group_by_column_id=w.group.id, group="H",
                                                    code_id=w.planning.id),
                 user=_user(w.db), db=w.db)
    assert refused.value.status_code == 400 and isinstance(refused.value.detail, str)
