"""#1054 review D4 — a linked record's role cell fills a participant's role by the
same rules as its identifier cell.

The role was copied as it stood (the internal design notes
§2.7): a padded cell, "N/A", a code the column declares missing, or a cell longer
than `Participant.role` holds, each became somebody's role; and with two role
columns, which one filled it was the planner's choice (`.first()`, no order).
Both doors are held to it — the bulk link (`plan_identifier_links`) and the
single-row links (`auto_fill_role_from_linked_row`), which must not disagree.
"""
import json

import pytest

from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.participant import Participant
from app.models.project import Project
from app.services.participant_linking import (
    ROLE_MAX_LENGTH, auto_fill_role_from_linked_row, link_rows_by_identifier_column,
)

PROJECT = 30


def _survey(db, cells, *, declared=None, role_columns=1):
    """One record per (identifier, role cell); the role column(s) first by id."""
    db.add(Project(id=PROJECT, name="Roles", user_id=1))
    db.flush()
    ds = Dataset(project_id=PROJECT, name="Board Survey")
    db.add(ds)
    db.flush()
    id_col = DatasetColumn(dataset_id=ds.id, column_text="id",
                           column_type=ColumnType.IDENTIFIER, sequence_order=0)
    db.add(id_col)
    db.flush()
    role_cols = []
    for k in range(role_columns):
        rc = DatasetColumn(dataset_id=ds.id, column_text=f"Role {k}",
                           column_type=ColumnType.DEMOGRAPHIC, demographic_subtype="role",
                           sequence_order=1 + k,
                           missing_values=json.dumps(declared) if declared else None)
        db.add(rc)
        db.flush()
        role_cols.append(rc)
    rows = []
    for i, (identifier, role) in enumerate(cells):
        row = DatasetRow(dataset_id=ds.id, row_identifier=f"R{i:03d}")
        db.add(row)
        db.flush()
        db.add(DatasetValue(row_id=row.id, column_id=id_col.id, value_text=identifier))
        for k, rc in enumerate(role_cols):
            if role is not None:
                db.add(DatasetValue(row_id=row.id, column_id=rc.id,
                                    value_text=role if k == 0 else f"{role} (second)"))
        rows.append(row)
    db.flush()
    return ds, id_col, rows


def _role(db, identifier):
    return db.query(Participant.role).filter(
        Participant.project_id == PROJECT, Participant.identifier == identifier,
    ).scalar()


CASES = [
    ("A", "  Teacher  ", "Teacher"),
    ("D", "x" * (ROLE_MAX_LENGTH + 1), None),
    ("E", "y" * ROLE_MAX_LENGTH, "y" * ROLE_MAX_LENGTH),
    ("F", "   ", None),
    ("G", "Board", "Board"),
]
# A declaration REPLACES the default missing list (#592), so the two missing arms
# are two-sided: undeclared, "N/A" is missing and "99" an answer; declared "99",
# the reverse. A one-sided fixture passes under a hard-coded default list too.
MISSING = {
    "undeclared": (None, [("B", "N/A", None), ("C", "99", "99")]),
    "declared": ([{"value": "99"}], [("B", "N/A", "N/A"), ("C", "99", None)]),
}


@pytest.mark.parametrize("commit_every", [None, 2], ids=["one-transaction", "batches"])
@pytest.mark.parametrize("declaration", sorted(MISSING))
def test_the_bulk_link_fills_a_role_only_from_a_usable_cell(db_session, commit_every, declaration):
    db = db_session
    declared, missing_cases = MISSING[declaration]
    cases = CASES + missing_cases
    ds, id_col, _ = _survey(db, [(i, r) for i, r, _ in cases], declared=declared)
    kw = {} if commit_every is None else {"commit_every": commit_every}
    report = link_rows_by_identifier_column(db, project_id=PROJECT, dataset_id=ds.id,
                                            column_id=id_col.id, **kw)
    db.commit()
    assert report["created"] == len(cases)
    assert {i: _role(db, i) for i, _, _ in cases} == {i: want for i, _, want in cases}


def test_a_matched_participant_with_no_role_takes_the_trimmed_cell(db_session):
    db = db_session
    db.add(Project(id=PROJECT, name="Roles", user_id=1))
    db.flush()
    db.add_all([Participant(project_id=PROJECT, identifier="A", role=""),
                Participant(project_id=PROJECT, identifier="B")])
    db.flush()
    ds = Dataset(project_id=PROJECT, name="Board Survey")
    db.add(ds)
    db.flush()
    id_col = DatasetColumn(dataset_id=ds.id, column_text="id",
                           column_type=ColumnType.IDENTIFIER, sequence_order=0)
    rc = DatasetColumn(dataset_id=ds.id, column_text="Role", column_type=ColumnType.DEMOGRAPHIC,
                       demographic_subtype="role", sequence_order=1)
    db.add_all([id_col, rc])
    db.flush()
    for identifier, role in (("A", " Chair "), ("B", "n/a")):
        row = DatasetRow(dataset_id=ds.id, row_identifier=identifier)
        db.add(row)
        db.flush()
        db.add_all([DatasetValue(row_id=row.id, column_id=id_col.id, value_text=identifier),
                    DatasetValue(row_id=row.id, column_id=rc.id, value_text=role)])
    db.flush()
    report = link_rows_by_identifier_column(db, project_id=PROJECT, dataset_id=ds.id,
                                            column_id=id_col.id)
    db.commit()
    assert report["matched"] == 2
    assert (_role(db, "A"), _role(db, "B")) == ("Chair", None)


def test_with_two_role_columns_the_first_by_id_fills_it_through_both_doors(db_session):
    """Pins that the two doors AGREE; it cannot pin the ORDER BY itself — SQLite
    returns the lowest id without it (see `_role_column`)."""
    db = db_session
    ds, id_col, rows = _survey(db, [("A", "Lead"), ("B", "Staff")], role_columns=2)
    link_rows_by_identifier_column(db, project_id=PROJECT, dataset_id=ds.id,
                                   column_id=id_col.id, row_ids=[rows[0].id])
    db.commit()
    assert _role(db, "A") == "Lead"
    single = Participant(project_id=PROJECT, identifier="B")
    db.add(single)
    db.flush()
    assert auto_fill_role_from_linked_row(db, single, rows[1]) is True
    assert single.role == "Staff"


@pytest.mark.parametrize("cell,want", [("N/A", None), ("  Nurse ", "Nurse"),
                                       ("z" * (ROLE_MAX_LENGTH + 1), None)])
def test_the_single_row_door_follows_the_same_rule(db_session, cell, want):
    db = db_session
    ds, _, rows = _survey(db, [("A", cell)])
    person = Participant(project_id=PROJECT, identifier="A")
    db.add(person)
    db.flush()
    assert auto_fill_role_from_linked_row(db, person, rows[0]) is (want is not None)
    assert person.role == want
