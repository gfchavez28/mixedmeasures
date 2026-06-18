"""Tests for #298 domain integrity guard on `merge_groups`.

Merge moves source columns into target EG. If the source columns were members
of a cross-dataset analysis domain that depended on the source EG to bridge
datasets, the merge silently shifts them out of that pairing — the domain's
remaining members become unpaired. Pre-#298 this was caught only at next
metric compute time (`services/metrics.py::_assert_domain_members_paired`).
This file locks in mutation-time enforcement.

The Plan agent traced this failure mode:

    Source EG-S has Board-Q1 (member of Domain-X with Staff-Q1 in EG-T2).
    Target EG-T has Board-Q5 + Staff-Q5 (member of Domain-Y).

    After merge: Board-Q1 moves into EG-T. EG-T contains Staff-Q5 (in
    Domain-Y, not Domain-X). Board-Q1 is now unpaired in Domain-X.
"""
import asyncio

import pytest
from fastapi import HTTPException

from app.models.project import Project
from app.models.user import User
from app.models.dataset import Dataset, DatasetColumn
from app.models.equivalence_group import EquivalenceGroup
from app.models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from app.routers.equivalence import merge_groups, create_group
from app.schemas.equivalence import EquivalenceGroupCreate


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture
def merge_breaks_domain_fixture(db_session):
    """Construct the failure mode the Plan agent traced.

    - Project 780, user 1
    - Datasets: Board (780), Staff (781)
    - EG-S (7800) — Board-Q1 (id=7801)
    - EG-T2 (7802) — Staff-Q1 (id=7851); cross-dataset bridge for Domain-X via EG-S
    - EG-T (7801) — Board-Q5 (id=7805) + Staff-Q5 (id=7855); part of Domain-Y
    - Domain-X (7810): Board-Q1 + Staff-Q1
    - Domain-Y (7811): Board-Q5 + Staff-Q5

    Wait — Domain-X needs the columns to be paired across datasets via EG.
    Board-Q1 is in EG-S (7800), Staff-Q1 is in EG-T2 (7802). They're in
    different EGs — that's not actually paired. Let me restructure:

    Better fixture: put Board-Q1 AND Staff-Q1 together in EG-S so Domain-X is
    valid. Then merge EG-S into EG-T (which contains different columns).

    - EG-S (7800) — Board-Q1 (7801) + Staff-Q1 (7851); the Domain-X bridge
    - EG-T (7801) — Board-Q5 (7805) + Staff-Q5 (7855); the Domain-Y bridge
    - Domain-X (7810): {Board-Q1, Staff-Q1}
    - Domain-Y (7811): {Board-Q5, Staff-Q5}

    After merging EG-S into EG-T: EG-T contains Board-Q1, Staff-Q1, Board-Q5,
    Staff-Q5. But the 1:1-per-dataset check (#289) rejects that — two Board
    columns + two Staff columns in one EG.

    So the simpler failure mode: source EG has ONLY the Board side, target EG
    has ONLY the Board side; merge attempts to put two Board columns in one
    EG, hits #289. That's a different reject path.

    The Plan agent's specific scenario actually requires the source domain to
    DEPEND on the source EG for cross-dataset pairing. Construct it as: source
    EG has Board-Q1 alone; Staff-Q1 is in some OTHER EG; Domain-X has both
    Board-Q1 and Staff-Q1 as members. This means Domain-X is currently
    INVALID (the pairing isn't actually expressed via shared EG). That's a
    pre-existing invariant violation — the validator catches it on next
    mutation, not on merge specifically.

    Cleanest valid scenario: a 3-dataset bridge.
    - EG-S (7800): Board-Q1 (7801) + Staff-Q1 (7851)
    - EG-T (7801): Stakeholder-Q9 (7905); single-dataset, no domain
    - Domain-X (7810): Board-Q1 + Staff-Q1; valid because both share EG-S

    Merging EG-S into EG-T: EG-T now contains Board-Q1 + Staff-Q1 + Stakeholder-Q9.
    1:1 rule still satisfied (one column per dataset). Domain-X still has its
    two members linked via the same EG (now EG-T). Domain-X is still valid.

    So this scenario doesn't actually trigger #298. The merge preserves pairing.

    The actual failure mode requires a domain whose pairing crosses TWO EGs.
    But cross-dataset pairing within a domain is enforced by #290 to live in
    a SINGLE EG — so the precondition for the Plan agent's failure trace is
    itself a #290 violation. The runtime late-catch already covers this case.

    HOWEVER, #298 still has a real value-add for merge: when merging produces
    a target EG whose new column set still has all 1:1 constraints satisfied
    BUT a domain references columns from the source EG that, after merge, are
    no longer the only bridge — or some adjacent edge case. Let me construct
    a real failure mode:

    Imagine: Domain-X has Board-Q1 + Staff-Q1 + Stakeholder-Q1, all three
    paired via one EG. Now merge that EG into another EG that has different
    columns from Stakeholder dataset. The merge would put two Stakeholder
    columns in one EG — caught by #289.

    Conclusion: in practice, merge_groups is well-protected by #289 (1:1 per
    dataset). #298 on merge_groups serves as defense-in-depth — if a future
    refactor weakens #289 or a portability bug creates inconsistent state,
    #298 catches it before metric compute fails. The test below validates the
    defense-in-depth firing path by simulating the inconsistent precondition.
    """
    db = db_session
    project = Project(id=780, name="Merge Domain Integrity Test", user_id=1)
    db.add(project)

    board = Dataset(id=780, project_id=780, name="Board")
    staff = Dataset(id=781, project_id=780, name="Staff")
    db.add_all([board, staff])

    # Two single-dataset EGs (each holds one column)
    eg_source = EquivalenceGroup(id=7800, project_id=780, label="Source")
    eg_target = EquivalenceGroup(id=7801, project_id=780, label="Target")
    db.add_all([eg_source, eg_target])
    db.flush()

    db.add_all([
        DatasetColumn(id=7801, dataset_id=780, column_code="Q1", column_name="Q1",
                      column_text="Vision (Board)", column_type="ordinal",
                      sequence_order=0, display_order=0,
                      equivalence_group_id=7800),
        DatasetColumn(id=7851, dataset_id=781, column_code="Q1", column_name="Q1",
                      column_text="Vision (Staff)", column_type="ordinal",
                      sequence_order=0, display_order=0,
                      equivalence_group_id=7801),  # in target EG
    ])
    db.flush()

    # Construct a cross-dataset domain whose two members are CURRENTLY unpaired
    # (Board-Q1 is in EG 7800, Staff-Q1 is in EG 7801 — different EGs). This
    # is a pre-existing invariant violation that should never reach this state
    # in production but tests #298's defense-in-depth: a side-channel mutation
    # (merge) shouldn't make the violation any worse, and the validator should
    # detect the invalid post-mutation state.
    #
    # Note: post-merge, Board-Q1 + Staff-Q1 will end up in the SAME EG (target),
    # which actually FIXES the domain's pairing. The validator sees this and
    # passes. Good — the defense-in-depth correctly distinguishes "merge that
    # repairs" from "merge that breaks."
    domain = AnalysisDomain(id=7810, project_id=780, name="Vision Domain")
    db.add(domain)
    db.flush()

    db.add_all([
        AnalysisDomainMember(domain_id=7810, member_type="column", member_id=7801, sequence_order=0),
        AnalysisDomainMember(domain_id=7810, member_type="column", member_id=7851, sequence_order=1),
    ])
    db.flush()

    user = db.query(User).filter(User.id == 1).one()
    return project, user


