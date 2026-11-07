"""#1421 — a demographic group with no segments in the material compared has no share.

The qualitative group comparison divides each code's coded segments by the group's
segments. A group can hold participants with a demographic value and still have NO
segment in the comparison — the service reported its share as ``0.0``, the two-group
difference as the other group's whole share, and sorted every code by that
manufactured difference.

Reachability was INFERRED in the filed entry; the 2026-10-26 pre-implementation review
EXECUTED it through the real service and found FOUR doors, each parametrised below:
a participant surveyed but never a speaker; one who speaks only in an UNSELECTED
conversation; one whose only speaker is a facilitator (excluded by default); one linked
through a DOCUMENT (the comparison counted conversations only until #1298, 1.5.9 — the
door is now a linked document the researcher did not select).

⚠️ Every assertion has a control a mutant must also get past: a REAL zero (a group WITH
segments and none coded this code) stays ``0.0`` with no reason, and the non-empty
group's shares are untouched.
"""
import asyncio
import csv
import io
import json

import pytest

from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.conversation import Conversation
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.document import Document
from app.models.participant import Participant
from app.models.project import Project
from app.models.segment import Segment
from app.models.speaker import Speaker
from app.models.user import User
from app.schemas.code_analysis import DemographicComparisonResponse
from app.services.code_analysis import get_demographic_comparison
from app.services.comparison_basis import COMPARISON_UNIT_PARTICIPANT, COMPARISON_UNIT_PASSAGE
from app.services.undefined_stats import NO_SEGMENTS, UNDEFINED_REASONS

# #1323 (1.5.9): the comparison counts PARTICIPANTS by default. This file's fixture
# is passage-shaped (one person, four turns), so its SHARE assertions name the
# passage unit; the empty-group rule is unit-agnostic and is asserted in both.
PASSAGES = {"unit": COMPARISON_UNIT_PASSAGE}

PID = 1421
C1, C2 = 14211, 14212
A, B, C = 14290, 14291, 14292  # codebook order A, B, C


def _person(db, pid, ident, value):
    db.add(Participant(id=pid, project_id=PID, identifier=ident))
    db.flush()
    db.add(DatasetRow(id=pid, dataset_id=PID, row_identifier=ident, participant_id=pid))
    db.flush()
    db.add(DatasetValue(row_id=pid, column_id=PID, value_text=value))
    db.flush()


@pytest.fixture
def project(db_session):
    """"Interviewed" speaks four segments in C1: A on one, B on three, C on none.

    B is LATER in the codebook and MORE prevalent, so a sort by a manufactured
    difference (B's 0.75 first) and the codebook order (A first) disagree."""
    db = db_session
    db.add(Project(id=PID, name="P1421", user_id=1))
    db.flush()
    db.add(Dataset(id=PID, project_id=PID, name="Survey"))
    db.flush()
    db.add(DatasetColumn(id=PID, dataset_id=PID, column_code="Mode", column_name="Mode",
                         column_text="Mode", column_type=ColumnType.DEMOGRAPHIC,
                         sequence_order=0, display_order=0))
    db.add_all([Conversation(id=C1, project_id=PID, name="C1"),
                Conversation(id=C2, project_id=PID, name="C2")])
    db.flush()
    _person(db, 14201, "P-int", "Interviewed")
    db.add(Speaker(id=14201, project_id=PID, name="P-int", is_facilitator=0, color_index=1,
                   participant_id=14201))
    db.flush()
    db.add_all([Segment(id=14210 + i, conversation_id=C1, sequence_order=i, text=f"s{i}",
                        word_count=1, speaker_id=14201) for i in range(4)])
    db.add_all([Code(id=A, project_id=PID, numeric_id=1, name="A", is_universal=False, is_active=True),
                Code(id=B, project_id=PID, numeric_id=2, name="B", is_universal=False, is_active=True),
                Code(id=C, project_id=PID, numeric_id=3, name="C", is_universal=False, is_active=True)])
    db.flush()
    db.add_all([CodeApplication(segment_id=14210, code_id=A, user_id=1),
                CodeApplication(segment_id=14211, code_id=B, user_id=1),
                CodeApplication(segment_id=14212, code_id=B, user_id=1),
                CodeApplication(segment_id=14213, code_id=B, user_id=1)])
    db.flush()
    return db


# ── The four doors: each returns (group label, extra service kwargs) ───────────

def _survey_only(db):
    _person(db, 14202, "P-survey", "Survey only")
    return "Survey only", {}


