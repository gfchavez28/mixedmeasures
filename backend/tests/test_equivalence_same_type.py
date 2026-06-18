"""#366 — equivalence groups must be single-type at creation, not only
at swap. A heterogeneous-type EG (e.g. Job_Level ordinal in one dataset, numeric
in another) was accepted by create_group / add_columns / merge_groups but rejected
by the portability sanity check on import — so a project could be built that
cannot round-trip. `assert_columns_same_type` is now wired into all the
creation/add/merge paths (it was previously only on swap).
"""
import os
os.environ["MM_DATABASE_PATH"] = ":memory:"

import asyncio

import pytest
from fastapi import HTTPException

from app.models.project import Project
from app.models.user import User
from app.models.dataset import Dataset, DatasetColumn
from app.routers.equivalence import create_group, add_columns, merge_groups
from app.schemas.equivalence import EquivalenceGroupCreate, EquivalenceGroupAddColumns
from tests.conftest import mock_request


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture
def mixed_type_project(db_session):
    """Project 750 with two datasets. Column 7501 (ordinal) and 7511 (numeric)
    are cross-dataset but DIFFER in type; 7502 / 7512 are both ordinal (a clean
    matched pair)."""
    db = db_session
    db.add(Project(id=750, name="Same-Type Test", user_id=1)); db.flush()
    db.add_all([
        Dataset(id=750, project_id=750, name="Survey A"),
        Dataset(id=751, project_id=750, name="Survey B"),
    ]); db.flush()
    db.add_all([
        DatasetColumn(id=7501, dataset_id=750, column_code="JobLevel", column_name="Job_Level",
                      column_text="Job Level", column_type="ordinal", sequence_order=0, display_order=0),
        DatasetColumn(id=7511, dataset_id=751, column_code="JobLevel", column_name="Job_Level",
                      column_text="Job Level", column_type="numeric", sequence_order=0, display_order=0),
        DatasetColumn(id=7502, dataset_id=750, column_code="Score", column_name="Score",
                      column_text="Score", column_type="ordinal", sequence_order=1, display_order=1),
        DatasetColumn(id=7512, dataset_id=751, column_code="Score", column_name="Score",
                      column_text="Score", column_type="ordinal", sequence_order=1, display_order=1),
    ]); db.flush()
    return db.query(User).filter(User.id == 1).one()


def test_create_group_rejects_mismatched_types(mixed_type_project, db_session):
    user = mixed_type_project
    with pytest.raises(HTTPException) as exc:
        _run(create_group(
            project_id=750,
            data=EquivalenceGroupCreate(label="bad", column_ids=[7501, 7511]),
            user=user, db=db_session,
        ))
    assert exc.value.status_code == 409
    assert exc.value.detail["error"] == "type_mismatch"


def test_create_group_allows_matching_types(mixed_type_project, db_session):
    user = mixed_type_project
    resp = _run(create_group(
        project_id=750,
        data=EquivalenceGroupCreate(label="ok", column_ids=[7502, 7512]),
        user=user, db=db_session,
    ))
    assert {c.id for c in resp.columns} == {7502, 7512}


def test_add_columns_rejects_mismatched_type(mixed_type_project, db_session):
    user = mixed_type_project
    group = _run(create_group(
        project_id=750,
        data=EquivalenceGroupCreate(label="ordinal grp", column_ids=[7502]),
        user=user, db=db_session,
    ))
    with pytest.raises(HTTPException) as exc:
        _run(add_columns(
            request=mock_request(),
            project_id=750, group_id=group.id,
            data=EquivalenceGroupAddColumns(column_ids=[7511]),  # numeric → mismatch
            user=user, db=db_session,
        ))
    assert exc.value.status_code == 409
    assert exc.value.detail["error"] == "type_mismatch"


def test_merge_rejects_mismatched_types(mixed_type_project, db_session):
    user = mixed_type_project
    g_ord = _run(create_group(
        project_id=750,
        data=EquivalenceGroupCreate(label="ordinal", column_ids=[7502]),
        user=user, db=db_session,
    ))
    g_num = _run(create_group(
        project_id=750,
        data=EquivalenceGroupCreate(label="numeric", column_ids=[7511]),
        user=user, db=db_session,
    ))
    with pytest.raises(HTTPException) as exc:
        _run(merge_groups(
            project_id=750, group_id=g_ord.id, other_group_id=g_num.id,
            user=user, db=db_session,
        ))
    assert exc.value.status_code == 409
    assert exc.value.detail["error"] == "type_mismatch"
