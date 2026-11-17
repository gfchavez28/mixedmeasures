"""#1659 — a strand that is NOT MEASURED on a row says WHY, and the server decides it.

The compute derives `status: not_measured` when a strand draws nothing on a row (D169.2). The
Compact view printed "Not measured: no code bound" for every such strand — above the line
naming the bound code a merge had moved away, or the count of bound items deleted — and the
shared note said "nothing from this strand is bound to the construct". Both were true in one
case of four. The reason now rides the wire (`by_strand[key].not_measured_reason`, #823c: the
client never guesses), one per cause:

- nothing bound → ``nothing_bound`` (the one case the old words were true of);
- a survey comments strand none of whose questions is in the project → ``no_questions`` — a
  case NOTHING else on the screen named (`AnswerStrandGather.missing_columns` never reached
  the wire);
- every bound item deleted → ``bound_gone``; every bound code inactive (a merge) →
  ``bound_inactive``; every bound variable in another dataset than the strand reads (the
  builder keeps a row's variables when a strand's dataset changes) → ``bound_other_dataset``;
- more than one of those → ``bound_unavailable``.

A strand that draws something carries no reason. Each case is built through the data the
cause describes (a delete, a merge's deactivation, a second dataset), never a hand-set status.
"""
from __future__ import annotations

from app.models.dataset import ColumnType, Dataset, DatasetColumn
from app.schemas.joint_display import JointDisplayComputeResponse
from app.services import joint_display as jd
from tests.test_joint_display_id_reuse_1639 import HIGH, _World


def _compute(db, w, strands, bindings):
    rows = [jd.RowRequest(key="r1", bindings={
        k: jd.BindingRequest(code_ids=tuple(b.get("codes", ())), column_ids=tuple(b.get("columns", ())))
        for k, b in bindings.items()})]
    out = jd.compute_joint_display(db, w.pid, group_by_column_id=w.group.id, rows=rows,
                                   coder_ids=None, layer_scope="human", newcombe=False,
                                   strands=strands)
    # The field is DECLARED on the wire: pytest runs every schema with extra='forbid' (#855).
    JointDisplayComputeResponse.model_validate(out)
    return out["rows"][0]["by_strand"]


INT = jd.StrandRequest(key="s-int", kind=jd.STRAND_KIND_CODES)


def _svy(w, dataset=None):
    return jd.StrandRequest(key="s-svy", kind=jd.STRAND_KIND_VARIABLES, dataset_id=(dataset or w.roster).id)


def _answers(w, name="Comments"):
    """An open-text question every participant answered."""
    return w.column(name, ColumnType.OPEN_TEXT, {p: f"answer {p}" for p in w.people})


def test_nothing_bound_is_the_one_case_the_old_words_were_true_of(db_session):
    db = db_session
    w = _World(db)
    by = _compute(db, w, [INT, _svy(w)], {"s-int": {"codes": [w.planning.id]}, "s-svy": {}})
    assert by["s-int"]["status"] == jd.STRAND_COVERS
    assert by["s-int"]["not_measured_reason"] is None  # control: a covered strand gives none
    assert by["s-svy"]["status"] == jd.STRAND_NOT_MEASURED
    assert by["s-svy"]["not_measured_reason"] == jd.STRAND_NOT_MEASURED_NOTHING_BOUND


def test_a_deleted_bound_code_is_gone_not_unbound(db_session):
    db = db_session
    w = _World(db)
    gone = w.code("Budget")
    gone_id = gone.id
    db.delete(gone)
    db.flush()
    by = _compute(db, w, [INT], {"s-int": {"codes": [gone_id]}})
    assert by["s-int"]["status"] == jd.STRAND_NOT_MEASURED
    assert by["s-int"]["missing_code_ids"] == [gone_id]
    assert by["s-int"]["not_measured_reason"] == jd.STRAND_NOT_MEASURED_BOUND_GONE


def test_a_bound_code_a_merge_deactivated_is_inactive_not_unbound(db_session):
    db = db_session
    w = _World(db)
    trust = w.code("Trust")
    for ident in HIGH:
        w.turn(w.conv, ident, [trust])
    trust.is_active = False  # what the codebook's merge leaves the source (D325)
    db.flush()
    by = _compute(db, w, [INT], {"s-int": {"codes": [trust.id]}})
    assert by["s-int"]["status"] == jd.STRAND_NOT_MEASURED
    assert by["s-int"]["not_measured_reason"] == jd.STRAND_NOT_MEASURED_BOUND_INACTIVE


def test_a_deleted_code_and_an_inactive_code_together_are_unavailable(db_session):
    db = db_session
    w = _World(db)
    gone = w.code("Budget")
    gone_id = gone.id
    db.delete(gone)
    off = w.code("Trust")
    off.is_active = False
    db.flush()
    by = _compute(db, w, [INT], {"s-int": {"codes": [gone_id, off.id]}})
    assert by["s-int"]["not_measured_reason"] == jd.STRAND_NOT_MEASURED_BOUND_UNAVAILABLE


def test_one_live_code_beside_a_gone_one_is_measured(db_session):
    """Control: the reason is for a strand that draws NOTHING — a gone code beside a live one
    is the row's missing line's business, and the strand covers."""
    db = db_session
    w = _World(db)
    gone = w.code("Budget")
    gone_id = gone.id
    db.delete(gone)
    db.flush()
    by = _compute(db, w, [INT], {"s-int": {"codes": [w.planning.id, gone_id]}})
    assert by["s-int"]["status"] == jd.STRAND_COVERS
    assert by["s-int"]["not_measured_reason"] is None


