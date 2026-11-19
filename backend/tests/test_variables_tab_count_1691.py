"""#1691 D377 — the *Variables N* badge counts every variable in the dataset, on both views.

The Variables view's badge is the columns list (`GET …/datasets/{id}/columns`), which lists
every variable, a rating score among them. The Data view's is `/data`, which leaves a blind
viewer's rating columns out and counts them as `withheld_rating_columns`. The client adds
the count back (`lib/blind-rating-columns.ts::variablesInDataset`), so the two badges agree
only if the withheld set is drawn from this dataset's own columns and nothing else
separates the two payloads. This pins that premise.

Fixture: #1615's `analysed` (Ana 3.5 = Alice 2 + Bob 5; Ben 4.0 = Bob's 4 alone) — a
participant table with a score, its rated-passage count and three ordinary variables.
"""
from __future__ import annotations

from tests.test_blind_file_scope_1530 import ALICE, BOB, PID, _run, _user, blind_project, scored_project  # noqa: F401
from tests.test_blind_rating_analysis_1615 import analysed  # noqa: F401


def _counts(analysed, coder_ids):
    from app.routers.dataset import get_dataset_data, list_columns

    db, ds = analysed["db"], analysed["dataset"]
    data = _run(get_dataset_data(PID, ds.id, limit=200, offset=0, user=_user(db), db=db,
                                 coder_ids=coder_ids))
    listed = _run(list_columns(PID, ds.id, user=_user(db), db=db))
    return data, listed


def test_while_blind_the_shown_and_withheld_columns_are_the_variables_list(analysed):
    data, listed = _counts(analysed, coder_ids=str(ALICE))
    # The precondition that makes this test worth running: blind mode withheld something,
    # so the Data view's own column count really is short of the list.
    assert data.withheld_rating_columns >= 2, "a blind Alice must have the score and its count withheld"
    assert len(data.columns) < len(listed), "the Data view shows fewer columns than the list"
    assert len(data.columns) + data.withheld_rating_columns == len(listed), (
        "the Data view's badge (shown + withheld) must equal the Variables view's (the list)"
    )
    shown = {c.id for c in data.columns}
    assert shown <= {c.id for c in listed}, "every shown column is one the list has"


def test_unscoped_nothing_is_withheld_and_the_counts_already_agree(analysed):
    data, listed = _counts(analysed, coder_ids=None)
    assert data.withheld_rating_columns == 0
    assert len(data.columns) == len(listed)


def test_a_scope_holding_every_rater_withholds_nothing(analysed):
    data, listed = _counts(analysed, coder_ids=f"{ALICE},{BOB}")
    assert data.withheld_rating_columns == 0
    assert len(data.columns) == len(listed)
