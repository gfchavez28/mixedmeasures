"""#1368 — a quoted answer in a formula is compared with the ANSWER.

`[q1] == "Agree"` was false on every row of every labelled column: the cell's
number is the CODE (the label sits in `value_text`), and `==` compared the
quoted text with the number's spelling, "4". Every fixture here is a REAL
import (`import_dataset_csv`) so the cells are exactly what the import writes;
a hand-built `(text, number)` row is what let the defect through.

Controls: a quoted CODE, an unquoted number and an unlabelled text column keep
their pre-fix answers.
"""
import os
os.environ["MM_DATABASE_PATH"] = ":memory:"

import pytest

from app.models.project import Project
from app.models.dataset import DatasetColumn, DatasetValue, ColumnType
from app.models.recode import RecodeDefinition, RecodeType
from app.services.dataset_import import import_dataset_csv
from app.services.computed_columns import (
    column_info,
    evaluate_computed_column,
    parse,
    validate,
)

LIKERT = ["Strongly disagree", "Disagree", "Neutral", "Agree", "Strongly agree"]

CONFIGS = [
    {"column_index": 0, "column_type": "ordinal", "column_text": "Q1", "column_code": "q1",
     "scale_labels": LIKERT},
    {"column_index": 1, "column_type": "nominal", "column_text": "Region", "column_code": "region",
     "cells_are_codes": True, "scale_labels": ["North", "South", "East"], "scale_values": [1, 2, 3]},
    {"column_index": 2, "column_type": "binary", "column_text": "Consent", "column_code": "consent"},
    # labels that LOOK like numbers, on other codes: code 1 = "3", code 2 = "4"
    {"column_index": 3, "column_type": "ordinal", "column_text": "Kids", "column_code": "kids",
     "cells_are_codes": True, "scale_labels": ["3", "4", "5 or more"], "scale_values": [1, 2, 3]},
    {"column_index": 4, "column_type": "ordinal", "column_text": "Q7", "column_code": "q7",
     "scale_labels": LIKERT, "missing_values": [{"value": "99", "label": "Refused"}]},
    {"column_index": 5, "column_type": "numeric", "column_text": "Income", "column_code": "inc"},
    {"column_index": 6, "column_type": "nominal", "column_text": "Town", "column_code": "town"},
]

CSV = (
    "Q1,Region,Consent,Kids,Q7,Income,Town\n"
    "Agree,1,Yes,2,Agree,\"$50,000\",North\n"
    "Disagree,2,No,1,99,4.0,South\n"
    "agree,3,yes,3,Strongly agree,4,north\n"
    "Strongly agree,1,Y,2,Disagree,12,North\n"
)


@pytest.fixture
def ds(db_session):
    db = db_session
    p = Project(name="P", user_id=1)
    db.add(p)
    db.flush()
    res = import_dataset_csv(db, p.id, "D", CONFIGS, CSV)
    return db, res["dataset_id"]


_n = [0]


def _run(db, dataset_id, expr):
    _n[0] += 1
    c = DatasetColumn(dataset_id=dataset_id, column_code=f"X{_n[0]}", column_text=f"X{_n[0]}",
                      column_type=ColumnType.NUMERIC, sequence_order=100 + _n[0],
                      display_order=100 + _n[0], source="computed", expression=expr,
                      depends_on_column_ids="[]")
    db.add(c)
    db.flush()
    evaluate_computed_column(db, c)
    return [v for (v,) in db.query(DatasetValue.value_text)
            .filter(DatasetValue.column_id == c.id).order_by(DatasetValue.row_id)]


T, F = "TRUE", "FALSE"


