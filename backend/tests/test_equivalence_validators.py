"""Tests for the shared equivalence-validator module.

Covers the three functions in `services/equivalence_validators.py` that the
Tier 3 Session B swap endpoint and the Session A portability sanity pass
will call. See directive GAP 3.14 and Phase 1.1 for the full rationale.
"""

import pytest
from fastapi import HTTPException

from app.models.project import Project
from app.models.dataset import Dataset, DatasetColumn, ColumnType
from app.models.equivalence_group import EquivalenceGroup
from app.services.equivalence_validators import (
    assert_columns_same_type,
    assert_columns_same_dataset,
    assert_equivalence_group_types_consistent,
)


# ═════════════════════════════════════════════════════════════════════════════
# Fixtures
# ═════════════════════════════════════════════════════════════════════════════


@pytest.fixture
def validator_project(db_session):
    """Minimal project with two datasets and a mix of column types.

    The #289 partial unique index `ix_equivalence_unique_column_per_dataset`
    only allows one column per dataset in any equivalence group, so to test a
    type-mismatched group we need columns from TWO different datasets with
    DIFFERENT column types.

    Layout:
    - Project 700, user 1
    - Dataset 700 Board: cols 7001 ordinal, 7002 ordinal, 7003 nominal
    - Dataset 701 Staff: cols 7101 ordinal, 7102 nominal
    - EquivalenceGroup 7500 consistent (7001 Board ordinal + 7101 Staff ordinal)
    - EquivalenceGroup 7501 corrupt (7001 Board ordinal + 7102 Staff nominal —
      legal under the 1:1 constraint, forbidden by the type consistency rule
      that Task 1.1's validator enforces)
    """
    db = db_session
    project = Project(id=700, name="Validator Test", user_id=1)
    db.add(project)

    board = Dataset(id=700, project_id=700, name="Board")
    staff = Dataset(id=701, project_id=700, name="Staff")
    db.add_all([board, staff])

    eg_ok = EquivalenceGroup(id=7500, project_id=700, label="Consistent")
    eg_bad = EquivalenceGroup(id=7501, project_id=700, label="Corrupt")
    db.add_all([eg_ok, eg_bad])
    db.flush()

    db.add_all([
        DatasetColumn(
            id=7001, dataset_id=700, column_code="B1", column_name="B1",
            column_text="Board Q1", column_type=ColumnType.ORDINAL,
            sequence_order=0, display_order=0, equivalence_group_id=7500,
        ),
        DatasetColumn(
            id=7002, dataset_id=700, column_code="B2", column_name="B2",
            column_text="Board Q2", column_type=ColumnType.ORDINAL,
            sequence_order=1, display_order=1,
        ),
        DatasetColumn(
            id=7003, dataset_id=700, column_code="B3", column_name="B3",
            column_text="Board Q3", column_type=ColumnType.NOMINAL,
            sequence_order=2, display_order=2,
        ),
        DatasetColumn(
            id=7101, dataset_id=701, column_code="S1", column_name="S1",
            column_text="Staff Q1", column_type=ColumnType.ORDINAL,
            sequence_order=0, display_order=0, equivalence_group_id=7500,
        ),
        DatasetColumn(
            id=7102, dataset_id=701, column_code="S2", column_name="S2",
            column_text="Staff Q2", column_type=ColumnType.NOMINAL,
            sequence_order=1, display_order=1,
        ),
    ])
    db.flush()
    return project


# ═════════════════════════════════════════════════════════════════════════════
# assert_columns_same_type
# ═════════════════════════════════════════════════════════════════════════════


def test_same_type_accepts_empty_and_single(db_session, validator_project):
    """Empty and single-element lists are trivially valid."""
    assert_columns_same_type([])

    col = db_session.query(DatasetColumn).filter(DatasetColumn.id == 7001).one()
    assert_columns_same_type([col])


def test_same_type_accepts_matching_types(db_session, validator_project):
    """Two ordinal columns from different datasets pass."""
    cols = (
        db_session.query(DatasetColumn)
        .filter(DatasetColumn.id.in_([7001, 7101]))
        .all()
    )
    assert len(cols) == 2
    assert_columns_same_type(cols)  # should not raise


def test_same_type_rejects_mismatched_types(db_session, validator_project):
    """Ordinal + nominal raises HTTPException(409) with the type_mismatch shape."""
    cols = (
        db_session.query(DatasetColumn)
        .filter(DatasetColumn.id.in_([7001, 7003]))
        .all()
    )
    with pytest.raises(HTTPException) as exc_info:
        assert_columns_same_type(cols)

    assert exc_info.value.status_code == 409
    detail = exc_info.value.detail
    assert isinstance(detail, dict)
    assert detail["error"] == "type_mismatch"
    assert "share a column type" in detail["message"]
    assert set(detail["column_ids"]) == {7001, 7003}


# ═════════════════════════════════════════════════════════════════════════════
# assert_columns_same_dataset
# ═════════════════════════════════════════════════════════════════════════════


