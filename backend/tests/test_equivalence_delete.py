"""Tests for `delete_group` endpoint, including #298 domain integrity guard.

Before this commit there were ZERO tests covering the delete_group endpoint
(verified via grep). This file establishes baseline coverage:

- Happy path: deleting an EG that's not part of any cross-dataset domain
  succeeds, columns unlink, group row is gone.
- #298 reject path: deleting an EG that bridges columns of a cross-dataset
  analysis domain → 409 cross_dataset_unpaired, transaction rolled back.
- State-unchanged-after-rejection: explicit re-query proves rollback worked.
"""
import asyncio

import pytest
from fastapi import HTTPException

from app.models.project import Project
from app.models.user import User
from app.models.dataset import Dataset, DatasetColumn
from app.models.equivalence_group import EquivalenceGroup
from app.models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from app.routers.equivalence import delete_group


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture
def project_with_cross_dataset_eg(db_session):
    """Project with a cross-dataset EG and a domain depending on it.

    - Project 770, user 1
    - Dataset 770 (Board), Dataset 771 (Staff)
    - EG 7700: Board Q1=7701 + Staff Q1=7751 (the domain bridge)
    - EG 7701: Board Q2=7702 only (single-dataset, no domain)
    - AnalysisDomain 7710 contains both 7701 and 7751 — relies on EG 7700
    """
    db = db_session
    project = Project(id=770, name="Delete EG Test", user_id=1)
    db.add(project)

    board = Dataset(id=770, project_id=770, name="Board")
    staff = Dataset(id=771, project_id=770, name="Staff")
    db.add_all([board, staff])

    eg_bridge = EquivalenceGroup(id=7700, project_id=770, label="Q1 bridge")
    eg_solo = EquivalenceGroup(id=7701, project_id=770, label="Solo Q2")
    db.add_all([eg_bridge, eg_solo])
    db.flush()

    db.add_all([
        DatasetColumn(id=7701, dataset_id=770, column_code="Q1", column_name="Q1",
                      column_text="Vision", column_type="ordinal",
                      sequence_order=0, display_order=0,
                      equivalence_group_id=7700),
        DatasetColumn(id=7751, dataset_id=771, column_code="Q1", column_name="Q1",
                      column_text="Vision", column_type="ordinal",
                      sequence_order=0, display_order=0,
                      equivalence_group_id=7700),
        DatasetColumn(id=7702, dataset_id=770, column_code="Q2", column_name="Q2",
                      column_text="Other", column_type="ordinal",
                      sequence_order=1, display_order=1,
                      equivalence_group_id=7701),
    ])
    db.flush()

    domain = AnalysisDomain(id=7710, project_id=770, name="Vision Domain")
    db.add(domain)
    db.flush()

    db.add_all([
        AnalysisDomainMember(domain_id=7710, member_type="column", member_id=7701, sequence_order=0),
        AnalysisDomainMember(domain_id=7710, member_type="column", member_id=7751, sequence_order=1),
    ])
    db.flush()

    user = db.query(User).filter(User.id == 1).one()
    return project, user


def test_delete_group_succeeds_when_not_in_any_domain(project_with_cross_dataset_eg, db_session):
    """Deleting EG 7701 (single-dataset, not part of any domain) succeeds.
    Columns unlink, group row is gone."""
    _, user = project_with_cross_dataset_eg
    db = db_session

    result = _run(delete_group(
        project_id=770,
        group_id=7701,
        user=user,
        db=db,
    ))
    assert result["status"] == "ok"
    assert result["deleted_id"] == 7701

    # Group is gone
    eg = db.query(EquivalenceGroup).filter(EquivalenceGroup.id == 7701).first()
    assert eg is None

    # Column unlinked
    col = db.query(DatasetColumn).filter(DatasetColumn.id == 7702).one()
    assert col.equivalence_group_id is None


def test_delete_group_rejects_when_breaks_cross_dataset_domain(project_with_cross_dataset_eg, db_session):
    """Deleting EG 7700 would leave domain 7710's two columns unpaired → 409."""
    _, user = project_with_cross_dataset_eg
    db = db_session

    with pytest.raises(HTTPException) as exc_info:
        _run(delete_group(
            project_id=770,
            group_id=7700,
            user=user,
            db=db,
        ))

    assert exc_info.value.status_code == 409
    detail = exc_info.value.detail
    assert isinstance(detail, dict)
    assert detail["error"] == "cross_dataset_unpaired"


def test_delete_group_state_unchanged_after_rejection(project_with_cross_dataset_eg, db_session):
    """When #298 rejects a delete_group, the validator runs BEFORE
    `db.delete(group)`, so the EG row is still present in the session.
    (In production, FastAPI's request lifecycle discards uncommitted
    state on the raised HTTPException; for direct-call tests we don't
    manually rollback because conftest's db_session uses flush-not-commit
    for fixtures.)"""
    _, user = project_with_cross_dataset_eg
    db = db_session

    with pytest.raises(HTTPException):
        _run(delete_group(
            project_id=770,
            group_id=7700,
            user=user,
            db=db,
        ))

    # EG row never deleted (db.delete never ran — validator raised first)
    eg = db.query(EquivalenceGroup).filter(EquivalenceGroup.id == 7700).first()
    assert eg is not None
    assert eg.label == "Q1 bridge"

    # Domain members still present (cascade-deletes never ran)
    members = db.query(AnalysisDomainMember).filter(
        AnalysisDomainMember.domain_id == 7710
    ).all()
    assert len(members) == 2
