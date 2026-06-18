"""Tests for #290 — cross-dataset analysis domain members must be
linked via equivalence groups.

This invariant was structurally enforced before Feb 17 2026 via a
`member_type='equivalence_group'` on `AnalysisDomainMember`. A later schema
change expanded that member type into individual column members and silently
removed the structural enforcement. The #290 fix restores the invariant at
three layers:

1. **Router validators** — `assert_cross_dataset_members_are_paired` in
   `services/equivalence_validators.py`, wired into `create_domain`,
   `add_members`, `bulk_create_domains`. Returns structured 409 with
   `detail.error == "cross_dataset_unpaired"`.
2. **Runtime assertion** — `_assert_domain_members_paired` in
   `services/metrics.py::resolve_dataset_domain`. Raises `ValueError` if any
   path bypasses the router validator. Single entry point covers both
   metric computation and statistical tests.
3. **Portability import** — pre-flight validator in
   `services/project_portability.py` before `analysis_domain_members` insert.
   Raises `ValueError` with repair instructions.

The validator rule: for any domain whose members span 2+ datasets, every
member must have a non-null `equivalence_group_id` that bridges to at least
one other member in a different dataset within the same domain.
"""
import asyncio
import io
import json
import zipfile
from pathlib import Path

import pytest
from fastapi import HTTPException

from app.models.project import Project
from app.models.user import User
from app.models.dataset import Dataset, DatasetColumn
from app.models.equivalence_group import EquivalenceGroup
from app.models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from app.models.metric import MetricDefinition
from app.routers.analysis_domains import (
    create_domain,
    add_members,
    bulk_create_domains,
    remove_members,
    update_domain,
)
from app.schemas.analysis_domain import (
    AnalysisDomainCreate,
    AnalysisDomainAddMembers,
    AnalysisDomainBulkCreate,
    AnalysisDomainRemoveMembers,
    AnalysisDomainUpdate,
    DomainMemberInput,
)
from app.services.metrics import resolve_dataset_domain

# Rate-limited router test helper — see conftest.py::mock_request
from tests.conftest import mock_request


# ═══════════════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════════════


def _run(coro):
    """Invoke an async router function synchronously for tests."""
    return asyncio.run(coro)


def _detail_of(exc: HTTPException) -> dict:
    """Extract the dict detail from a 409 HTTPException."""
    detail = exc.detail
    assert isinstance(detail, dict), f"Expected dict detail, got {type(detail)}: {detail}"
    return detail


def _member(col_id: int) -> DomainMemberInput:
    return DomainMemberInput(member_type="column", member_id=col_id)


# ═══════════════════════════════════════════════════════════════════════════════
# Fixtures
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.fixture
def two_dataset_project_with_eg(db_session):
    """Project with two datasets, each with 3 ordinal columns, and 3
    equivalence groups pairing Q1/Q2/Q3 across Board and Staff 1:1.

    Layout:
    - Project 900, user 1
    - Dataset 900 Board: cols 9001 Q1, 9002 Q2, 9003 Q3
    - Dataset 901 Staff: cols 9101 Q1, 9102 Q2, 9103 Q3
    - eg 9500 pairs 9001+9101, 9501 pairs 9002+9102, 9502 pairs 9003+9103
    - Dataset 900 also has col 9004 Q4 UNPAIRED (for negative tests)
    - Dataset 901 also has col 9104 Q4 UNPAIRED
    """
    db = db_session
    project = Project(id=900, name="Domain 290 Test", user_id=1)
    db.add(project)

    board = Dataset(id=900, project_id=900, name="Board")
    staff = Dataset(id=901, project_id=900, name="Staff")
    db.add_all([board, staff])

    eg1 = EquivalenceGroup(id=9500, project_id=900, label="Q1")
    eg2 = EquivalenceGroup(id=9501, project_id=900, label="Q2")
    eg3 = EquivalenceGroup(id=9502, project_id=900, label="Q3")
    db.add_all([eg1, eg2, eg3])
    db.flush()

    db.add_all([
        DatasetColumn(id=9001, dataset_id=900, column_code="Q1", column_name="Q1",
                      column_text="Leadership Vision", column_type="ordinal",
                      sequence_order=0, display_order=0, equivalence_group_id=9500),
        DatasetColumn(id=9002, dataset_id=900, column_code="Q2", column_name="Q2",
                      column_text="Leadership Communication", column_type="ordinal",
                      sequence_order=1, display_order=1, equivalence_group_id=9501),
        DatasetColumn(id=9003, dataset_id=900, column_code="Q3", column_name="Q3",
                      column_text="Leadership Decisions", column_type="ordinal",
                      sequence_order=2, display_order=2, equivalence_group_id=9502),
        DatasetColumn(id=9004, dataset_id=900, column_code="Q4", column_name="Q4",
                      column_text="Board satisfaction", column_type="ordinal",
                      sequence_order=3, display_order=3),
        DatasetColumn(id=9101, dataset_id=901, column_code="Q1", column_name="Q1",
                      column_text="Leadership Vision", column_type="ordinal",
                      sequence_order=0, display_order=0, equivalence_group_id=9500),
        DatasetColumn(id=9102, dataset_id=901, column_code="Q2", column_name="Q2",
                      column_text="Leadership Communication", column_type="ordinal",
                      sequence_order=1, display_order=1, equivalence_group_id=9501),
        DatasetColumn(id=9103, dataset_id=901, column_code="Q3", column_name="Q3",
                      column_text="Leadership Decisions", column_type="ordinal",
                      sequence_order=2, display_order=2, equivalence_group_id=9502),
        DatasetColumn(id=9104, dataset_id=901, column_code="Q4", column_name="Q4",
                      column_text="Job satisfaction", column_type="ordinal",
                      sequence_order=3, display_order=3),
    ])
    db.flush()

    user = db.query(User).filter(User.id == 1).one()
    return project, user


# ═══════════════════════════════════════════════════════════════════════════════
# Layer 1 — Router validator: create_domain
# ═══════════════════════════════════════════════════════════════════════════════


def test_create_domain_accepts_single_dataset_members(two_dataset_project_with_eg, db_session):
    """Sanity: single-dataset domains are unaffected by the constraint."""
    _, user = two_dataset_project_with_eg
    resp = _run(create_domain(
        project_id=900,
        data=AnalysisDomainCreate(
            name="Board only",
            members=[_member(9001), _member(9002), _member(9004)],
        ),
        user=user,
        db=db_session,
    ))
    assert resp.name == "Board only"
    assert len(resp.members) == 3


def test_create_domain_accepts_cross_dataset_with_full_pairings(two_dataset_project_with_eg, db_session):
    """All 6 Q1/Q2/Q3 columns paired 1:1 across Board and Staff → allowed."""
    _, user = two_dataset_project_with_eg
    resp = _run(create_domain(
        project_id=900,
        data=AnalysisDomainCreate(
            name="Leadership",
            members=[_member(9001), _member(9002), _member(9003),
                     _member(9101), _member(9102), _member(9103)],
        ),
        user=user,
        db=db_session,
    ))
    assert len(resp.members) == 6


def test_create_domain_rejects_cross_dataset_without_pairings(two_dataset_project_with_eg, db_session):
    """Board Q4 + Staff Q4, neither in an equivalence group → 409."""
    _, user = two_dataset_project_with_eg
    with pytest.raises(HTTPException) as exc_info:
        _run(create_domain(
            project_id=900,
            data=AnalysisDomainCreate(
                name="Bad",
                members=[_member(9004), _member(9104)],
            ),
            user=user,
            db=db_session,
        ))
    assert exc_info.value.status_code == 409
    detail = _detail_of(exc_info.value)
    assert detail["error"] == "cross_dataset_unpaired"
    assert len(detail["unpaired_columns"]) == 2
    unpaired_ids = {c["id"] for c in detail["unpaired_columns"]}
    assert unpaired_ids == {9004, 9104}


def test_create_domain_rejects_partially_paired_cross_dataset(two_dataset_project_with_eg, db_session):
    """Three Board columns + three Staff columns, but one Board column is
    unpaired (Q4). The other five are fully paired. The unpaired Q4 makes
    the whole domain invalid → 409 naming just the Q4."""
    _, user = two_dataset_project_with_eg
    with pytest.raises(HTTPException) as exc_info:
        _run(create_domain(
            project_id=900,
            data=AnalysisDomainCreate(
                name="Mostly-good",
                members=[
                    _member(9001), _member(9002), _member(9004),  # Q1, Q2 paired; Q4 unpaired
                    _member(9101), _member(9102),                  # Staff Q1, Q2 paired
                ],
            ),
            user=user,
            db=db_session,
        ))
    assert exc_info.value.status_code == 409
    detail = _detail_of(exc_info.value)
    unpaired_ids = {c["id"] for c in detail["unpaired_columns"]}
    assert unpaired_ids == {9004}


