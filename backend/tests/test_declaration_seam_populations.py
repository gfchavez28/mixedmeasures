"""Batch B — three surfaces that counted the wrong POPULATION (#823a/#823b/#830d).

These are not three coincidences. Each reports a number about the researcher's
own data at the moment they are changing it, and each answered a subtly
different question from the one on screen:

* **#823(a)** — a declaration is validated for SHAPE and never for whether it
  MATCHES anything, so a rule that can never fire is accepted with the same
  "Column updated." as one that reclassified 30,000 cells.
* **#823(b)** — a bulk declaration reported the AUTHORING column's cell count as
  the operation's total (34x understated on GSS).
* **#830(d)** — the response-rate denominator counted CELLS THAT EXIST rather
  than records, because the importer stores no row for a blank cell.

The review question they share: *what population is this counting?*
"""
import asyncio

import pytest

from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.project import Project
from app.models.user import User
from app.routers.text_coding import text_columns
from app.services.missing_declaration import _unmatched_rule_descriptions


def _run(coro):
    return asyncio.run(coro)


# ── #823(a): which rules matched nothing ─────────────────────────────────────


class TestUnmatchedRuleReport:
    """The verdict has to come from the server; see the helper's docstring."""

    def test_the_interior_double_space_case_that_motivated_it(self):
        """🔴 The defect, exactly as GSS produces it.

        The cell holds two interior spaces. HTML collapses interior whitespace,
        so the researcher reads one and types one, and `_discrete_rule_match`
        compares `text == rule["value"]` after stripping the ENDS only —
        correctly. The rule matches nothing, and nothing said so.

        ⚠️ Note the two literals below differ ONLY in a space you cannot see in
        rendered output. That is the whole point: no amount of care at the
        keyboard prevents this, so the test is written with explicit repr-able
        strings rather than anything copied off a screen.
        """
        stored = ".i:  Inapplicable"   # two spaces — what the importer stored
        typed = ".i: Inapplicable"     # one space — what the screen showed
        assert stored != typed, "precondition: these differ"

        assert _unmatched_rule_descriptions([{"value": typed}], [stored, "Yes"]) == [typed]

    def test_the_correct_rule_reports_nothing(self):
        """The other side, and the one that makes the report worth trusting.

        A guard that flags a correct declaration is worse than none — it is the
        #707b failure mode, where a marker that cries wolf gets dismissed.
        """
        stored = ".i:  Inapplicable"
        assert _unmatched_rule_descriptions([{"value": stored}], [stored, "Yes"]) == []

    def test_a_numeric_rule_matches_its_text_cell(self):
        """`99` declared against a cell storing "99" is a match, not a miss."""
        assert _unmatched_rule_descriptions(
            [{"value": "99", "label": "Refused"}], ["99", "1", "2"]
        ) == []

    @pytest.mark.parametrize(
        "rule,distinct,expected",
        [
            ({"lo": 900.0, "hi": 999.0}, ["1", "2", "99"], ["900 to 999"]),
            ({"lo": 90.0, "hi": 99.0}, ["1", "2", "99"], []),
            ({"lo": None, "hi": 0.0}, ["1", "2"], ["lowest to 0"]),
        ],
    )
    def test_ranges_report_too(self, rule, distinct, expected):
        """A range that lands on nothing is the same defect without the spaces —
        which is why the report is not scoped to text rules."""
        assert _unmatched_rule_descriptions([rule], distinct) == expected

    def test_no_declaration_reports_nothing(self):
        """`None` is un-declare, `[]` is "nothing missing" — neither can miss."""
        assert _unmatched_rule_descriptions(None, ["a"]) == []
        assert _unmatched_rule_descriptions([], ["a"]) == []

    def test_the_phrase_is_the_authoring_vocabulary(self):
        """One rule in, one phrase out, through `describe_missing_rules` — never
        a fourth wording invented at this call site (#609/#822)."""
        assert _unmatched_rule_descriptions(
            [{"value": "99", "label": "Refused"}], ["1"]
        ) == ["99 = Refused"]


# ── #830(d): the response-rate denominator ───────────────────────────────────


@pytest.fixture
def project_with_a_gappy_text_column(db_session):
    """48 records; only 40 carry a cell for the text column.

    That is the shape the importer produces — it stores no row for a blank cell
    — and it is what made the picker read "36/40 responded" where the true
    response rate is 36/48.
    """
    project = Project(name="Ferncrest shape", user_id=1)
    db_session.add(project)
    db_session.flush()

    ds = Dataset(project_id=project.id, name="Fidelity")
    db_session.add(ds)
    db_session.flush()

    col = DatasetColumn(
        dataset_id=ds.id,
        column_name="Observer_Notes",
        column_text="Observer_Notes",
        column_type=ColumnType.OPEN_TEXT,
        sequence_order=1,
    )
    db_session.add(col)
    db_session.flush()

    for i in range(48):
        row = DatasetRow(dataset_id=ds.id, row_identifier=f"R{i:04d}")
        db_session.add(row)
        db_session.flush()
        # Only the first 40 records answered this question at all.
        if i < 40:
            db_session.add(DatasetValue(
                row_id=row.id, column_id=col.id, value_text=f"note {i}",
            ))
    db_session.flush()
    return project, col


def test_the_denominator_is_records_not_cells(project_with_a_gappy_text_column, db_session):
    """🔴 The population is the people, not the answers.

    Mutation-check: revert `total_counts` to counting `DatasetValue` rows and
    this reads 40.
    """
    project, col = project_with_a_gappy_text_column
    user = db_session.get(User, 1)
    resp = _run(text_columns(project_id=project.id, user=user, db=db_session))

    entry = next(c for c in resp.columns if c.column_id == col.id)
    assert entry.total_rows == 48, (
        "the denominator must be the dataset's RECORDS; 40 is the number of "
        "cells that happen to exist"
    )
    assert entry.non_empty_rows == 40, (
        "the numerator is untouched and stays #519's — only the base moved"
    )


def test_the_fixture_could_have_failed(project_with_a_gappy_text_column, db_session):
    """PRECONDITION, no stronger than the claim (#763).

    A fixture where every record has a cell cannot tell the two denominators
    apart — the bug and the fix agree on it. This asserts the gap exists.
    """
    _project, col = project_with_a_gappy_text_column
    cells = db_session.query(DatasetValue).filter(DatasetValue.column_id == col.id).count()
    rows = db_session.query(DatasetRow).filter(
        DatasetRow.dataset_id == col.dataset_id
    ).count()
    assert cells < rows, "degenerate fixture: the two denominators would agree"