def test_a_survey_comments_strand_whose_question_was_deleted_says_so(db_session):
    db = db_session
    w = _World(db)
    question = _answers(w)
    qid = question.id
    db.delete(question)
    db.flush()
    txt = jd.StrandRequest(key="s-txt", kind=jd.STRAND_KIND_TEXT_CODES, text_column_ids=(qid,))
    by = _compute(db, w, [INT, txt], {"s-int": {"codes": [w.planning.id]},
                                      "s-txt": {"codes": [w.planning.id]}})
    assert by["s-txt"]["status"] == jd.STRAND_NOT_MEASURED
    assert by["s-txt"]["not_measured_reason"] == jd.STRAND_NOT_MEASURED_NO_QUESTIONS
    assert by["s-txt"]["missing_code_ids"] == []  # the code is live: only the reason can say it


def test_control_the_same_strand_with_its_question_covers(db_session):
    db = db_session
    w = _World(db)
    question = _answers(w)
    txt = jd.StrandRequest(key="s-txt", kind=jd.STRAND_KIND_TEXT_CODES, text_column_ids=(question.id,))
    by = _compute(db, w, [INT, txt], {"s-int": {"codes": [w.planning.id]},
                                      "s-txt": {"codes": [w.planning.id]}})
    assert by["s-txt"]["status"] == jd.STRAND_COVERS
    assert by["s-txt"]["not_measured_reason"] is None


def test_a_survey_comments_strand_binding_nothing_is_nothing_bound_even_with_no_question(db_session):
    """Order: nothing bound is said first — the questions are moot for a strand that binds nothing."""
    db = db_session
    w = _World(db)
    txt = jd.StrandRequest(key="s-txt", kind=jd.STRAND_KIND_TEXT_CODES, text_column_ids=())
    by = _compute(db, w, [INT, txt], {"s-int": {"codes": [w.planning.id]}, "s-txt": {}})
    assert by["s-txt"]["not_measured_reason"] == jd.STRAND_NOT_MEASURED_NOTHING_BOUND


def test_a_variable_from_another_dataset_is_named_as_such_not_as_deleted(db_session):
    """A draft saved before #1665's builder fix keeps a row's variables of a survey strand's old
    dataset; the compute leaves them out (D205) and lists them in `other_dataset_column_ids`,
    never `missing_column_ids` (#1665, D336) — neither the reason nor the count may call a
    variable that is in the project "no longer in this project"."""
    db = db_session
    w = _World(db)
    other = Dataset(project_id=w.pid, name="Follow-up")
    db.add(other)
    db.flush()
    hours = w.column("Hours", ColumnType.NUMERIC, {p: "3" for p in w.people}, dataset=other)
    by = _compute(db, w, [INT, _svy(w)], {"s-int": {"codes": [w.planning.id]},
                                          "s-svy": {"columns": [hours.id]}})
    assert by["s-svy"]["status"] == jd.STRAND_NOT_MEASURED
    assert by["s-svy"]["other_dataset_column_ids"] == [hours.id]
    assert by["s-svy"]["missing_column_ids"] == []
    assert by["s-svy"]["not_measured_reason"] == jd.STRAND_NOT_MEASURED_BOUND_OTHER_DATASET
    # …and read under its own dataset, the same variable is drawn (the control)
    by = _compute(db, w, [INT, _svy(w, other)], {"s-int": {"codes": [w.planning.id]},
                                                 "s-svy": {"columns": [hours.id]}})
    assert by["s-svy"]["status"] == jd.STRAND_COVERS


def test_a_deleted_variable_is_gone(db_session):
    db = db_session
    w = _World(db)
    col = w.column("Hours", ColumnType.NUMERIC)
    cid = col.id
    db.delete(col)
    db.flush()
    assert db.get(DatasetColumn, cid) is None
    by = _compute(db, w, [INT, _svy(w)], {"s-int": {"codes": [w.planning.id]},
                                          "s-svy": {"columns": [cid]}})
    assert by["s-svy"]["not_measured_reason"] == jd.STRAND_NOT_MEASURED_BOUND_GONE
    assert by["s-svy"]["missing_column_ids"] == [cid]  # a deleted one IS missing (#1665's control)
    assert by["s-svy"]["other_dataset_column_ids"] == []


def test_a_deleted_variable_beside_another_datasets_is_each_in_its_own_list(db_session):
    """#1665 (D336): the two causes stay apart on the wire — the count of "no longer in this
    project" is the deleted one only — and together they are `bound_unavailable`."""
    db = db_session
    w = _World(db)
    other = Dataset(project_id=w.pid, name="Follow-up")
    db.add(other)
    db.flush()
    elsewhere = w.column("Hours", ColumnType.NUMERIC, {p: "3" for p in w.people}, dataset=other)
    gone = w.column("Minutes", ColumnType.NUMERIC)
    gone_id = gone.id
    db.delete(gone)
    db.flush()
    by = _compute(db, w, [INT, _svy(w)], {"s-int": {"codes": [w.planning.id]},
                                          "s-svy": {"columns": [elsewhere.id, gone_id]}})
    assert by["s-svy"]["missing_column_ids"] == [gone_id]
    assert by["s-svy"]["other_dataset_column_ids"] == [elsewhere.id]
    assert by["s-svy"]["not_measured_reason"] == jd.STRAND_NOT_MEASURED_BOUND_UNAVAILABLE


def test_every_reason_is_a_named_constant_the_client_mirrors():
    """The reasons are `STRAND_`-prefixed, so `test_joint_display_vocabulary.py` holds the
    client's `SERVER_VOCABULARY` equal to them; this pins that each one IS so prefixed."""
    reasons = {v for k, v in vars(jd).items() if k.startswith("STRAND_NOT_MEASURED_")}
    assert reasons == {"nothing_bound", "no_questions", "bound_gone", "bound_inactive",
                       "bound_other_dataset", "bound_unavailable"}
