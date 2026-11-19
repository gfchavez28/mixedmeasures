"""#1675 D359 — Text Coding's record context withholds the participant table's rating columns
while blind, as the Data view and the profile do.

The case (the 2026-11-17c audit's R6): a researcher adds an open-text *Notes* variable to the
participant table, which Text Coding lists, so a blind coder coding it opens a record whose
context showed *"Shared theme (score): 4.000"* — Ben's score, which is Bob's rating alone.

Fixture: #1615's `analysed` (Ana 3.5 = Alice 2 + Bob 5; Ben 4.0 = Bob's 4 alone).
"""
from __future__ import annotations

from app.models.dataset import ColumnType, DatasetColumn, DatasetRow, DatasetValue
from tests.test_blind_file_scope_1530 import ALICE, BOB, PID, _run, _user, blind_project, scored_project  # noqa: F401
from tests.test_blind_rating_analysis_1615 import analysed  # noqa: F401


def _ben_context(analysed, coder_ids):
    from app.routers.text_coding import record_context

    db, ds = analysed["db"], analysed["dataset"]
    if not db.query(DatasetColumn).filter_by(id=16199).first():
        db.add(DatasetColumn(id=16199, dataset_id=ds.id, column_code="notes", column_name="Notes",
                             column_text="Notes", column_type=ColumnType.OPEN_TEXT, source="manual",
                             sequence_order=70, display_order=70))
        db.flush()
    ben_row = (db.query(DatasetRow.id).filter(DatasetRow.dataset_id == ds.id,
               DatasetRow.participant_id == analysed["ben"].id).scalar())
    if not db.query(DatasetValue).filter_by(row_id=ben_row, column_id=16199).first():
        db.add(DatasetValue(row_id=ben_row, column_id=16199, value_text="Ben was late"))
        db.flush()
    ctx = _run(record_context(project_id=PID, dataset_row_id=ben_row, user=_user(db), db=db,
                              coder_ids=coder_ids))
    shown = {c.column_id: c.value for c in [*ctx.other_columns, *ctx.demographics]}
    positions = {c.column_id for c in ctx.column_positions}
    return ctx, shown, positions


def test_blind_the_score_and_its_count_are_left_out_and_counted(analysed):
    ctx, shown, positions = _ben_context(analysed, coder_ids=str(ALICE))
    assert shown.get(analysed["age"].id) == "40", "control: an ordinary column is still shown"
    assert analysed["score"].id not in shown, "Ben's score is Bob's rating — a blind Alice must not see it"
    assert analysed["score"].id not in positions, "nor its place in the record"
    assert ctx.withheld_rating_columns >= 2, "the score and its rated-passage count, counted"


def test_unscoped_every_cell_is_shown_as_before(analysed):
    ctx, shown, _ = _ben_context(analysed, coder_ids=None)
    assert analysed["score"].id in shown, "CONTROL: with no scope the record shows its score"
    assert ctx.withheld_rating_columns == 0


def test_a_scope_holding_every_rater_withholds_nothing(analysed):
    ctx, shown, _ = _ben_context(analysed, coder_ids=f"{ALICE},{BOB}")
    assert analysed["score"].id in shown
    assert ctx.withheld_rating_columns == 0