def _unselected_conversation(db):
    _person(db, 14203, "P-c2", "Elsewhere")
    db.add(Speaker(id=14203, project_id=PID, name="P-c2", is_facilitator=0, color_index=2,
                   participant_id=14203))
    db.flush()
    db.add(Segment(id=14220, conversation_id=C2, sequence_order=0, text="x", word_count=1,
                   speaker_id=14203))
    db.flush()
    db.add(CodeApplication(segment_id=14220, code_id=A, user_id=1))
    db.flush()
    return "Elsewhere", {"conversation_ids": [C1]}


def _facilitator_only(db):
    _person(db, 14204, "P-staff", "Staff")
    db.add(Speaker(id=14204, project_id=PID, name="P-staff", is_facilitator=1, color_index=3,
                   participant_id=14204))
    db.flush()
    db.add(Segment(id=14230, conversation_id=C1, sequence_order=20, text="q", word_count=1,
                   speaker_id=14204))
    db.flush()
    return "Staff", {"exclude_facilitator": True}


def _document_only(db):
    """#1298 (1.5.9): a linked document COUNTS now, so this door is a document the
    researcher did not select (`document_ids=[]`) — `test_comparison_unit_1323.py`
    pins that the same document, selected, fills the group."""
    _person(db, 14205, "P-doc", "Written")
    db.add(Document(id=14250, project_id=PID, name="Essay", source_filename="e.txt",
                    source_format="txt", participant_id=14205))
    db.flush()
    db.add(Segment(id=14250, document_id=14250, sequence_order=0, text="para"))
    db.flush()
    db.add(CodeApplication(segment_id=14250, code_id=A, user_id=1))
    db.flush()
    return "Written", {"document_ids": []}


DOORS = [_survey_only, _unselected_conversation, _facilitator_only, _document_only]


@pytest.mark.parametrize("unit", [COMPARISON_UNIT_PASSAGE, COMPARISON_UNIT_PARTICIPANT])
@pytest.mark.parametrize("door", DOORS, ids=lambda f: f.__name__.lstrip("_"))
def test_a_group_with_no_segments_has_no_share_and_no_difference(project, door, unit):
    empty, kwargs = door(project)
    r = get_demographic_comparison(project, PID, group_by_subtype="Mode", unit=unit, **kwargs)

    assert set(r["groups"]) == {"Interviewed", empty}
    assert r["group_totals"][empty]["total_segments"] == 0, "the door must really empty the group"
    assert r["group_totals"][empty]["n"] == 0
    by_code = {e["code_name"]: e for e in r["codes"]}
    for name in ("A", "B", "C"):
        cell = by_code[name]["by_group"][empty]
        assert cell == {"count": 0, "proportion": None, "undefined_reason": NO_SEGMENTS,
                        "passages": 0}, name
        assert by_code[name]["delta_proportion"] is None, f"{name}: a difference needs both shares"
        assert by_code[name]["test"] is None

    if unit != COMPARISON_UNIT_PASSAGE:
        return
    # Controls: the group WITH segments keeps every share, and a REAL zero survives.
    interviewed = {n: by_code[n]["by_group"]["Interviewed"] for n in ("A", "B", "C")}
    assert interviewed["A"] == {"count": 1, "proportion": 0.25, "undefined_reason": None, "passages": 1}
    assert interviewed["B"] == {"count": 3, "proportion": 0.75, "undefined_reason": None, "passages": 3}
    assert interviewed["C"] == {"count": 0, "proportion": 0.0, "undefined_reason": None, "passages": 0}


def test_no_code_is_ranked_by_a_manufactured_difference(project):
    """With no Δ anywhere the codebook order stands — B (the most prevalent in the one
    group that has segments) is NOT promoted to the top as the "biggest difference"."""
    _survey_only(project)
    r = get_demographic_comparison(project, PID, group_by_subtype="Mode", **PASSAGES)
    assert [e["code_name"] for e in r["codes"]] == ["A", "B", "C"]