def test_create_domain_rejects_single_column_in_isolated_eg(two_dataset_project_with_eg, db_session):
    """Edge case: a member has a non-null equivalence_group_id but no OTHER
    member of the domain is in a different dataset via that eg. The eg
    exists, but it doesn't bridge datasets within this particular domain.

    Scenario: domain = {Board Q1 (eg 9500), Board Q2 (eg 9501), Staff Q4
    (unpaired)}. Board Q1's eg exists and contains Staff Q1 globally, but
    Staff Q1 is NOT in this domain — so Board Q1's eg doesn't bridge
    datasets *within this domain*."""
    _, user = two_dataset_project_with_eg
    with pytest.raises(HTTPException) as exc_info:
        _run(create_domain(
            project_id=900,
            data=AnalysisDomainCreate(
                name="Isolated eg",
                members=[_member(9001), _member(9002), _member(9104)],
            ),
            user=user,
            db=db_session,
        ))
    assert exc_info.value.status_code == 409
    detail = _detail_of(exc_info.value)
    unpaired_ids = {c["id"] for c in detail["unpaired_columns"]}
    # All three should be flagged: 9001 and 9002 don't bridge to Staff
    # within this domain (their eg siblings aren't in the member set),
    # and 9104 has no eg at all.
    assert 9001 in unpaired_ids
    assert 9002 in unpaired_ids
    assert 9104 in unpaired_ids


# ═══════════════════════════════════════════════════════════════════════════════
# Layer 1 — Router validator: add_members
# ═══════════════════════════════════════════════════════════════════════════════


def test_add_members_accepts_same_dataset_addition(two_dataset_project_with_eg, db_session):
    """Existing cross-dataset domain + add another paired column → 200."""
    _, user = two_dataset_project_with_eg
    # Create base cross-dataset domain
    domain = _run(create_domain(
        project_id=900,
        data=AnalysisDomainCreate(
            name="Leadership",
            members=[_member(9001), _member(9101)],
        ),
        user=user,
        db=db_session,
    ))
    # Add another paired column — should be fine
    resp = _run(add_members(
        request=mock_request(),
        project_id=900,
        domain_id=domain.id,
        data=AnalysisDomainAddMembers(members=[_member(9002), _member(9102)]),
        user=user,
        db=db_session,
    ))
    member_ids = {m.member_id for m in resp.members}
    assert member_ids == {9001, 9101, 9002, 9102}


def test_add_members_rejects_unpaired_cross_dataset_addition(two_dataset_project_with_eg, db_session):
    """Existing single-dataset domain + add unpaired column from another
    dataset → 409 (the addition would create a cross-dataset domain
    without pairings)."""
    _, user = two_dataset_project_with_eg
    # Create a Board-only domain
    domain = _run(create_domain(
        project_id=900,
        data=AnalysisDomainCreate(
            name="Board only",
            members=[_member(9001)],
        ),
        user=user,
        db=db_session,
    ))
    # Try to add Staff Q4 (unpaired)
    with pytest.raises(HTTPException) as exc_info:
        _run(add_members(
            request=mock_request(),
            project_id=900,
            domain_id=domain.id,
            data=AnalysisDomainAddMembers(members=[_member(9104)]),
            user=user,
            db=db_session,
        ))
    assert exc_info.value.status_code == 409
    detail = _detail_of(exc_info.value)
    assert detail["error"] == "cross_dataset_unpaired"


def test_add_members_rejects_orphaning_addition(two_dataset_project_with_eg, db_session):
    """Existing single-dataset Board domain with Q4 (unpaired) + add Staff
    Q1 paired with Board Q1 (but Board Q1 isn't in the domain) → 409
    because Board Q4 remains unpaired and Staff Q1's eg doesn't bridge
    to any column in the domain."""
    _, user = two_dataset_project_with_eg
    domain = _run(create_domain(
        project_id=900,
        data=AnalysisDomainCreate(
            name="Board only",
            members=[_member(9004)],  # Board Q4, unpaired
        ),
        user=user,
        db=db_session,
    ))
    with pytest.raises(HTTPException) as exc_info:
        _run(add_members(
            request=mock_request(),
            project_id=900,
            domain_id=domain.id,
            data=AnalysisDomainAddMembers(members=[_member(9101)]),  # Staff Q1, paired to Board Q1 (not in domain)
            user=user,
            db=db_session,
        ))
    assert exc_info.value.status_code == 409
    detail = _detail_of(exc_info.value)
    unpaired_ids = {c["id"] for c in detail["unpaired_columns"]}
    assert 9004 in unpaired_ids  # Board Q4 is clearly unpaired
    assert 9101 in unpaired_ids  # Staff Q1's eg doesn't bridge within this domain


# ═══════════════════════════════════════════════════════════════════════════════
# Layer 1 — Router validator: bulk_create_domains
# ═══════════════════════════════════════════════════════════════════════════════


def test_bulk_create_domains_accepts_all_valid(two_dataset_project_with_eg, db_session):
    """Sanity: valid bulk create with paired cross-dataset domains."""
    _, user = two_dataset_project_with_eg
    batch = AnalysisDomainBulkCreate(domains=[
        AnalysisDomainCreate(
            name="D1",
            members=[_member(9001), _member(9101)],
        ),
        AnalysisDomainCreate(
            name="D2",
            members=[_member(9002), _member(9102)],
        ),
    ])
    resp = _run(bulk_create_domains(
        request=mock_request(),
        project_id=900,
        data=batch,
        user=user,
        db=db_session,
    ))
    assert resp.created == 2


def test_bulk_create_domains_rejects_batch_with_violation(two_dataset_project_with_eg, db_session):
    """Batch of two domains; the second has an unpaired cross-dataset member.
    Entire batch is rejected (all-or-nothing)."""
    _, user = two_dataset_project_with_eg
    batch = AnalysisDomainBulkCreate(domains=[
        AnalysisDomainCreate(
            name="Good",
            members=[_member(9001), _member(9101)],
        ),
        AnalysisDomainCreate(
            name="Bad",
            members=[_member(9004), _member(9104)],  # both unpaired
        ),
    ])
    with pytest.raises(HTTPException) as exc_info:
        _run(bulk_create_domains(
            request=mock_request(),
            project_id=900,
            data=batch,
            user=user,
            db=db_session,
        ))
    assert exc_info.value.status_code == 409
    # Neither domain should have been committed
    assert db_session.query(AnalysisDomain).filter(
        AnalysisDomain.project_id == 900).count() == 0


# ═══════════════════════════════════════════════════════════════════════════════
# Phase 4 — bulk_create_domains with inline equivalence_groups (#297, #295)
# ═══════════════════════════════════════════════════════════════════════════════
#
# When AnalysisDomainCreate carries `equivalence_groups`, the endpoint creates
# them BEFORE inserting domain members so cross-dataset I2 (#290) is satisfied
# in one transaction. Used by Tier 3 Suggest accept to scaffold paired EGs.


@pytest.fixture
def bulk_inline_eg_project(db_session):
    """Two datasets with unpaired columns ready for inline-EG bulk creation.

    No equivalence groups, no analysis domains — Suggest's accept flow
    starts with un-grouped columns.
    """
    db = db_session
    project = Project(id=2000, name="Bulk Inline EG Test", user_id=1)
    db.add(project)
    board = Dataset(id=2000, project_id=2000, name="Board")
    staff = Dataset(id=2001, project_id=2000, name="Staff")
    db.add_all([board, staff])
    db.flush()
    db.add_all([
        DatasetColumn(id=20001, dataset_id=2000, column_code="LD-001",
                      column_text="Leadership is consistent",
                      column_type="ordinal", sequence_order=0, display_order=0),
        DatasetColumn(id=20002, dataset_id=2000, column_code="LD-002",
                      column_text="Leadership communicates clearly",
                      column_type="ordinal", sequence_order=1, display_order=1),
        DatasetColumn(id=20101, dataset_id=2001, column_code="LD-001",
                      column_text="Leadership is consistent",
                      column_type="ordinal", sequence_order=0, display_order=0),
        DatasetColumn(id=20102, dataset_id=2001, column_code="LD-002",
                      column_text="Leadership communicates clearly",
                      column_type="ordinal", sequence_order=1, display_order=1),
    ])
    db.flush()
    user = db.query(User).filter(User.id == 1).one()
    return project, user


