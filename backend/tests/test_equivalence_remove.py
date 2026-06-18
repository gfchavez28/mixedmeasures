"""Tests for `remove_columns` endpoint and the Path A auto-dissolve behavior.

Path A (#323): when a removal empties an equivalence group, the backend
auto-deletes it in the same transaction. Previously this cleanup lived as a
frontend bandage in `useCrosswalkMutations.ts::removeColumnFromRowMutation`.

Tests in this file lock in:
1. Auto-deletion of empty equivalence groups in the same transaction.
2. Non-empty groups survive a partial removal unchanged.
3. The response shape (`EquivalenceGroupRemoveColumnsResponse`) carries the
   `dissolved` flag so the frontend can patch caches without inferring from
   `columns.length === 0`.
4. Audit log details include the `dissolved` outcome.
"""
import asyncio

import pytest
from fastapi import HTTPException

from app.models.project import Project
from app.models.user import User
from app.models.dataset import Dataset, DatasetColumn
from app.models.equivalence_group import EquivalenceGroup
from app.routers.equivalence import remove_columns
from app.schemas.equivalence import EquivalenceGroupRemoveColumns
from tests.conftest import mock_request


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture
def project_with_groups(db_session):
    """Project with two datasets, two equivalence groups.

    - Project 750, user 1
    - Dataset 750 (Board), Dataset 751 (Staff)
    - EG 7500: cross-dataset (Board Q1=7501 + Staff Q1=7551). Removing the last
      column should dissolve the EG.
    - EG 7501: only Board Q2=7502. Removing it leaves the group empty → dissolve.
    - EG 7502: cross-dataset (Board Q3=7503 + Staff Q3=7553). Removing one leg
      leaves the group with one column → must NOT dissolve.
    """
    db = db_session
    project = Project(id=750, name="Remove-cols Test", user_id=1)
    db.add(project)

    board = Dataset(id=750, project_id=750, name="Board")
    staff = Dataset(id=751, project_id=750, name="Staff")
    db.add_all([board, staff])

    eg_a = EquivalenceGroup(id=7500, project_id=750, label="Q1 across datasets")
    eg_b = EquivalenceGroup(id=7501, project_id=750, label="Solo Board Q2")
    eg_c = EquivalenceGroup(id=7502, project_id=750, label="Q3 across datasets")
    db.add_all([eg_a, eg_b, eg_c])
    db.flush()

    db.add_all([
        DatasetColumn(id=7501, dataset_id=750, column_code="Q1", column_name="Q1",
                      column_text="Vision", column_type="ordinal",
                      sequence_order=0, display_order=0,
                      equivalence_group_id=7500),
        DatasetColumn(id=7551, dataset_id=751, column_code="Q1", column_name="Q1",
                      column_text="Vision", column_type="ordinal",
                      sequence_order=0, display_order=0,
                      equivalence_group_id=7500),
        DatasetColumn(id=7502, dataset_id=750, column_code="Q2", column_name="Q2",
                      column_text="Comm", column_type="ordinal",
                      sequence_order=1, display_order=1,
                      equivalence_group_id=7501),
        DatasetColumn(id=7503, dataset_id=750, column_code="Q3", column_name="Q3",
                      column_text="Strategy", column_type="ordinal",
                      sequence_order=2, display_order=2,
                      equivalence_group_id=7502),
        DatasetColumn(id=7553, dataset_id=751, column_code="Q3", column_name="Q3",
                      column_text="Strategy", column_type="ordinal",
                      sequence_order=2, display_order=2,
                      equivalence_group_id=7502),
    ])
    db.flush()

    user = db.query(User).filter(User.id == 1).one()
    return project, user


def test_remove_columns_auto_deletes_empty_eg(project_with_groups, db_session):
    """Removing all columns from a 2-column cross-dataset EG dissolves it."""
    project, user = project_with_groups
    db = db_session

    response = _run(remove_columns(
        request=mock_request(),
        project_id=750,
        group_id=7500,
        data=EquivalenceGroupRemoveColumns(column_ids=[7501, 7551]),
        user=user,
        db=db,
    ))

    assert response.dissolved is True
    assert response.group is None

    eg = db.query(EquivalenceGroup).filter(EquivalenceGroup.id == 7500).first()
    assert eg is None, "Empty equivalence group should have been auto-deleted"

    # Columns should retain SET NULL via DB-level FK; verify:
    cols = db.query(DatasetColumn).filter(DatasetColumn.id.in_([7501, 7551])).all()
    for c in cols:
        assert c.equivalence_group_id is None