def test_two_groups_with_segments_still_get_a_difference_and_a_real_zero(project):
    """The positive control for the whole file: no empty group, every share defined, a
    real 0.0 kept (Phone never used A), and the Δ sort still ranks."""
    _person(project, 14206, "P-phone", "Phone")
    project.add(Speaker(id=14206, project_id=PID, name="P-phone", is_facilitator=0,
                        color_index=4, participant_id=14206))
    project.flush()
    project.add_all([Segment(id=14260 + i, conversation_id=C1, sequence_order=40 + i,
                             text="p", word_count=1, speaker_id=14206) for i in range(2)])
    project.flush()
    project.add(CodeApplication(segment_id=14260, code_id=B, user_id=1))
    project.flush()
    r = get_demographic_comparison(project, PID, group_by_subtype="Mode", **PASSAGES)
    by_code = {e["code_name"]: e for e in r["codes"]}
    # ⚠️ Field by field, so this CONTROL passes on HEAD as well (HEAD has no reason key).
    phone_a = by_code["A"]["by_group"]["Phone"]
    assert (phone_a["count"], phone_a["proportion"], phone_a.get("undefined_reason")) == (0, 0.0, None)
    assert by_code["A"]["delta_proportion"] == 0.25   # Interviewed − Phone
    assert by_code["B"]["delta_proportion"] == 0.25   # 0.75 − 0.5
    assert by_code["C"]["delta_proportion"] == 0.0


def test_three_groups_one_empty_keeps_the_others_shares(project):
    _survey_only(project)
    _person(project, 14206, "P-phone", "Phone")
    project.add(Speaker(id=14206, project_id=PID, name="P-phone", is_facilitator=0,
                        color_index=4, participant_id=14206))
    project.flush()
    project.add_all([Segment(id=14260 + i, conversation_id=C1, sequence_order=40 + i,
                             text="p", word_count=1, speaker_id=14206) for i in range(5)])
    project.flush()
    r = get_demographic_comparison(project, PID, group_by_subtype="Mode", **PASSAGES)
    a = next(e for e in r["codes"] if e["code_name"] == "A")
    assert a["by_group"]["Survey only"]["proportion"] is None
    assert a["by_group"]["Survey only"]["undefined_reason"] == NO_SEGMENTS
    assert a["by_group"]["Phone"] == {"count": 0, "proportion": 0.0, "undefined_reason": None,
                                      "passages": 0}
    assert a["by_group"]["Interviewed"]["proportion"] == 0.25
    assert a["delta_proportion"] is None  # no Δ column beyond two groups, as before


def test_the_wire_carries_none_and_the_reason(project):
    """The response model must accept None (it declared `proportion: float`), and the
    payload must serialise with allow_nan=False — the #689 load-bearing assertion."""
    _survey_only(project)
    r = get_demographic_comparison(project, PID, group_by_subtype="Mode")
    model = DemographicComparisonResponse.model_validate(r)
    wire = json.loads(json.dumps(model.model_dump(mode="json"), allow_nan=False))
    cell = wire["codes"][0]["by_group"]["Survey only"]
    assert cell["proportion"] is None and cell["undefined_reason"] == NO_SEGMENTS
    assert NO_SEGMENTS in UNDEFINED_REASONS  # so the stat-format.ts contract test covers it


def _csv(db, **params):
    from app.routers.code_analysis import demographic_comparison_csv

    async def go():
        # A plain `def` endpoint since #1323's D11; only the streamed body is read async.
        resp = demographic_comparison_csv(
            project_id=PID, group_by_subtype="Mode", code_ids=None,
            conversation_ids=params.get("conversation_ids"), text_column_ids=None,
            exclude_facilitator=True, participant_ids=None, coder_ids=None,
            layer_scope=None, user=db.get(User, 1), db=db,
        )
        chunks = [c async for c in resp.body_iterator]
        return "".join(c if isinstance(c, str) else c.decode() for c in chunks)
    return list(csv.reader(io.StringIO(asyncio.run(go()))))


def test_the_csv_leaves_the_empty_groups_share_and_the_difference_blank(project):
    _survey_only(project)
    rows = _csv(project)
    header, body = rows[0], {r[0]: dict(zip(rows[0], r)) for r in rows[1:]}
    assert "Survey only (Proportion)" in header and "Delta" in header
    # #1323: the default unit is the participant, named in the column.
    assert body["B"]["Survey only (Participants who used it)"] == "0"
    assert body["B"]["Survey only (Participants with material)"] == "0"
    assert body["B"]["Survey only (Proportion)"] == ""
    assert body["B"]["Delta"] == ""
    # Controls: the group with material keeps its share (one participant, who used B
    # on three of four turns — 1 of 1, with the passages beside it); a real zero
    # prints as zero.
    assert body["B"]["Interviewed (Proportion)"] == "1.0000"
    assert body["B"]["Interviewed (Passages coded)"] == "3"
    assert body["C"]["Interviewed (Proportion)"] == "0.0000"