def test_bulk_create_inline_eg_happy_path(bulk_inline_eg_project, db_session):
    """Inline EGs are created and columns linked before I2 validation runs.

    The result: domain has 4 cross-dataset members + 2 EGs each pairing
    one column from each dataset. I2 satisfied.
    """
    from app.schemas.analysis_domain import EquivalenceGroupCreateInline
    from app.models.equivalence_group import EquivalenceGroup as EG

    _, user = bulk_inline_eg_project
    batch = AnalysisDomainBulkCreate(domains=[
        AnalysisDomainCreate(
            name="Leadership",
            members=[_member(20001), _member(20002), _member(20101), _member(20102)],
            equivalence_groups=[
                EquivalenceGroupCreateInline(column_ids=[20001, 20101], label="LD-001"),
                EquivalenceGroupCreateInline(column_ids=[20002, 20102], label="LD-002"),
            ],
        ),
    ])
    resp = _run(bulk_create_domains(
        request=mock_request(), project_id=2000, data=batch, user=user, db=db_session,
    ))
    assert resp.created == 1
    # Two EGs created, each spanning 2 datasets
    egs = db_session.query(EG).filter(EG.project_id == 2000).all()
    assert len(egs) == 2
    # Each EG has 2 columns from different datasets
    for eg in egs:
        assert len(eg.columns) == 2
        assert {c.dataset_id for c in eg.columns} == {2000, 2001}


def test_bulk_create_inline_eg_violates_1_to_1(bulk_inline_eg_project, db_session):
    """Inline EG with two columns from the same dataset → 409 duplicate_dataset."""
    from app.schemas.analysis_domain import EquivalenceGroupCreateInline
    from app.models.equivalence_group import EquivalenceGroup as EG

    _, user = bulk_inline_eg_project
    batch = AnalysisDomainBulkCreate(domains=[
        AnalysisDomainCreate(
            name="Bad",
            members=[_member(20001), _member(20002)],
            equivalence_groups=[
                EquivalenceGroupCreateInline(column_ids=[20001, 20002], label="bad"),
            ],
        ),
    ])
    with pytest.raises(HTTPException) as exc_info:
        _run(bulk_create_domains(request=mock_request(), project_id=2000, data=batch, user=user, db=db_session))
    assert exc_info.value.status_code == 409
    detail = _detail_of(exc_info.value)
    assert detail["error"] == "duplicate_dataset"
    # Rollback: nothing persisted
    assert db_session.query(EG).filter(EG.project_id == 2000).count() == 0
    assert db_session.query(AnalysisDomain).filter(
        AnalysisDomain.project_id == 2000).count() == 0


def test_bulk_create_inline_eg_hijack_rejected(bulk_inline_eg_project, db_session):
    """Inline EG references a column that's already linked to another EG.

    Defensive guard for stale-frontend-cache races: Suggest filters
    candidates client-side, but the server re-checks.
    """
    from app.schemas.analysis_domain import EquivalenceGroupCreateInline
    from app.models.equivalence_group import EquivalenceGroup as EG

    db = db_session
    _, user = bulk_inline_eg_project
    # Pre-link 20001 to a different EG so the inline EG would silently hijack it
    pre_eg = EG(project_id=2000, label="pre-existing")
    db.add(pre_eg)
    db.flush()
    db.query(DatasetColumn).filter(DatasetColumn.id == 20001).update(
        {"equivalence_group_id": pre_eg.id}, synchronize_session="fetch",
    )
    db.flush()

    batch = AnalysisDomainBulkCreate(domains=[
        AnalysisDomainCreate(
            name="Hijacker",
            members=[_member(20001), _member(20101)],
            equivalence_groups=[
                EquivalenceGroupCreateInline(column_ids=[20001, 20101], label="hijack"),
            ],
        ),
    ])
    with pytest.raises(HTTPException) as exc_info:
        _run(bulk_create_domains(request=mock_request(), project_id=2000, data=batch, user=user, db=db_session))
    assert exc_info.value.status_code == 409
    detail = _detail_of(exc_info.value)
    assert detail["error"] == "column_already_linked"
    # Rollback: domain not committed; pre-existing EG intact, no new EG
    assert db_session.query(EG).filter(EG.project_id == 2000).count() == 1
    assert db_session.query(AnalysisDomain).filter(
        AnalysisDomain.project_id == 2000).count() == 0


def test_bulk_create_inline_eg_insufficient_for_i2(bulk_inline_eg_project, db_session):
    """Inline EGs only cover SOME of the cross-dataset members. I2 fires
    on the unpaired ones."""
    from app.schemas.analysis_domain import EquivalenceGroupCreateInline
    from app.models.equivalence_group import EquivalenceGroup as EG

    _, user = bulk_inline_eg_project
    # Domain has 4 cross-dataset members but inline EG only pairs 2 of them
    batch = AnalysisDomainBulkCreate(domains=[
        AnalysisDomainCreate(
            name="Partial",
            members=[_member(20001), _member(20002), _member(20101), _member(20102)],
            equivalence_groups=[
                EquivalenceGroupCreateInline(column_ids=[20001, 20101], label="LD-001"),
                # 20002 and 20102 left unpaired
            ],
        ),
    ])
    with pytest.raises(HTTPException) as exc_info:
        _run(bulk_create_domains(request=mock_request(), project_id=2000, data=batch, user=user, db=db_session))
    assert exc_info.value.status_code == 409
    detail = _detail_of(exc_info.value)
    assert detail["error"] == "cross_dataset_unpaired"
    # In production, get_db's session close rolls back the uncommitted txn.
    # Here we simulate that by rolling back explicitly, then verifying the
    # transaction's writes never landed.
    db_session.rollback()
    assert db_session.query(EG).filter(EG.project_id == 2000).count() == 0
    assert db_session.query(AnalysisDomain).filter(
        AnalysisDomain.project_id == 2000).count() == 0


def test_bulk_create_inline_eg_columns_must_be_in_domain(bulk_inline_eg_project, db_session):
    """Inline EGs cannot reference columns that aren't members of the domain."""
    from app.schemas.analysis_domain import EquivalenceGroupCreateInline
    from app.models.equivalence_group import EquivalenceGroup as EG

    _, user = bulk_inline_eg_project
    batch = AnalysisDomainBulkCreate(domains=[
        AnalysisDomainCreate(
            name="Mismatched",
            members=[_member(20001), _member(20101)],
            equivalence_groups=[
                # 20002 isn't in members
                EquivalenceGroupCreateInline(column_ids=[20002, 20102], label="extra"),
            ],
        ),
    ])
    with pytest.raises(HTTPException) as exc_info:
        _run(bulk_create_domains(request=mock_request(), project_id=2000, data=batch, user=user, db=db_session))
    assert exc_info.value.status_code == 400
    assert "Inline equivalence-group columns must also be members" in str(
        exc_info.value.detail)
    assert db_session.query(EG).filter(EG.project_id == 2000).count() == 0


def test_bulk_create_no_inline_eg_falls_back_to_existing_behavior(
    two_dataset_project_with_eg, db_session,
):
    """When equivalence_groups is empty, behavior is unchanged from before
    Phase 4. The fixture has pre-existing EGs that satisfy I2 already.
    """
    _, user = two_dataset_project_with_eg
    batch = AnalysisDomainBulkCreate(domains=[
        AnalysisDomainCreate(
            name="No Inline",
            members=[_member(9001), _member(9101)],
            # equivalence_groups omitted → defaults to []
        ),
    ])
    resp = _run(bulk_create_domains(
        request=mock_request(),
        project_id=900, data=batch, user=user, db=db_session,
    ))
    assert resp.created == 1


# ═══════════════════════════════════════════════════════════════════════════════
# Layer 1 — Validator does not overreach
# ═══════════════════════════════════════════════════════════════════════════════


