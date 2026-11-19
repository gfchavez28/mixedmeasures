"""#1671 D351 — a saved rule's GROUP condition naming a group the display does not have now.

Reached by changing *Compare groups by* (the builder asks first since D350, and clears nothing),
by relabelling the grouping variable's answers, or by a group losing its last member. Before
D351 the condition matched nobody with no reason, so the case view read "0 of 15 cases meet the
rule" as a finding. Now it is `group_missing`, decided by the server given the current groups,
with the groups it names on the wire (the 2026-11-17c audit's R1 probe, made a test).

Fixture: three groups (Low / Medium / High) of five people, an ordinal grouping variable.
"""
from __future__ import annotations

import json

from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.conversation import Conversation
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.participant import Participant
from app.models.project import Project
from app.models.segment import Segment
from app.models.speaker import Speaker
from app.services import joint_display as jd
from app.services.joint_display_cases import (
    CaseBinding, MISFIT_RULE_GROUP_MISSING, MISFIT_RULE_REFERENCE_MISSING, read_cases,
)

PID = 7171
DS = 7171
GRP, AGREE = 71711, 71712
SCALE = ["Disagree", "Neutral", "Agree"]
LEVELS = ["Low", "Medium", "High"]


def _col(cid, name, order, labels):
    return DatasetColumn(id=cid, dataset_id=DS, column_code=name, column_name=name, column_text=name,
                         column_type=ColumnType.ORDINAL, sequence_order=order, display_order=order,
                         scale_labels=json.dumps(labels),
                         scale_values=json.dumps(list(range(1, len(labels) + 1))),
                         scale_points=len(labels))


def _build(db):
    db.add(Project(id=PID, name="Groups", user_id=1))
    db.flush()
    db.add(Dataset(id=DS, project_id=PID, name="Survey"))
    db.flush()
    db.add_all([_col(GRP, "Level", 0, LEVELS), _col(AGREE, "Agreement", 1, SCALE)])
    db.add(Conversation(id=PID, project_id=PID, name="c"))
    db.add(Code(id=PID, project_id=PID, numeric_id=1, name="K", is_universal=False, is_active=True))
    db.flush()
    n = 0
    for i, level in enumerate(LEVELS):
        for _ in range(5):
            n += 1
            pid = PID * 10 + n
            db.add(Participant(id=pid, project_id=PID, identifier=f"P{n}"))
            db.flush()
            db.add(DatasetRow(id=pid, dataset_id=DS, row_identifier=f"P{n}", participant_id=pid))
            db.flush()
            db.add_all([
                DatasetValue(row_id=pid, column_id=GRP, value_text=level, value_numeric=float(i + 1)),
                DatasetValue(row_id=pid, column_id=AGREE, value_text=SCALE[n % 3],
                             value_numeric=float(n % 3 + 1)),
            ])
            db.add(Speaker(id=pid, project_id=PID, name=f"S{n}", is_facilitator=0, color_index=0,
                           participant_id=pid))
            db.flush()
            seg = Segment(id=PID * 100 + n, conversation_id=PID, sequence_order=n, text="t",
                          word_count=1, speaker_id=pid)
            db.add(seg)
            db.flush()
            db.add(CodeApplication(segment_id=seg.id, code_id=PID, user_id=1))
    db.flush()


def _read(db, rule):
    return read_cases(db, PID, group_by_column_id=GRP,
                      strands=[jd.StrandRequest("codes", jd.STRAND_KIND_CODES),
                               jd.StrandRequest("variables", jd.STRAND_KIND_VARIABLES)],
                      bindings={"codes": CaseBinding((PID,), ()), "variables": CaseBinding((), (AGREE,))},
                      coder_ids=None, layer_scope=None, rule=rule, only="list",
                      added_participant_ids=[], removed_participant_ids=[], offset=0, limit=50)


def test_CONTROL_a_present_group_selects_its_cases(db_session):
    _build(db_session)
    out = _read(db_session, [{"kind": "group", "group": "High"}])
    assert out["matched"] == 5 and out["rule_unavailable_reason"] is None
    assert out["rule_missing_groups"] == []


def test_a_gone_group_is_said_never_counted_as_zero(db_session):
    _build(db_session)
    out = _read(db_session, [{"kind": "group", "group": "High gain"}])  # an OLD grouping's label
    assert out["rule_unavailable_reason"] == MISFIT_RULE_GROUP_MISSING
    assert out["rule_missing_groups"] == ["High gain"]
    assert out["matched"] is None, "no count: a rule that cannot run selects nothing to count"


def test_a_group_that_lost_its_last_member_is_gone_too(db_session):
    db = db_session
    _build(db)
    db.query(DatasetValue).filter(DatasetValue.column_id == GRP, DatasetValue.value_text == "High") \
        .update({DatasetValue.value_text: "Medium"}, synchronize_session=False)
    db.flush()
    out = _read(db, [{"kind": "group", "group": "High"}])
    assert out["rule_unavailable_reason"] == MISFIT_RULE_GROUP_MISSING
    assert out["rule_missing_groups"] == ["High"]


def test_a_gone_variable_keeps_its_own_reason(db_session):
    _build(db_session)
    out = _read(db_session, [{"kind": "variable", "column_id": 999999, "op": "missing"}])
    assert out["rule_unavailable_reason"] == MISFIT_RULE_REFERENCE_MISSING
    assert out["rule_missing_groups"] == []
