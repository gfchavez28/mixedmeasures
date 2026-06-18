import os
os.environ["MM_DATABASE_PATH"] = ":memory:"

import pytest
from app.models.project import Project
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue, ColumnType
from app.models.participant import Participant
from app.services.participant_linking import auto_fill_role_from_linked_row


def _setup_linking(db, *, has_role_col=True, role_value="Manager", participant_role=None):
    """Create project, dataset, row, participant, and optionally a role column + value."""
    project = Project(id=1, name="Linking Test", user_id=1)
    db.add(project)

    dataset = Dataset(id=1, project_id=1, name="Survey")
    db.add(dataset)

    col_q1 = DatasetColumn(
        id=1, dataset_id=1, column_code="Q1", column_text="Q1",
        column_type=ColumnType.ORDINAL, sequence_order=0, display_order=0,
    )
    db.add(col_q1)

    if has_role_col:
        col_role = DatasetColumn(
            id=2, dataset_id=1, column_code="role", column_text="Role",
            column_type=ColumnType.DEMOGRAPHIC, demographic_subtype="role",
            sequence_order=1, display_order=1,
        )
        db.add(col_role)

    row = DatasetRow(id=1, dataset_id=1, row_identifier="R001")
    db.add(row)
    db.flush()

    # Always add Q1 value
    db.add(DatasetValue(id=1, row_id=1, column_id=1, value_text="Good", value_numeric=3.0))

    if has_role_col:
        db.add(DatasetValue(
            id=2, row_id=1, column_id=2,
            value_text=role_value if role_value else None,
            value_numeric=None,
        ))

    participant = Participant(id=1, project_id=1, identifier="P-01", role=participant_role)
    db.add(participant)
    db.flush()

    return participant, row


def test_auto_fill_role_success(db_session):
    participant, row = _setup_linking(db_session, role_value="Manager")

    result = auto_fill_role_from_linked_row(db_session, participant, row)

    assert result is True
    assert participant.role == "Manager"
    assert participant.role_auto_filled_from is not None
    assert "Survey" in participant.role_auto_filled_from


def test_auto_fill_role_skips_existing(db_session):
    participant, row = _setup_linking(db_session, participant_role="Director")

    result = auto_fill_role_from_linked_row(db_session, participant, row)

    assert result is False
    assert participant.role == "Director"


def test_auto_fill_role_no_role_column(db_session):
    participant, row = _setup_linking(db_session, has_role_col=False)

    result = auto_fill_role_from_linked_row(db_session, participant, row)

    assert result is False
    assert participant.role is None


def test_auto_fill_role_empty_value(db_session):
    participant, row = _setup_linking(db_session, role_value=None)

    result = auto_fill_role_from_linked_row(db_session, participant, row)

    assert result is False
    assert participant.role is None


def test_auto_fill_role_empty_string_value(db_session):
    """Empty string in value_text should also be treated as no value."""
    participant, row = _setup_linking(db_session, role_value="")

    result = auto_fill_role_from_linked_row(db_session, participant, row)

    assert result is False
    assert participant.role is None


# ── #418: linkable-rows payload carries identifying labels + full search text ──

import asyncio

from app.models.user import User
from app.routers.dataset import get_linkable_rows


def test_linkable_rows_display_and_search_values(db_session):
    """A dataset with NO demographic columns (Teacher_ID/School typed nominal)
    must still yield identifying display_values and a search_text covering
    every column's value — #418's blind-picker regression."""
    db = db_session
    db.add(Project(id=5, name="Fidelity", user_id=1))
    db.add(Dataset(id=5, project_id=5, name="Implementation Fidelity"))
    db.add_all([
        DatasetColumn(id=51, dataset_id=5, column_code="teacher_id", column_text="Teacher_ID",
                      column_type=ColumnType.NOMINAL, sequence_order=0, display_order=0),
        DatasetColumn(id=52, dataset_id=5, column_code="school", column_text="School",
                      column_type=ColumnType.NOMINAL, sequence_order=1, display_order=1),
        DatasetColumn(id=53, dataset_id=5, column_code="fidelity", column_text="Fidelity_Score",
                      column_type=ColumnType.NUMERIC, sequence_order=2, display_order=2),
    ])
    row = DatasetRow(id=50, dataset_id=5, row_identifier="R0001")
    db.add(row)
    db.flush()
    db.add_all([
        DatasetValue(id=501, row_id=50, column_id=51, value_text="T05"),
        DatasetValue(id=502, row_id=50, column_id=52, value_text="Maple Ridge"),
        DatasetValue(id=503, row_id=50, column_id=53, value_text="74", value_numeric=74.0),
    ])
    db.flush()
    user = db.get(User, 1)

    result = asyncio.run(get_linkable_rows(project_id=5, dataset_id=5, user=user, db=db))
    assert len(result["rows"]) == 1
    r = result["rows"][0]
    # Label: identifying (nominal/open_text/demographic) values, not numeric scores
    assert r["display_values"] == ["T05", "Maple Ridge"]
    # Search: EVERY value, lowercased — "t05", "maple", and even the score match
    assert "t05" in r["search_text"]
    assert "maple ridge" in r["search_text"]
    assert "74" in r["search_text"]
    # The pre-#418 shape is preserved for demographic-typed columns (none here)
    assert r["demographic_values"] == []


def test_linkable_rows_display_values_capped_at_three(db_session):
    db = db_session
    db.add(Project(id=6, name="Wide", user_id=1))
    db.add(Dataset(id=6, project_id=6, name="Wide"))
    for i in range(5):
        db.add(DatasetColumn(id=60 + i, dataset_id=6, column_code=f"c{i}", column_text=f"C{i}",
                             column_type=ColumnType.OPEN_TEXT, sequence_order=i, display_order=i))
    row = DatasetRow(id=60, dataset_id=6, row_identifier="R1")
    db.add(row)
    db.flush()
    for i in range(5):
        db.add(DatasetValue(id=600 + i, row_id=60, column_id=60 + i, value_text=f"v{i}"))
    db.flush()
    user = db.get(User, 1)

    result = asyncio.run(get_linkable_rows(project_id=6, dataset_id=6, user=user, db=db))
    r = result["rows"][0]
    assert r["display_values"] == ["v0", "v1", "v2"]
    assert all(f"v{i}" in r["search_text"] for i in range(5))