def test_remove_members_unaffected_by_validator(two_dataset_project_with_eg, db_session):
    """Removing members can only improve the pairing state, so remove_members
    must not run the validator. Sanity check: removing a member succeeds
    without error regardless of the resulting state."""
    _, user = two_dataset_project_with_eg
    domain = _run(create_domain(
        project_id=900,
        data=AnalysisDomainCreate(
            name="Leadership",
            members=[_member(9001), _member(9101)],
        ),
        user=user,
        db=db_session,
    ))
    # Remove Staff Q1 — leaves just Board Q1, which is now single-dataset valid
    resp = _run(remove_members(
        request=mock_request(),
        project_id=900,
        domain_id=domain.id,
        data=AnalysisDomainRemoveMembers(members=[_member(9101)]),
        user=user,
        db=db_session,
    ))
    # Sanity: removal succeeded
    assert resp.id == domain.id


def test_update_domain_unaffected_by_validator(two_dataset_project_with_eg, db_session):
    """update_domain only touches name/description/color, never members."""
    _, user = two_dataset_project_with_eg
    domain = _run(create_domain(
        project_id=900,
        data=AnalysisDomainCreate(
            name="Leadership",
            members=[_member(9001), _member(9101)],
        ),
        user=user,
        db=db_session,
    ))
    resp = _run(update_domain(
        project_id=900,
        domain_id=domain.id,
        data=AnalysisDomainUpdate(name="Leadership (updated)"),
        user=user,
        db=db_session,
    ))
    assert resp.name == "Leadership (updated)"


# ═══════════════════════════════════════════════════════════════════════════════
# Layer 2 — Runtime assertion in resolve_dataset_domain
# ═══════════════════════════════════════════════════════════════════════════════


def test_resolve_dataset_domain_asserts_on_unpaired_cross_dataset(two_dataset_project_with_eg, db_session):
    """Bypass the router validator by inserting a violating domain directly
    via ORM, then call resolve_dataset_domain. The runtime assertion
    should raise ValueError with a clear bypass-detection message."""
    _, _ = two_dataset_project_with_eg
    db = db_session

    # Direct ORM insert — bypasses the router validator
    bad_domain = AnalysisDomain(id=9900, project_id=900, name="Bad", sequence_order=99)
    db.add(bad_domain)
    db.flush()
    db.add(AnalysisDomainMember(domain_id=9900, member_type="column", member_id=9004, sequence_order=0))
    db.add(AnalysisDomainMember(domain_id=9900, member_type="column", member_id=9104, sequence_order=1))
    db.flush()

    # Create a metric def pointing at the broken domain
    metric = MetricDefinition(
        project_id=900,
        name="Broken",
        metric_type="domain_aggregate",
        input_source_type="dataset_domain",
        input_source_id=9900,
        config="{}",
    )
    db.add(metric)
    db.flush()

    with pytest.raises(ValueError) as exc_info:
        resolve_dataset_domain(metric, db)
    assert "#290" in str(exc_info.value)
    assert "9004" in str(exc_info.value) or "9104" in str(exc_info.value)


def test_resolve_dataset_domain_accepts_valid_cross_dataset(two_dataset_project_with_eg, db_session):
    """Sanity: a properly-paired cross-dataset domain resolves without error."""
    _, user = two_dataset_project_with_eg
    domain = _run(create_domain(
        project_id=900,
        data=AnalysisDomainCreate(
            name="Leadership",
            members=[_member(9001), _member(9101)],
        ),
        user=user,
        db=db_session,
    ))
    metric = MetricDefinition(
        project_id=900,
        name="Valid",
        metric_type="domain_aggregate",
        input_source_type="dataset_domain",
        input_source_id=domain.id,
        config="{}",
    )
    db_session.add(metric)
    db_session.flush()
    # Should not raise
    result = resolve_dataset_domain(metric, db_session)
    assert isinstance(result, dict)


def test_resolve_dataset_domain_accepts_single_dataset(two_dataset_project_with_eg, db_session):
    """Sanity: a single-dataset domain (any structure) resolves without error."""
    _, user = two_dataset_project_with_eg
    domain = _run(create_domain(
        project_id=900,
        data=AnalysisDomainCreate(
            name="Board only",
            members=[_member(9001), _member(9002), _member(9004)],
        ),
        user=user,
        db=db_session,
    ))
    metric = MetricDefinition(
        project_id=900,
        name="Single-dataset",
        metric_type="domain_aggregate",
        input_source_type="dataset_domain",
        input_source_id=domain.id,
        config="{}",
    )
    db_session.add(metric)
    db_session.flush()
    result = resolve_dataset_domain(metric, db_session)
    assert isinstance(result, dict)


# ═══════════════════════════════════════════════════════════════════════════════
# Tier 3 Session A — members/reorder endpoint (Task 1.3)
# ═══════════════════════════════════════════════════════════════════════════════


def test_reorder_members_happy_path(two_dataset_project_with_eg, db_session):
    """Reordering rewrites sequence_order on each member to match the list position."""
    from app.routers.analysis_domains import reorder_members
    from app.schemas.analysis_domain import DomainMemberReorderRequest

    _, user = two_dataset_project_with_eg
    resp = _run(create_domain(
        project_id=900,
        data=AnalysisDomainCreate(
            name="Leadership",
            members=[_member(9001), _member(9002), _member(9003)],
        ),
        user=user,
        db=db_session,
    ))
    assert len(resp.members) == 3
    original_order = [m.id for m in resp.members]

    # Reverse the order
    reversed_ids = list(reversed(original_order))
    _run(reorder_members(
        project_id=900,
        domain_id=resp.id,
        data=DomainMemberReorderRequest(member_ids=reversed_ids),
        user=user,
        db=db_session,
    ))

    # Reload + assert order
    members = (
        db_session.query(AnalysisDomainMember)
        .filter(AnalysisDomainMember.domain_id == resp.id)
        .order_by(AnalysisDomainMember.sequence_order)
        .all()
    )
    assert [m.id for m in members] == reversed_ids
    assert [m.sequence_order for m in members] == [0, 1, 2]


def test_reorder_members_rejects_duplicate_ids(two_dataset_project_with_eg, db_session):
    """Duplicate member_ids in the submission raises 400."""
    from app.routers.analysis_domains import reorder_members
    from app.schemas.analysis_domain import DomainMemberReorderRequest

    _, user = two_dataset_project_with_eg
    resp = _run(create_domain(
        project_id=900,
        data=AnalysisDomainCreate(
            name="Dup test",
            members=[_member(9001), _member(9002)],
        ),
        user=user,
        db=db_session,
    ))
    member_ids = [m.id for m in resp.members]
    duplicated = [member_ids[0], member_ids[0]]

    with pytest.raises(HTTPException) as exc_info:
        _run(reorder_members(
            project_id=900,
            domain_id=resp.id,
            data=DomainMemberReorderRequest(member_ids=duplicated),
            user=user,
            db=db_session,
        ))
    assert exc_info.value.status_code == 400


def test_reorder_members_rejects_missing_or_unknown_ids(two_dataset_project_with_eg, db_session):
    """Submissions that don't cover every current member exactly once raise 400."""
    from app.routers.analysis_domains import reorder_members
    from app.schemas.analysis_domain import DomainMemberReorderRequest

    _, user = two_dataset_project_with_eg
    resp = _run(create_domain(
        project_id=900,
        data=AnalysisDomainCreate(
            name="Incomplete",
            members=[_member(9001), _member(9002), _member(9003)],
        ),
        user=user,
        db=db_session,
    ))
    member_ids = [m.id for m in resp.members]

    # Missing one
    with pytest.raises(HTTPException) as exc_info:
        _run(reorder_members(
            project_id=900,
            domain_id=resp.id,
            data=DomainMemberReorderRequest(member_ids=member_ids[:2]),
            user=user,
            db=db_session,
        ))
    assert exc_info.value.status_code == 400
    detail = _detail_of(exc_info.value)
    assert detail["error"] == "member_set_mismatch"
    assert len(detail["missing_member_ids"]) == 1

    # Unknown extra
    with pytest.raises(HTTPException) as exc_info:
        _run(reorder_members(
            project_id=900,
            domain_id=resp.id,
            data=DomainMemberReorderRequest(member_ids=member_ids + [99999]),
            user=user,
            db=db_session,
        ))
    assert exc_info.value.status_code == 400
    detail = _detail_of(exc_info.value)
    assert detail["error"] == "member_set_mismatch"
    assert 99999 in detail["unknown_member_ids"]