def test_same_dataset_accepts_empty_and_single(db_session, validator_project):
    """Empty and single-element lists are trivially valid."""
    assert_columns_same_dataset([])

    col = db_session.query(DatasetColumn).filter(DatasetColumn.id == 7001).one()
    assert_columns_same_dataset([col])


def test_same_dataset_accepts_same_dataset(db_session, validator_project):
    """Two columns from dataset 700 pass."""
    cols = (
        db_session.query(DatasetColumn)
        .filter(DatasetColumn.id.in_([7001, 7002]))
        .all()
    )
    assert_columns_same_dataset(cols)  # should not raise


def test_same_dataset_rejects_cross_dataset(db_session, validator_project):
    """Columns from different datasets raise HTTPException(400) with cross_dataset shape."""
    cols = (
        db_session.query(DatasetColumn)
        .filter(DatasetColumn.id.in_([7001, 7101]))
        .all()
    )
    with pytest.raises(HTTPException) as exc_info:
        assert_columns_same_dataset(cols)

    assert exc_info.value.status_code == 400
    detail = exc_info.value.detail
    assert isinstance(detail, dict)
    assert detail["error"] == "cross_dataset"
    assert "same dataset" in detail["message"]
    assert set(detail["column_ids"]) == {7001, 7101}
    assert set(detail["dataset_ids"]) == {700, 701}


# ═════════════════════════════════════════════════════════════════════════════
# assert_equivalence_group_types_consistent
# ═════════════════════════════════════════════════════════════════════════════


def test_group_types_consistent_accepts_matching(db_session, validator_project):
    """EquivalenceGroup 7500 has two ordinal columns — trivially valid."""
    group = (
        db_session.query(EquivalenceGroup)
        .filter(EquivalenceGroup.id == 7500)
        .one()
    )
    assert_equivalence_group_types_consistent(group)  # should not raise


def test_group_types_consistent_accepts_empty_and_single(db_session, validator_project):
    """Empty and single-column groups are trivially valid."""
    # Create a fresh empty group
    empty_group = EquivalenceGroup(id=7502, project_id=700, label="Empty")
    db_session.add(empty_group)
    db_session.flush()
    assert_equivalence_group_types_consistent(empty_group)

    # Move one column off of eg 7500 into a new singleton group
    single_group = EquivalenceGroup(id=7503, project_id=700, label="Single")
    db_session.add(single_group)
    db_session.flush()
    col_7002 = db_session.query(DatasetColumn).filter(DatasetColumn.id == 7002).one()
    col_7002.equivalence_group_id = 7503
    db_session.flush()
    db_session.refresh(single_group)
    assert_equivalence_group_types_consistent(single_group)


def test_group_types_consistent_raises_valueerror_on_mismatch(db_session, validator_project):
    """A group with mixed ordinal (Board) + nominal (Staff) columns raises ValueError.

    Uses cross-dataset columns (7001 Board ordinal + 7102 Staff nominal) to
    satisfy the #289 1:1-per-dataset constraint — the type mismatch is legal
    under the 1:1 index, and the validator catches the OTHER invariant.

    Portability-safe variant: raises ValueError, not HTTPException.
    """
    # Move 7001 (ordinal, Board) off eg 7500 into eg 7501
    col_7001 = db_session.query(DatasetColumn).filter(DatasetColumn.id == 7001).one()
    col_7001.equivalence_group_id = 7501
    # Add 7102 (nominal, Staff) to eg 7501 — legal per 1:1 because different dataset
    col_7102 = db_session.query(DatasetColumn).filter(DatasetColumn.id == 7102).one()
    col_7102.equivalence_group_id = 7501
    db_session.flush()

    group = (
        db_session.query(EquivalenceGroup)
        .filter(EquivalenceGroup.id == 7501)
        .one()
    )
    db_session.refresh(group)

    with pytest.raises(ValueError) as exc_info:
        assert_equivalence_group_types_consistent(group)

    msg = str(exc_info.value)
    assert "7501" in msg
    assert "Corrupt" in msg
    assert "mismatched" in msg.lower()
    # Should mention both types
    assert "ordinal" in msg
    assert "nominal" in msg


def test_group_types_consistent_does_not_raise_httpexception(db_session, validator_project):
    """Regression: the portability-safe variant must NOT raise HTTPException.

    Locks in the layering contract — service code called from
    project_portability.py must not leak FastAPI exception types.
    """
    col_7001 = db_session.query(DatasetColumn).filter(DatasetColumn.id == 7001).one()
    col_7001.equivalence_group_id = 7501
    col_7102 = db_session.query(DatasetColumn).filter(DatasetColumn.id == 7102).one()
    col_7102.equivalence_group_id = 7501
    db_session.flush()

    group = (
        db_session.query(EquivalenceGroup)
        .filter(EquivalenceGroup.id == 7501)
        .one()
    )
    db_session.refresh(group)

    # Must raise ValueError — HTTPException should not be in the MRO here
    with pytest.raises(ValueError) as exc_info:
        assert_equivalence_group_types_consistent(group)
    assert not isinstance(exc_info.value, HTTPException)