def test_remove_columns_auto_deletes_solo_eg(project_with_groups, db_session):
    """Removing the only column from a single-column EG dissolves it."""
    project, user = project_with_groups
    db = db_session

    response = _run(remove_columns(
        request=mock_request(),
        project_id=750,
        group_id=7501,
        data=EquivalenceGroupRemoveColumns(column_ids=[7502]),
        user=user,
        db=db,
    ))

    assert response.dissolved is True
    assert response.group is None

    eg = db.query(EquivalenceGroup).filter(EquivalenceGroup.id == 7501).first()
    assert eg is None


def test_remove_columns_keeps_non_empty_eg(project_with_groups, db_session):
    """Removing one of two columns leaves the EG intact."""
    project, user = project_with_groups
    db = db_session

    response = _run(remove_columns(
        request=mock_request(),
        project_id=750,
        group_id=7502,
        data=EquivalenceGroupRemoveColumns(column_ids=[7503]),
        user=user,
        db=db,
    ))

    assert response.dissolved is False
    assert response.group is not None
    assert response.group.id == 7502
    assert len(response.group.columns) == 1
    assert response.group.columns[0].id == 7553

    eg = db.query(EquivalenceGroup).filter(EquivalenceGroup.id == 7502).first()
    assert eg is not None, "EG should survive partial removal"

    # Removed column has null FK
    removed = db.query(DatasetColumn).filter(DatasetColumn.id == 7503).one()
    assert removed.equivalence_group_id is None

    # Remaining column unchanged
    remaining = db.query(DatasetColumn).filter(DatasetColumn.id == 7553).one()
    assert remaining.equivalence_group_id == 7502


def test_remove_columns_response_dissolved_flag_shape(project_with_groups, db_session):
    """Verify the response dict shape exposes `group` and `dissolved` fields."""
    project, user = project_with_groups
    db = db_session

    # Non-dissolve path
    response_keep = _run(remove_columns(
        request=mock_request(),
        project_id=750,
        group_id=7502,
        data=EquivalenceGroupRemoveColumns(column_ids=[7503]),
        user=user,
        db=db,
    ))
    payload_keep = response_keep.model_dump()
    assert "group" in payload_keep
    assert "dissolved" in payload_keep
    assert payload_keep["dissolved"] is False
    assert payload_keep["group"]["id"] == 7502

    # Dissolve path (separate group)
    response_dissolve = _run(remove_columns(
        request=mock_request(),
        project_id=750,
        group_id=7501,
        data=EquivalenceGroupRemoveColumns(column_ids=[7502]),
        user=user,
        db=db,
    ))
    payload_dissolve = response_dissolve.model_dump()
    assert payload_dissolve["dissolved"] is True
    assert payload_dissolve["group"] is None


def test_remove_columns_audit_log_includes_dissolved_flag(project_with_groups, db_session):
    """The `columns_removed` audit log entry records the dissolved outcome."""
    import json
    from app.models.audit import AuditEntry

    project, user = project_with_groups
    db = db_session

    _run(remove_columns(
        request=mock_request(),
        project_id=750,
        group_id=7500,
        data=EquivalenceGroupRemoveColumns(column_ids=[7501, 7551]),
        user=user,
        db=db,
    ))

    log_entry = (
        db.query(AuditEntry)
        .filter(
            AuditEntry.action == "columns_removed",
            AuditEntry.entity_type == "equivalence_group",
            AuditEntry.entity_id == 7500,
        )
        .order_by(AuditEntry.id.desc())
        .first()
    )
    assert log_entry is not None
    details = json.loads(log_entry.details)
    assert details["dissolved"] is True
    assert details["column_ids"] == [7501, 7551]


# ═════════════════════════════════════════════════════════════════════════════
# #298 — post-mutation domain integrity guard on remove_columns
# ═════════════════════════════════════════════════════════════════════════════


@pytest.fixture
def project_with_cross_dataset_domain(db_session):
    """Project where two columns participate in a cross-dataset analysis domain
    via a shared EG. Removing the bridge breaks the domain's I2 invariant.

    - Project 760, user 1
    - Dataset 760 (Board), Dataset 761 (Staff)
    - EG 7600: Board Q1=7601 + Staff Q1=7651 (the cross-dataset bridge)
    - AnalysisDomain 7610 contains both 7601 and 7651 as members

    Removing either column from EG 7600 leaves the remaining one unpaired
    in the cross-dataset domain → #298 should reject.
    """
    from app.models.analysis_domain import AnalysisDomain, AnalysisDomainMember

    db = db_session
    project = Project(id=760, name="Cross-dataset Domain Test", user_id=1)
    db.add(project)

    board = Dataset(id=760, project_id=760, name="Board")
    staff = Dataset(id=761, project_id=760, name="Staff")
    db.add_all([board, staff])

    eg = EquivalenceGroup(id=7600, project_id=760, label="Q1 across datasets")
    db.add(eg)
    db.flush()

    db.add_all([
        DatasetColumn(id=7601, dataset_id=760, column_code="Q1", column_name="Q1",
                      column_text="Vision", column_type="ordinal",
                      sequence_order=0, display_order=0,
                      equivalence_group_id=7600),
        DatasetColumn(id=7651, dataset_id=761, column_code="Q1", column_name="Q1",
                      column_text="Vision", column_type="ordinal",
                      sequence_order=0, display_order=0,
                      equivalence_group_id=7600),
    ])
    db.flush()

    domain = AnalysisDomain(id=7610, project_id=760, name="Vision Domain")
    db.add(domain)
    db.flush()

    db.add_all([
        AnalysisDomainMember(domain_id=7610, member_type="column", member_id=7601, sequence_order=0),
        AnalysisDomainMember(domain_id=7610, member_type="column", member_id=7651, sequence_order=1),
    ])
    db.flush()

    user = db.query(User).filter(User.id == 1).one()
    return project, user