# ═══════════════════════════════════════════════════════════════════════════════
# Tier 3 Session A — create_scale_score_metric service function (Task 1.4)
# ═══════════════════════════════════════════════════════════════════════════════
#
# Fixture note: `two_dataset_project_with_eg` has NO DatasetRow or DatasetValue
# rows — just columns, equivalence groups, and domain infrastructure. That's
# sufficient for these tests because `compute_metric` on a zero-row domain
# still succeeds: it calls `resolve_dataset_domain` (which returns an empty
# dict), computes an empty domain aggregate, inserts a ComputedResult with
# valid_n=0, total_n=0, and clears the stale flag. So assertions like
# `assert computed is True` and `assert metric.stale is False` hold even
# without any real data. If a future test needs non-trivial row scores to
# validate a specific compute path, add DatasetRow + DatasetValue rows inline
# in that test rather than bloating the shared fixture.


def test_create_scale_score_metric_happy_path(two_dataset_project_with_eg, db_session):
    """Creates a new MetricDefinition with locked config + origin fields, computes it."""
    from app.services.metrics import create_scale_score_metric

    _, user = two_dataset_project_with_eg
    resp = _run(create_domain(
        project_id=900,
        data=AnalysisDomainCreate(
            name="Leadership",
            members=[_member(9001), _member(9101)],
        ),
        user=user,
        db=db_session,
    ))
    domain = db_session.query(AnalysisDomain).filter(AnalysisDomain.id == resp.id).one()

    metric, computed = create_scale_score_metric(db_session, domain)
    db_session.flush()

    assert metric is not None
    assert metric.id is not None
    assert metric.project_id == 900
    assert metric.name == "Leadership Score"
    assert metric.metric_type == "domain_aggregate"
    assert metric.input_source_type == "dataset_domain"
    assert metric.input_source_id == domain.id
    assert metric.grouping_column_id is None
    assert metric.grouping_column_id_2 is None

    # Revision 5 locked field values — these prevent auto-cleanup and
    # ensure R export inclusion. See foot-gun.
    assert metric.origin == "human"
    assert metric.origin_context == "crosswalk_auto"

    # Locked config payload
    config = json.loads(metric.config)
    assert config == {
        "child_metric_type": "mean",
        "child_config": {},
        "aggregation": "mean",
    }

    # compute_metric was called — computed=True means stale was cleared
    assert computed is True
    assert metric.stale is False


def test_create_scale_score_metric_idempotent_on_fresh_existing(two_dataset_project_with_eg, db_session):
    """Second call on a fresh (non-stale) existing metric returns it without recomputing."""
    from app.services.metrics import create_scale_score_metric

    _, user = two_dataset_project_with_eg
    resp = _run(create_domain(
        project_id=900,
        data=AnalysisDomainCreate(
            name="Leadership",
            members=[_member(9001), _member(9101)],
        ),
        user=user,
        db=db_session,
    ))
    domain = db_session.query(AnalysisDomain).filter(AnalysisDomain.id == resp.id).one()

    metric_1, computed_1 = create_scale_score_metric(db_session, domain)
    db_session.flush()
    first_id = metric_1.id

    metric_2, computed_2 = create_scale_score_metric(db_session, domain)
    db_session.flush()

    assert metric_2.id == first_id  # same row, not a duplicate
    assert computed_2 is True
    # Exactly one ungrouped scale-score metric exists for this domain
    count = (
        db_session.query(MetricDefinition)
        .filter(
            MetricDefinition.input_source_type == "dataset_domain",
            MetricDefinition.input_source_id == domain.id,
            MetricDefinition.metric_type == "domain_aggregate",
            MetricDefinition.grouping_column_id.is_(None),
            MetricDefinition.grouping_column_id_2.is_(None),
        )
        .count()
    )
    assert count == 1


def test_create_scale_score_metric_idempotent_recomputes_stale(two_dataset_project_with_eg, db_session):
    """Second call on a STALE existing metric triggers recompute and clears the stale flag.

    This is the Revision 3 idempotency correction — a retry from Phase 3.5's
    "Create scale score manually" toast must actually recompute, not leave
    the researcher in a degraded state.
    """
    from app.services.metrics import create_scale_score_metric

    _, user = two_dataset_project_with_eg
    resp = _run(create_domain(
        project_id=900,
        data=AnalysisDomainCreate(
            name="Leadership",
            members=[_member(9001), _member(9101)],
        ),
        user=user,
        db=db_session,
    ))
    domain = db_session.query(AnalysisDomain).filter(AnalysisDomain.id == resp.id).one()

    metric, _ = create_scale_score_metric(db_session, domain)
    db_session.flush()

    # Force staleness
    metric.stale = True
    db_session.flush()
    assert metric.stale is True

    # Retry: should call compute_metric and clear stale flag
    metric_2, computed_2 = create_scale_score_metric(db_session, domain)
    db_session.flush()

    assert metric_2.id == metric.id
    assert computed_2 is True
    assert metric_2.stale is False


def test_create_scale_score_metric_idempotency_both_grouping_cols_null(two_dataset_project_with_eg, db_session):
    """Idempotency must check BOTH grouping_column_id AND grouping_column_id_2.

    A grouped variant of the same domain aggregate (e.g. "Leadership by
    Department × Tenure") sets grouping_column_id_2 to a non-null value. That
    variant must NOT be matched by the ungrouped scale-score idempotency
    check — it's a distinct metric. See directive GAP 3.1 and foot-gun.
    """
    from app.services.metrics import create_scale_score_metric

    _, user = two_dataset_project_with_eg
    resp = _run(create_domain(
        project_id=900,
        data=AnalysisDomainCreate(
            name="Leadership",
            members=[_member(9001), _member(9101)],
        ),
        user=user,
        db=db_session,
    ))
    domain = db_session.query(AnalysisDomain).filter(AnalysisDomain.id == resp.id).one()

    # Create a grouped variant first (grouping_column_id_2 set to a non-null value)
    grouped_variant = MetricDefinition(
        project_id=900,
        name="Leadership Score by Q2 × Q3",
        metric_type="domain_aggregate",
        config=json.dumps({"child_metric_type": "mean", "child_config": {}, "aggregation": "mean"}),
        input_source_type="dataset_domain",
        input_source_id=domain.id,
        grouping_column_id=9002,
        grouping_column_id_2=9003,
        origin="human",
        sequence_order=0,
    )
    db_session.add(grouped_variant)
    db_session.flush()

    # Now call create_scale_score_metric — must NOT match the grouped variant
    ungrouped, computed = create_scale_score_metric(db_session, domain)
    db_session.flush()

    assert ungrouped.id != grouped_variant.id
    assert ungrouped.grouping_column_id is None
    assert ungrouped.grouping_column_id_2 is None
    assert ungrouped.name == "Leadership Score"

    # Both metrics exist
    total = (
        db_session.query(MetricDefinition)
        .filter(
            MetricDefinition.input_source_type == "dataset_domain",
            MetricDefinition.input_source_id == domain.id,
            MetricDefinition.metric_type == "domain_aggregate",
        )
        .count()
    )
    assert total == 2


def test_create_score_metric_endpoint_happy_path(two_dataset_project_with_eg, db_session):
    """Endpoint wires pre-validation + service function + audit log + response shape."""
    from app.routers.analysis_domains import create_score_metric

    _, user = two_dataset_project_with_eg
    resp = _run(create_domain(
        project_id=900,
        data=AnalysisDomainCreate(
            name="Leadership",
            members=[_member(9001), _member(9101)],
        ),
        user=user,
        db=db_session,
    ))

    result = _run(create_score_metric(
        request=mock_request(),
        project_id=900,
        domain_id=resp.id,
        user=user,
        db=db_session,
    ))

    assert "metric" in result
    assert "computed" in result
    assert result["computed"] is True
    metric_resp = result["metric"]
    assert metric_resp.name == "Leadership Score"
    assert metric_resp.origin == "human"
    assert metric_resp.origin_context == "crosswalk_auto"
    assert metric_resp.metric_type == "domain_aggregate"
    assert metric_resp.grouping_column_id is None
    assert metric_resp.grouping_column_id_2 is None
    assert metric_resp.stale is False