@pytest.mark.parametrize("expr, expected", [
    # the reported defect, every column kind it names
    ('[q1] == "Agree"', [T, F, T, F]),             # "agree" is the same answer (#1107's fold)
    ('[q1] != "Agree"', [F, T, F, T]),
    ('IF([q1] == "Agree", 1, 0)', ["1", "0", "1", "0"]),
    ('"Agree" == [q1]', [T, F, T, F]),              # either side
    ('[region] == "North"', [T, F, F, T]),          # value-labelled nominal
    ('[consent] == "Yes"', [T, F, T, T]),           # binary: "yes" and "Y" are Yes
    ('[kids] == "4"', [T, F, F, T]),                # the LABEL "4" (code 2), not code 4
    ('[kids] == "3"', [F, T, F, F]),                # label "3" is code 1 — never code 3
    ('[q7] == "Agree"', [T, None, F, F]),           # a missing cell stays missing
    ('[inc] == "4.0"', [F, T, F, F]),               # a numeric cell's own text
])
def test_a_quoted_answer_matches_the_answer(ds, expr, expected):
    db, dsid = ds
    assert _run(db, dsid, expr) == expected


@pytest.mark.parametrize("expr, expected", [
    ('[q1] == 4', [T, F, T, F]),                    # an unquoted number: the stored code
    ('[q1] == "4"', [T, F, T, F]),                  # a quoted CODE still reads as before
    ('[kids] == "2"', [T, F, F, T]),                # likewise on numeric-looking labels
    ('[inc] == "50000"', [T, F, F, F]),             # "$50,000" — the number's spelling
    ('[inc] == "4"', [F, T, T, F]),
    ('[town] == "North"', [T, F, F, T]),            # an unlabelled text column: exact, as before
    ('[q1] == [q7]', [T, None, F, F]),              # column against column: codes, as before
])
def test_controls_keep_their_pre_fix_answers(ds, expr, expected):
    db, dsid = ds
    assert _run(db, dsid, expr) == expected


def test_a_reverse_primary_does_not_move_the_answer(ds):
    """The comparison is text against text: a reverse primary moves `value_numeric`
    (stored reflected) and leaves the label, so "Agree" still finds the Agree rows."""
    db, dsid = ds
    q1 = db.query(DatasetColumn).filter_by(dataset_id=dsid, column_code="q1").one()
    # reflect the stored numbers the way a reverse primary does: (1+5) - code
    for v in db.query(DatasetValue).filter_by(column_id=q1.id):
        v.value_numeric = 6.0 - v.value_numeric
    db.flush()
    assert _run(db, dsid, '[q1] == "Agree"') == [T, F, T, F]


def test_a_computed_boolean_matches_its_own_text(ds):
    db, dsid = ds
    _run(db, dsid, '[q1] >= 4')
    flag = db.query(DatasetColumn).filter_by(dataset_id=dsid, column_code=f"X{_n[0]}").one()
    flag.column_code = "flag"
    db.flush()
    assert _run(db, dsid, '[flag] == "TRUE"') == [T, F, T, T]


def _warnings(db, dsid, expr):
    cols = db.query(DatasetColumn).filter(DatasetColumn.dataset_id == dsid).all()
    return validate(parse(expr), [column_info(c) for c in cols]).warnings


def test_a_word_that_is_no_answer_is_warned(ds):
    db, dsid = ds
    w = _warnings(db, dsid, '[q1] == "Agre"')
    assert len(w) == 1 and '"Agre" is not an answer' in w[0] and '"Agree"' in w[0]
    assert len(_warnings(db, dsid, '[consent] == "Maybe"')) == 1


def test_a_missing_value_label_points_at_IS_MISSING(ds):
    db, dsid = ds
    w = _warnings(db, dsid, '[q7] == "Refused"')
    assert len(w) == 1 and "IS_MISSING([q7])" in w[0]


@pytest.mark.parametrize("expr", [
    '[q1] == "Agree"', '[q1] == "4"', '[town] == "Anywhere"', '[inc] == "4"',
    '[consent] == "Y"',
])
def test_an_answer_or_a_code_is_not_warned(ds, expr):
    db, dsid = ds
    assert _warnings(db, dsid, expr) == []