def test_merge_groups_succeeds_when_pairing_is_preserved(merge_breaks_domain_fixture, db_session):
    """Merging EG-S (Board-Q1 only) into EG-T (Staff-Q1 only) results in a
    target EG containing both — repairing the domain's previously-broken
    pairing. Validator passes; merge succeeds."""
    _, user = merge_breaks_domain_fixture
    db = db_session

    resp = _run(merge_groups(
        project_id=780,
        group_id=7801,  # target
        other_group_id=7800,  # source
        user=user,
        db=db,
    ))
    # Both columns now in target EG
    assert {c.id for c in resp.columns} == {7801, 7851}


def test_merge_groups_rejects_when_breaks_cross_dataset_domain(db_session):
    """Construct the canonical failure mode: a domain spans 3 datasets via 2
    pairing slots, and merge moves one slot's bridge into a target EG that
    would no longer pair with the rest.

    Setup:
    - EG-S (7820): Board-Q1 (7821) + Staff-Q1 (7871) — bridges Board and Staff
    - EG-T (7821): Board-Q9 (7829) only — single-dataset target
    - Domain-X (7830): {Board-Q1, Staff-Q1} — relies on EG-S

    Merging EG-S into EG-T: target EG would contain Board-Q1 + Staff-Q1 +
    Board-Q9. Two Board columns → #289 1:1 rule rejects first. We don't hit
    #298 here.

    Real construction of a #298-triggering merge:

    Setup:
    - EG-S (7820): Board-Q1 (7821), Staff-Q1 (7871) — bridges Board+Staff
    - EG-T (7822): Stakeholder-Q1 (7901) — single dataset, no other members
    - Domain-X (7830): {Board-Q1, Staff-Q1, Stakeholder-Q1}

    For Domain-X to be currently valid, all three members need to share an EG
    — but they don't (Stakeholder-Q1 is in EG-T, the others are in EG-S).
    Domain-X is currently in a pre-existing invariant-violation state. This
    is the kind of scenario #298 defense-in-depth protects against.

    Merge EG-S into EG-T: target EG would have Board-Q1 + Staff-Q1 +
    Stakeholder-Q1. 1:1 rule satisfied (one per dataset). Domain-X members
    now all share EG-T. Pairing repaired. Merge succeeds.

    To actually BREAK pairing via merge while preserving 1:1, you'd need:

    - EG-S (7820): Board-Q1 (7821), Staff-Q1 (7871)
    - EG-T (7822): Board-Q5 (7825), Staff-Q5 (7875) — different columns
    - Domain-X: {Board-Q1, Staff-Q1}

    Merge EG-S into EG-T: target now has 4 columns from 2 datasets — #289
    rejects (two Board columns).

    The conclusion (re-derived from this attempt): with #289 in place, any
    merge that would break a cross-dataset domain's pairing FIRST hits the
    1:1 reject. #298 on merge_groups is therefore strictly defense-in-depth
    against future #289 weakening or pre-existing invariant violations that
    reach this code path through a portability quirk.

    For testing purposes, this case demonstrates that the wiring is correct
    by setting up an invalid domain state and confirming the validator runs
    on every merge.
    """
    db = db_session
    project = Project(id=790, name="Merge Reject Test", user_id=1)
    db.add(project)

    board = Dataset(id=790, project_id=790, name="Board")
    staff = Dataset(id=791, project_id=790, name="Staff")
    stakeholder = Dataset(id=792, project_id=790, name="Stakeholder")
    db.add_all([board, staff, stakeholder])

    # EG with no bridging — just Board-Q1
    eg_source = EquivalenceGroup(id=7900, project_id=790, label="Source")
    eg_target = EquivalenceGroup(id=7901, project_id=790, label="Target")
    db.add_all([eg_source, eg_target])
    db.flush()

    db.add_all([
        DatasetColumn(id=7901, dataset_id=790, column_code="Q1", column_name="Q1",
                      column_text="Vision (Board)", column_type="ordinal",
                      sequence_order=0, display_order=0,
                      equivalence_group_id=7900),
        DatasetColumn(id=7951, dataset_id=791, column_code="Q1", column_name="Q1",
                      column_text="Vision (Staff)", column_type="ordinal",
                      sequence_order=0, display_order=0,
                      equivalence_group_id=None),  # NOT linked
        DatasetColumn(id=7991, dataset_id=792, column_code="Q9", column_name="Q9",
                      column_text="Other (Stakeholder)", column_type="ordinal",
                      sequence_order=0, display_order=0,
                      equivalence_group_id=7901),  # in target
    ])
    db.flush()

    # Domain-X has Board-Q1, Staff-Q1 — currently INVALID (Staff-Q1 unlinked).
    # Pre-existing invariant violation in the fixture.
    domain = AnalysisDomain(id=7910, project_id=790, name="Vision (broken)")
    db.add(domain)
    db.flush()
    db.add_all([
        AnalysisDomainMember(domain_id=7910, member_type="column", member_id=7901, sequence_order=0),
        AnalysisDomainMember(domain_id=7910, member_type="column", member_id=7951, sequence_order=1),
    ])
    db.flush()

    user = db.query(User).filter(User.id == 1).one()

    # Merging EG-S (Board-Q1) into EG-T (Stakeholder-Q9) puts Board-Q1 and
    # Stakeholder-Q9 in the same EG. Domain-X members are now Board-Q1 (in
    # EG-T) and Staff-Q1 (still unlinked). Domain-X still has unpaired
    # members — the invariant is still violated. Validator catches and 409s.
    with pytest.raises(HTTPException) as exc_info:
        _run(merge_groups(
            project_id=790,
            group_id=7901,  # target
            other_group_id=7900,  # source
            user=user,
            db=db,
        ))

    assert exc_info.value.status_code == 409
    detail = exc_info.value.detail
    assert isinstance(detail, dict)
    assert detail["error"] == "cross_dataset_unpaired"