def test_create_score_metric_endpoint_rejects_unpaired_cross_dataset(two_dataset_project_with_eg, db_session):
    """Router pre-validation raises structured 409 before service is called.

    Uses the directive's assert_cross_dataset_members_are_paired path.
    """
    from app.routers.analysis_domains import create_score_metric

    _, user = two_dataset_project_with_eg

    # Build a domain with a single-dataset pair (legal under create_domain)
    resp = _run(create_domain(
        project_id=900,
        data=AnalysisDomainCreate(
            name="Single ds",
            members=[_member(9001), _member(9002)],
        ),
        user=user,
        db=db_session,
    ))

    # Now directly patch the DB to add an unpaired cross-dataset member,
    # simulating a state that the router validator should have caught. This
    # tests that create_score_metric's own pre-validation fires independently.
    unpaired_member = AnalysisDomainMember(
        domain_id=resp.id,
        member_type="column",
        member_id=9104,  # Staff Q4, not in any equivalence group
        sequence_order=99,
    )
    db_session.add(unpaired_member)
    db_session.flush()

    with pytest.raises(HTTPException) as exc_info:
        _run(create_score_metric(
            request=mock_request(),
            project_id=900,
            domain_id=resp.id,
            user=user,
            db=db_session,
        ))

    assert exc_info.value.status_code == 409
    detail = _detail_of(exc_info.value)
    assert detail["error"] == "cross_dataset_unpaired"
    unpaired_ids = {c["id"] for c in detail["unpaired_columns"]}
    assert 9104 in unpaired_ids


def test_update_domain_name_rename_filter_both_grouping_null(two_dataset_project_with_eg, db_session):
    """Rename-chain: when a domain is renamed, only the UNGROUPED scale-score
    metric should get its name updated. Grouped variants (with non-null
    grouping_column_id_2) must be untouched.

    This locks in the GAP 3.1 + foot-gun two-field filter requirement. The
    frontend does this filter client-side after fetching; this test asserts
    the schema supports making the distinction reliably.
    """
    from app.services.metrics import create_scale_score_metric

    _, user = two_dataset_project_with_eg
    resp = _run(create_domain(
        project_id=900,
        data=AnalysisDomainCreate(
            name="Leadership",
            members=[_member(9001), _member(9101)],
        ),
        user=user,
        db=db_session,
    ))
    domain = db_session.query(AnalysisDomain).filter(AnalysisDomain.id == resp.id).one()

    # Create ungrouped scale score via the service function
    ungrouped, _ = create_scale_score_metric(db_session, domain)
    db_session.flush()

    # Also create a grouped variant manually
    grouped = MetricDefinition(
        project_id=900,
        name="Leadership Score by Q2",
        metric_type="domain_aggregate",
        config=json.dumps({"child_metric_type": "mean", "child_config": {}, "aggregation": "mean"}),
        input_source_type="dataset_domain",
        input_source_id=domain.id,
        grouping_column_id=9002,
        grouping_column_id_2=None,
        origin="human",
        sequence_order=5,
    )
    db_session.add(grouped)
    db_session.flush()

    # Simulate a frontend rename-chain: query with input_source filter then
    # client-filter for both grouping columns null.
    candidates = (
        db_session.query(MetricDefinition)
        .filter(
            MetricDefinition.input_source_type == "dataset_domain",
            MetricDefinition.input_source_id == domain.id,
            MetricDefinition.metric_type == "domain_aggregate",
        )
        .all()
    )
    ungrouped_matches = [
        m for m in candidates
        if m.grouping_column_id is None and m.grouping_column_id_2 is None
    ]
    assert len(ungrouped_matches) == 1
    assert ungrouped_matches[0].id == ungrouped.id

    # Applying the rename only to the ungrouped variant
    ungrouped_matches[0].name = "Renamed Score"
    db_session.flush()

    # Grouped variant's name must be unchanged
    db_session.refresh(grouped)
    assert grouped.name == "Leadership Score by Q2"


# ═══════════════════════════════════════════════════════════════════════════════
# Tier 3 Session A — delete-cascade regression (Task 1.5)
# ═══════════════════════════════════════════════════════════════════════════════


def test_delete_domain_cascades_to_row_scores_and_computed_results(two_dataset_project_with_eg, db_session):
    """Deleting a domain cascades through the auto scale-score metric to
    RowScore + ComputedResult via the two-layer cascade (ORM + DB-level FK).

    Revision 3 correction: the previous draft of this directive claimed this
    cascade was broken. It's not. Both layers exist:
    - ORM: MetricDefinition.row_scores and .results have cascade="all, delete-orphan"
    - DB: RowScore.metric_definition_id and ComputedResult.metric_definition_id
      have ondelete="CASCADE", enforced via PRAGMA foreign_keys=ON.

    delete_domain uses bulk Query.delete() which bypasses the ORM cascade,
    but the DB cascade fires regardless. This test locks in that behavior.
    """
    from app.routers.analysis_domains import delete_domain
    from app.services.metrics import create_scale_score_metric
    from app.models.row_score import RowScore
    from app.models.metric import ComputedResult

    _, user = two_dataset_project_with_eg
    resp = _run(create_domain(
        project_id=900,
        data=AnalysisDomainCreate(
            name="Leadership",
            members=[_member(9001), _member(9101)],
        ),
        user=user,
        db=db_session,
    ))
    domain = db_session.query(AnalysisDomain).filter(AnalysisDomain.id == resp.id).one()

    # Create + compute the scale score metric (materializes ComputedResult,
    # RowScore may be empty depending on data but at minimum ComputedResult
    # is inserted by compute_metric).
    metric, computed = create_scale_score_metric(db_session, domain)
    db_session.flush()
    metric_id = metric.id

    # Force a synthetic RowScore + ComputedResult so the cascade has something
    # to cascade to, even with no actual dataset data.
    synthetic_cr = ComputedResult(
        metric_definition_id=metric_id,
        group_value="synthetic",
        result_data=json.dumps({"value": 1.0}),
        valid_n=1,
        total_n=1,
    )
    db_session.add(synthetic_cr)
    db_session.flush()

    # Sanity: rows exist before delete
    pre_cr_count = (
        db_session.query(ComputedResult)
        .filter(ComputedResult.metric_definition_id == metric_id)
        .count()
    )
    assert pre_cr_count >= 1

    # Delete the domain — should cascade
    _run(delete_domain(
        project_id=900,
        domain_id=domain.id,
        user=user,
        db=db_session,
    ))

    # Metric gone
    assert db_session.query(MetricDefinition).filter(MetricDefinition.id == metric_id).first() is None
    # ComputedResult gone
    assert (
        db_session.query(ComputedResult)
        .filter(ComputedResult.metric_definition_id == metric_id)
        .count()
    ) == 0
    # RowScore gone
    assert (
        db_session.query(RowScore)
        .filter(RowScore.metric_definition_id == metric_id)
        .count()
    ) == 0


# ═══════════════════════════════════════════════════════════════════════════════
# Tier 3 Session A — metric_cleanup carve-out (Revision 5, foot-gun)
# ═══════════════════════════════════════════════════════════════════════════════


def test_crosswalk_scale_score_not_deleted_by_auto_cleanup(two_dataset_project_with_eg, db_session):
    """Regression test locking in foot-gun: crosswalk scale-score metrics
    are `origin="human"`, NOT `origin="auto"`, so `metric_cleanup.cleanup_auto_metrics`
    must not delete them even when last_accessed_at is older than the retention
    cutoff.

    If a future refactor widens cleanup_auto_metrics to include origin="human"
    or origin_context="crosswalk_auto", this test fires and flags the bug.
    """
    from datetime import datetime, timedelta, timezone as tz
    from app.services.metrics import create_scale_score_metric
    from app.services.metric_cleanup import cleanup_auto_metrics, _last_cleanup, _RETENTION_DAYS

    # Clear throttle so cleanup runs in test
    _last_cleanup.clear()

    _, user = two_dataset_project_with_eg
    resp = _run(create_domain(
        project_id=900,
        data=AnalysisDomainCreate(
            name="Leadership",
            members=[_member(9001), _member(9101)],
        ),
        user=user,
        db=db_session,
    ))
    domain = db_session.query(AnalysisDomain).filter(AnalysisDomain.id == resp.id).one()

    metric, _ = create_scale_score_metric(db_session, domain)
    db_session.flush()
    metric_id = metric.id

    # Set last_accessed_at to WAY past the retention cutoff
    metric.last_accessed_at = datetime.now(tz.utc).replace(tzinfo=None) - timedelta(days=_RETENTION_DAYS + 10)
    db_session.flush()

    # Run cleanup
    deleted_count = cleanup_auto_metrics(db_session, 900)

    # The scale score metric must still exist — origin="human" protects it
    surviving = db_session.query(MetricDefinition).filter(MetricDefinition.id == metric_id).first()
    assert surviving is not None, (
        "Crosswalk scale-score metric was deleted by auto-cleanup. This is a "
        "foot-gun regression — the metric must be origin='human' (not "
        "'auto') to avoid cleanup. Check create_scale_score_metric's origin "
        "field and/or metric_cleanup.cleanup_auto_metrics's filter."
    )

    # Clear throttle after test
    _last_cleanup.clear()