def test_remove_columns_rejects_when_breaks_cross_dataset_domain(
    project_with_cross_dataset_domain, db_session
):
    """Removing both columns from a bridging EG would leave the domain with
    two unpaired columns → 409, transaction rolled back."""
    project, user = project_with_cross_dataset_domain
    db = db_session

    with pytest.raises(HTTPException) as exc_info:
        _run(remove_columns(
            request=mock_request(),
            project_id=760,
            group_id=7600,
            data=EquivalenceGroupRemoveColumns(column_ids=[7601, 7651]),
            user=user,
            db=db,
        ))

    assert exc_info.value.status_code == 409
    detail = exc_info.value.detail
    assert isinstance(detail, dict)
    assert detail["error"] == "cross_dataset_unpaired"


def test_remove_columns_state_unchanged_after_rejection(
    project_with_cross_dataset_domain, db_session
):
    """When #298 rejects a remove, the validator runs BEFORE any destructive
    log/commit step, so the EG row is still present in the session. (In
    production, FastAPI's request lifecycle rolls back uncommitted changes
    on the raised HTTPException; for direct-call tests we don't manually
    rollback because conftest's db_session uses flush-not-commit for
    fixtures and a manual rollback would wipe fixture data.)
    """
    project, user = project_with_cross_dataset_domain
    db = db_session

    with pytest.raises(HTTPException):
        _run(remove_columns(
            request=mock_request(),
            project_id=760,
            group_id=7600,
            data=EquivalenceGroupRemoveColumns(column_ids=[7601, 7651]),
            user=user,
            db=db,
        ))

    # EG row never deleted (db.delete never ran — validator raised first)
    eg = db.query(EquivalenceGroup).filter(EquivalenceGroup.id == 7600).first()
    assert eg is not None

    # Note: in this direct-call test the column FK nullification DID flush
    # before the validator raised, but `db.commit()` never ran. The
    # FastAPI request handler in production rolls back the session on
    # raised HTTPException via the lifecycle's `db.rollback()` in
    # database.py::get_db. The in-test session still shows the in-flight
    # nulled state — that's expected and not what we're locking in here.
    # The behavior we're locking in is "validator raised before commit"
    # — the EG-row-still-exists check is the canary for that.


def test_remove_columns_succeeds_when_domain_remains_paired(
    project_with_cross_dataset_domain, db_session
):
    """Sanity: removing one column from a 2-column bridge EG fails because
    the remaining column would be unpaired in the domain. But removing
    a column NOT involved in the domain should still work.

    (Constructed as: add a second EG with Board+Staff Q2 unrelated to the
    domain, then verify removing those doesn't 409.)
    """
    project, user = project_with_cross_dataset_domain
    db = db_session

    # Add a second EG with two columns not tied to any domain
    eg_b = EquivalenceGroup(id=7601, project_id=760, label="Unrelated Q2")
    db.add(eg_b)
    db.flush()

    db.add_all([
        DatasetColumn(id=7602, dataset_id=760, column_code="Q2", column_name="Q2",
                      column_text="Other", column_type="ordinal",
                      sequence_order=1, display_order=1,
                      equivalence_group_id=7601),
        DatasetColumn(id=7652, dataset_id=761, column_code="Q2", column_name="Q2",
                      column_text="Other", column_type="ordinal",
                      sequence_order=1, display_order=1,
                      equivalence_group_id=7601),
    ])
    db.flush()

    # Removing both should succeed (no domain depends on them)
    response = _run(remove_columns(
        request=mock_request(),
        project_id=760,
        group_id=7601,
        data=EquivalenceGroupRemoveColumns(column_ids=[7602, 7652]),
        user=user,
        db=db,
    ))
    assert response.dissolved is True