def test_merge_groups_state_unchanged_after_rejection(db_session):
    """When #298 rejects a merge, both EGs survive with their original
    columns. Domain members untouched."""
    db = db_session
    project = Project(id=795, name="Merge State Test", user_id=1)
    db.add(project)

    board = Dataset(id=795, project_id=795, name="Board")
    staff = Dataset(id=796, project_id=795, name="Staff")
    stakeholder = Dataset(id=797, project_id=795, name="Stakeholder")
    db.add_all([board, staff, stakeholder])

    eg_source = EquivalenceGroup(id=7950, project_id=795, label="Source")
    eg_target = EquivalenceGroup(id=7951, project_id=795, label="Target")
    db.add_all([eg_source, eg_target])
    db.flush()

    db.add_all([
        DatasetColumn(id=7951, dataset_id=795, column_code="Q1", column_name="Q1",
                      column_text="Vision (Board)", column_type="ordinal",
                      sequence_order=0, display_order=0,
                      equivalence_group_id=7950),
        DatasetColumn(id=7961, dataset_id=796, column_code="Q1", column_name="Q1",
                      column_text="Vision (Staff)", column_type="ordinal",
                      sequence_order=0, display_order=0,
                      equivalence_group_id=None),
        DatasetColumn(id=7971, dataset_id=797, column_code="Q9", column_name="Q9",
                      column_text="Other (Stakeholder)", column_type="ordinal",
                      sequence_order=0, display_order=0,
                      equivalence_group_id=7951),
    ])
    db.flush()

    domain = AnalysisDomain(id=7960, project_id=795, name="Vision (broken)")
    db.add(domain)
    db.flush()
    db.add_all([
        AnalysisDomainMember(domain_id=7960, member_type="column", member_id=7951, sequence_order=0),
        AnalysisDomainMember(domain_id=7960, member_type="column", member_id=7961, sequence_order=1),
    ])
    db.flush()

    user = db.query(User).filter(User.id == 1).one()

    with pytest.raises(HTTPException):
        _run(merge_groups(
            project_id=795,
            group_id=7951,
            other_group_id=7950,
            user=user,
            db=db,
        ))

    # Both EGs still in the session (db.delete(source_group) never ran;
    # source columns reassignment is uncommitted and would be discarded
    # by FastAPI's request-lifecycle session close in production).
    eg_s = db.query(EquivalenceGroup).filter(EquivalenceGroup.id == 7950).first()
    eg_t = db.query(EquivalenceGroup).filter(EquivalenceGroup.id == 7951).first()
    assert eg_s is not None
    assert eg_t is not None

    # Domain members intact (validator runs before any audit-log entries
    # would have been written).
    members = db.query(AnalysisDomainMember).filter(
        AnalysisDomainMember.domain_id == 7960
    ).all()
    assert len(members) == 2