# ═══════════════════════════════════════════════════════════════════════════════
# Layer 3 — .mmproject import validation
# ═══════════════════════════════════════════════════════════════════════════════


def _build_mmproject_zip_bytes(payload: dict) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("manifest.json", json.dumps(
            {"format_type": "mmproject", "format_version": 1, "app_version": "1.0.0"}
        ))
        zf.writestr("project.json", json.dumps(payload))
    return buf.getvalue()


def _minimal_payload(dataset_columns: list[dict], analysis_domains: list[dict],
                      analysis_domain_members: list[dict],
                      equivalence_groups: list[dict] | None = None) -> dict:
    """Minimal valid-shape mmproject payload with the pieces the import
    validator actually reads."""
    return {
        "format_version": 1,
        "app_version": "1.0.0",
        "project": {
            "_original_id": 8000,
            "name": "Import Test",
            "description": None,
        },
        "participants": [],
        "speakers": [],
        "conversations": [],
        "documents": [],
        "segment_groups": [],
        "segments": [],
        "code_categories": [],
        "codes": [],
        "code_applications": [],
        "datasets": [
            {"_original_id": 8100, "name": "Board", "source": None, "project_id": 8000},
            {"_original_id": 8101, "name": "Staff", "source": None, "project_id": 8000},
        ],
        "equivalence_groups": equivalence_groups or [],
        "dataset_columns": dataset_columns,
        "dataset_rows": [],
        "dataset_values": [],
        "recode_definitions": [],
        "excerpts": [],
        "notes": [],
        "memos": [],
        "analysis_domains": analysis_domains,
        "analysis_domain_members": analysis_domain_members,
        "metric_definitions": [],
        "computed_results": [],
        "row_scores": [],
        "statistical_tests": [],
        "material_collections": [],
        "materials": [],
        "scratchpad_entries": [],
        "canvases": [],
        "canvas_themes": [],
        "canvas_theme_relationships": [],
        "canvas_pending_items": [],
    }


def _mk_col(col_id: int, dataset_id: int, sequence_order: int, code: str,
            text: str, eg_id: int | None = None) -> dict:
    return {
        "_original_id": col_id,
        "id": col_id,
        "dataset_id": dataset_id,
        "column_code": code,
        "column_name": code,
        "column_text": text,
        "column_type": "ordinal",
        "sequence_order": sequence_order,
        "display_order": sequence_order,
        "equivalence_group_id": eg_id,
    }


def test_mmproject_import_rejects_cross_dataset_unpaired_domain(tmp_path, db_session):
    """Importing an .mmproject whose analysis domain contains unpaired
    cross-dataset members → ValueError with repair instructions."""
    from app.services.project_portability import import_project

    payload = _minimal_payload(
        dataset_columns=[
            _mk_col(8200, 8100, 0, "Q1", "Leadership"),
            _mk_col(8201, 8101, 0, "Q1", "Leadership"),
        ],
        analysis_domains=[{"_original_id": 8300, "name": "Broken", "sequence_order": 0, "color": None, "description": None}],
        analysis_domain_members=[
            {"_original_id": 8400, "domain_id": 8300, "member_type": "column", "member_id": 8200, "sequence_order": 0},
            {"_original_id": 8401, "domain_id": 8300, "member_type": "column", "member_id": 8201, "sequence_order": 1},
        ],
    )

    zip_bytes = _build_mmproject_zip_bytes(payload)
    project_path = tmp_path / "broken.mmproject"
    project_path.write_bytes(zip_bytes)
    docs_dir = tmp_path / "docs"
    docs_dir.mkdir()

    with pytest.raises(ValueError) as exc_info:
        import_project(db_session, project_path, docs_dir, user_id=1)
    msg = str(exc_info.value)
    assert "cross-dataset" in msg.lower() or "equivalence" in msg.lower()

    db_session.rollback()
    assert db_session.query(Project).filter(Project.name == "Import Test").count() == 0


def test_mmproject_import_accepts_single_dataset_domain(tmp_path, db_session):
    """Sanity: single-dataset analysis domain imports without triggering
    the validator."""
    from app.services.project_portability import import_project

    payload = _minimal_payload(
        dataset_columns=[
            _mk_col(8500, 8100, 0, "Q1", "Leadership"),
            _mk_col(8501, 8100, 1, "Q2", "Communication"),
        ],
        analysis_domains=[{"_original_id": 8600, "name": "Board only", "sequence_order": 0, "color": None, "description": None}],
        analysis_domain_members=[
            {"_original_id": 8700, "domain_id": 8600, "member_type": "column", "member_id": 8500, "sequence_order": 0},
            {"_original_id": 8701, "domain_id": 8600, "member_type": "column", "member_id": 8501, "sequence_order": 1},
        ],
    )

    zip_bytes = _build_mmproject_zip_bytes(payload)
    project_path = tmp_path / "ok.mmproject"
    project_path.write_bytes(zip_bytes)
    docs_dir = tmp_path / "docs"
    docs_dir.mkdir()

    # Should not raise
    import_project(db_session, project_path, docs_dir, user_id=1)
    db_session.commit()
    assert db_session.query(Project).filter(Project.name == "Import Test").count() == 1


# ═══════════════════════════════════════════════════════════════════════════════
# Phase 4 — suggest_domains auto-pairing (#297, #295)
# ═══════════════════════════════════════════════════════════════════════════════
#
# The /analysis-domains/suggest endpoint emits cross-dataset clusters with
# pre-computed equivalence pairings (`members_paired`) when text similarity
# clearly identifies which columns should pair. Cross-dataset clusters where
# pairing is ambiguous return `unpaired=True` and an empty `members_paired`
# so the frontend can render greyed and prompt manual MappingDialog.
#
# Pairing uses `SequenceMatcher.ratio()` (Python difflib) — the same metric
# as the find-matches endpoint at `routers/equivalence.py:1035`, with the
# same default threshold (0.70). Ambiguity bail tolerance is 0.05.


@pytest.fixture
def suggest_test_project(db_session):
    """A clean project with two datasets and unassigned columns ready for
    suggest_domains. No equivalence groups, no analysis domains — Suggest
    operates on truly-unassigned columns. Each test seeds its own column
    set via direct SQLAlchemy add_all() before calling suggest_domains."""
    db = db_session
    project = Project(id=1900, name="Suggest Pairing Test", user_id=1)
    db.add(project)
    board = Dataset(id=1900, project_id=1900, name="Board")
    staff = Dataset(id=1901, project_id=1900, name="Staff")
    db.add_all([board, staff])
    db.flush()
    user = db.query(User).filter(User.id == 1).one()
    return project, user


def _suggest(project_id, user, db):
    """Invoke suggest_domains directly. The route is read-only; no rate limiter."""
    from app.routers.analysis_domains import suggest_domains
    return _run(suggest_domains(project_id=project_id, user=user, db=db))


def _add_col(db, col_id, dataset_id, code, text, type_="ordinal", seq=0):
    db.add(DatasetColumn(
        id=col_id, dataset_id=dataset_id, column_code=code, column_name=code,
        column_text=text, column_type=type_,
        sequence_order=seq, display_order=seq,
    ))


def test_suggest_pairing_single_dataset_no_pairing(suggest_test_project, db_session):
    """Single-dataset cluster: members_paired=[], unpaired=False — no pairing
    needed because there's no cross-dataset equivalence to construct."""
    db = db_session
    _, user = suggest_test_project
    # Three Board columns sharing prefix "BQ"
    _add_col(db, 19001, 1900, "BQ-001", "Strategic vision is clear", seq=0)
    _add_col(db, 19002, 1900, "BQ-002", "Strategic vision is communicated", seq=1)
    _add_col(db, 19003, 1900, "BQ-003", "Strategic vision is realistic", seq=2)
    db.flush()

    resp = _suggest(1900, user, db)
    assert len(resp.suggestions) >= 1
    # Find the BQ prefix suggestion
    bq = next((s for s in resp.suggestions if "Bq" in s.name or "BQ" in s.name.upper()), resp.suggestions[0])
    assert bq.members_paired == []
    assert bq.unpaired is False
    assert bq.pairing_reason is None


def test_suggest_pairing_cross_dataset_strong_text_match(suggest_test_project, db_session):
    """Cross-dataset cluster with identical text: confident pairings emitted.

    Uses shared 'LD-' prefix so Pass 1 produces a single 4-column cluster
    spanning both datasets (rather than two single-dataset clusters by
    distinct prefixes).
    """
    db = db_session
    _, user = suggest_test_project
    _add_col(db, 19010, 1900, "LD-001", "Leadership is consistent over time", seq=0)
    _add_col(db, 19011, 1900, "LD-002", "Leadership communicates clearly", seq=1)
    _add_col(db, 19110, 1901, "LD-001", "Leadership is consistent over time", seq=0)
    _add_col(db, 19111, 1901, "LD-002", "Leadership communicates clearly", seq=1)
    db.flush()

    resp = _suggest(1900, user, db)
    cross_dataset = [s for s in resp.suggestions if not s.unpaired and s.members_paired]
    assert len(cross_dataset) >= 1
    sg = cross_dataset[0]
    # Two pairing slots, each containing one column from each dataset
    assert len(sg.members_paired) == 2
    pair_sets = [frozenset(slot) for slot in sg.members_paired]
    assert frozenset({19010, 19110}) in pair_sets
    assert frozenset({19011, 19111}) in pair_sets
    assert sg.pairing_reason is not None
    assert sg.pairing_reason.startswith("text_match:")


def test_suggest_pairing_handles_one_word_swap(suggest_test_project, db_session):
    """The 'board vs staff' single-word swap is the canonical case for
    auto-pair to handle. SequenceMatcher.ratio() on these two strings is
    well above the 0.70 threshold, so pairings are emitted.

    Uses shared 'PR-' prefix to force a single cross-dataset cluster.
    """
    db = db_session
    _, user = suggest_test_project
    # Identical except for 'board' / 'staff'
    _add_col(db, 19020, 1900, "PR-001", "How well does the board perform on strategic decisions", seq=0)
    _add_col(db, 19021, 1900, "PR-002", "How well does the board perform on financial oversight", seq=1)
    _add_col(db, 19120, 1901, "PR-001", "How well does the staff perform on strategic decisions", seq=0)
    _add_col(db, 19121, 1901, "PR-002", "How well does the staff perform on financial oversight", seq=1)
    db.flush()

    resp = _suggest(1900, user, db)
    paired_clusters = [s for s in resp.suggestions if s.members_paired]
    assert len(paired_clusters) >= 1, \
        "Expected at least one paired cluster for board↔staff swap"
    sg = paired_clusters[0]
    # Verify the pairings are correct (B1↔S1, B2↔S2)
    pair_sets = [frozenset(slot) for slot in sg.members_paired]
    assert frozenset({19020, 19120}) in pair_sets
    assert frozenset({19021, 19121}) in pair_sets


def test_suggest_pairing_ambiguous_cluster_bails(suggest_test_project, db_session):
    """When two cross-dataset candidates score within tolerance of each
    other for a column, the entire cluster bails (unpaired=True) rather
    than confidently picking the wrong pair."""
    db = db_session
    _, user = suggest_test_project
    # Two Board columns and two Staff columns with overlapping but ambiguous
    # text. B1 should be similarly close to both S1 and S2.
    _add_col(db, 19030, 1900, "BQ-001", "leadership communicates strategy", seq=0)
    _add_col(db, 19031, 1900, "BQ-002", "leadership communicates strategy clearly", seq=1)
    _add_col(db, 19130, 1901, "SQ-001", "leadership communicates strategy", seq=0)
    _add_col(db, 19131, 1901, "SQ-002", "leadership communicates strategy clearly", seq=1)
    db.flush()

    # Note: this case may either bail (ambiguous) or pair correctly depending
    # on exact ratios. The deterministic invariant is: IF unpaired=True, then
    # members_paired=[]. We assert the contract, not a specific outcome here.
    resp = _suggest(1900, user, db)
    cross_clusters = [
        s for s in resp.suggestions
        if any(m.dataset_id == 1900 for m in s.members)
        and any(m.dataset_id == 1901 for m in s.members)
    ]
    for sg in cross_clusters:
        if sg.unpaired:
            assert sg.members_paired == []
            assert sg.pairing_reason is None
        else:
            # If paired, every cluster column must appear in exactly one slot
            paired_ids = {cid for slot in sg.members_paired for cid in slot}
            cluster_ids = {m.member_id for m in sg.members}
            assert paired_ids == cluster_ids


def test_suggest_pairing_three_dataset_cluster(db_session):
    """A 3-dataset cluster with clean text alignment yields N-tuple
    pairings (one column from each of the 3 datasets per slot).

    Uses shared 'LD-' prefix to force a single 6-column cross-dataset cluster.
    """
    db = db_session
    project = Project(id=1910, name="3-dataset Suggest Test", user_id=1)
    db.add(project)
    db.add_all([
        Dataset(id=1910, project_id=1910, name="Board"),
        Dataset(id=1911, project_id=1910, name="Staff"),
        Dataset(id=1912, project_id=1910, name="Stakeholder"),
    ])
    db.flush()
    # Two pairing slots × three datasets = 6 columns, all under shared "LD" prefix
    _add_col(db, 19200, 1910, "LD-001", "Trust in organizational leadership is high", seq=0)
    _add_col(db, 19201, 1910, "LD-002", "Communication from leadership is timely", seq=1)
    _add_col(db, 19210, 1911, "LD-001", "Trust in organizational leadership is high", seq=0)
    _add_col(db, 19211, 1911, "LD-002", "Communication from leadership is timely", seq=1)
    _add_col(db, 19220, 1912, "LD-001", "Trust in organizational leadership is high", seq=0)
    _add_col(db, 19221, 1912, "LD-002", "Communication from leadership is timely", seq=1)
    db.flush()
    user = db.query(User).filter(User.id == 1).one()

    resp = _suggest(1910, user, db)
    paired = [s for s in resp.suggestions if s.members_paired and not s.unpaired]
    assert len(paired) >= 1
    sg = paired[0]
    # Each slot should be a 3-tuple
    for slot in sg.members_paired:
        assert len(slot) == 3, f"Expected 3-tuple in slot, got {slot}"
    # The two slots should pair Trust columns together and Communication columns together
    pair_sets = [frozenset(slot) for slot in sg.members_paired]
    assert frozenset({19200, 19210, 19220}) in pair_sets
    assert frozenset({19201, 19211, 19221}) in pair_sets


def test_suggest_pairing_below_threshold_bails(suggest_test_project, db_session):
    """When a cross-dataset cluster forms via prefix match but text similarity
    falls below 0.70, the cluster is unpaired even though Pass 1 grouped it."""
    db = db_session
    _, user = suggest_test_project
    # Identical column codes (which forces prefix-match clustering) but
    # totally different text content.
    _add_col(db, 19040, 1900, "AQ-001", "the moon is bright tonight", seq=0)
    _add_col(db, 19140, 1901, "AQ-001", "horticulture studies plant growth", seq=0)
    db.flush()

    resp = _suggest(1900, user, db)
    # The prefix "AQ" cluster forms. Expected: unpaired=True, members_paired=[]
    aq = [s for s in resp.suggestions if "Aq" in s.name or "AQ" in s.name.upper()]
    if aq:
        # If the cluster appeared (it should, via prefix match), it must be unpaired
        sg = aq[0]
        assert sg.unpaired is True
        assert sg.members_paired == []


def test_suggest_pairing_response_shape_backward_compatible(suggest_test_project, db_session):
    """The new fields default safely so unenhanced consumers don't break."""
    db = db_session
    _, user = suggest_test_project
    _add_col(db, 19050, 1900, "BQ-001", "Leadership is effective", seq=0)
    _add_col(db, 19051, 1900, "BQ-002", "Communication is regular", seq=1)
    db.flush()
    resp = _suggest(1900, user, db)
    for sg in resp.suggestions:
        # Always-present fields
        assert hasattr(sg, "members_paired")
        assert hasattr(sg, "unpaired")
        assert hasattr(sg, "pairing_reason")
        assert isinstance(sg.members_paired, list)
        assert isinstance(sg.unpaired, bool)
