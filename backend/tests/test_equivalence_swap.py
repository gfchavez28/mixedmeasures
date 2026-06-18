"""Tests for the Tier 3 crosswalk swap endpoint.

Covers POST /api/projects/{pid}/equivalence-groups/swap (Phase 1b Task 1.2,
GAP 3.2). The swap endpoint atomically exchanges equivalence_group_id between
pairs of columns within the same dataset. Consumed by the crosswalk's
drag-to-swap gesture.

Validation order (all-or-nothing):
1. Both columns exist in the project (400 "Columns not found" via
   _validate_columns_belong_to_project)
2. Both columns currently belong to some group (400 not_linked)
3. assert_columns_same_type → 409 type_mismatch
4. assert_columns_same_dataset → 400 cross_dataset
5. Post-swap 1:1-per-dataset invariant (defense in depth for batched case)

Staleness handling: GAP 3.13 Option A — synchronously recompute all affected
domain_aggregate metrics via the three-level join
`swapped_columns → AnalysisDomainMember → AnalysisDomain → MetricDefinition`.
The response includes `recomputed_metric_ids` listing successful recomputes.
"""
import asyncio

import pytest
from fastapi import HTTPException

from app.models.project import Project
from app.models.user import User
from app.models.dataset import Dataset, DatasetColumn, ColumnType
from app.models.equivalence_group import EquivalenceGroup
from app.models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from app.models.metric import MetricDefinition
from app.routers.equivalence import swap_columns
from app.schemas.equivalence import (
    EquivalenceGroupSwapRequest,
    ColumnSwap,
)

from tests.conftest import mock_request


def _run(coro):
    """Invoke async router function synchronously — matches test_equivalence_1to1.py pattern."""
    return asyncio.run(coro)


def _swap_req(*pairs: tuple[int, int]) -> EquivalenceGroupSwapRequest:
    return EquivalenceGroupSwapRequest(
        swaps=[ColumnSwap(column_id_a=a, column_id_b=b) for a, b in pairs]
    )


# ═════════════════════════════════════════════════════════════════════════════
# Fixtures
# ═════════════════════════════════════════════════════════════════════════════


@pytest.fixture
def swap_scenario(db_session):
    """Minimal 2-dataset project with equivalence rows, ready for swap tests.

    Layout:
    - Project 500, user 1
    - Dataset 500 (Board): cols 5001 Q1 ordinal, 5002 Q2 ordinal, 5003 Q3 nominal
    - Dataset 501 (Staff): cols 5101 Q1 ordinal, 5102 Q2 ordinal, 5103 Q3 nominal
    - EquivalenceGroup 5500 contains 5001 (Board Q1) + 5101 (Staff Q1) — ordinal pair
    - EquivalenceGroup 5501 contains 5002 (Board Q2) + 5102 (Staff Q2) — ordinal pair
    - EquivalenceGroup 5502 contains 5003 (Board Q3) + 5103 (Staff Q3) — nominal pair
    - col 5004 (Board Q4 ordinal) is UNLINKED — no equivalence_group_id

    This setup lets us test swaps within an ordinal-type set (5001↔5002 is a
    legal swap, Board side) AND the type-mismatch path (5001 ordinal ↔ 5003
    nominal — same dataset, different types).
    """
    db = db_session
    project = Project(id=500, name="Swap Test", user_id=1)
    db.add(project)

    board = Dataset(id=500, project_id=500, name="Board")
    staff = Dataset(id=501, project_id=500, name="Staff")
    db.add_all([board, staff])

    eg1 = EquivalenceGroup(id=5500, project_id=500, label="Q1 pair")
    eg2 = EquivalenceGroup(id=5501, project_id=500, label="Q2 pair")
    eg3 = EquivalenceGroup(id=5502, project_id=500, label="Q3 pair")
    db.add_all([eg1, eg2, eg3])
    db.flush()

    db.add_all([
        DatasetColumn(
            id=5001, dataset_id=500, column_code="B1", column_name="B1",
            column_text="Board Q1", column_type=ColumnType.ORDINAL,
            sequence_order=0, display_order=0, equivalence_group_id=5500,
        ),
        DatasetColumn(
            id=5002, dataset_id=500, column_code="B2", column_name="B2",
            column_text="Board Q2", column_type=ColumnType.ORDINAL,
            sequence_order=1, display_order=1, equivalence_group_id=5501,
        ),
        DatasetColumn(
            id=5003, dataset_id=500, column_code="B3", column_name="B3",
            column_text="Board Q3", column_type=ColumnType.NOMINAL,
            sequence_order=2, display_order=2, equivalence_group_id=5502,
        ),
        DatasetColumn(
            id=5004, dataset_id=500, column_code="B4", column_name="B4",
            column_text="Board Q4 unlinked", column_type=ColumnType.ORDINAL,
            sequence_order=3, display_order=3,
        ),
        DatasetColumn(
            id=5101, dataset_id=501, column_code="S1", column_name="S1",
            column_text="Staff Q1", column_type=ColumnType.ORDINAL,
            sequence_order=0, display_order=0, equivalence_group_id=5500,
        ),
        DatasetColumn(
            id=5102, dataset_id=501, column_code="S2", column_name="S2",
            column_text="Staff Q2", column_type=ColumnType.ORDINAL,
            sequence_order=1, display_order=1, equivalence_group_id=5501,
        ),
        DatasetColumn(
            id=5103, dataset_id=501, column_code="S3", column_name="S3",
            column_text="Staff Q3", column_type=ColumnType.NOMINAL,
            sequence_order=2, display_order=2, equivalence_group_id=5502,
        ),
    ])
    db.flush()

    user = db.query(User).filter(User.id == 1).one()
    return project, user


# ═════════════════════════════════════════════════════════════════════════════
# Happy path
# ═════════════════════════════════════════════════════════════════════════════


def test_swap_happy_path(swap_scenario, db_session):
    """Swap Board Q1 (group 5500) ↔ Board Q2 (group 5501). After swap, Q1 is
    in group 5501 and Q2 is in group 5500. Same dataset, same type (ordinal).
    """
    _, user = swap_scenario

    result = _run(swap_columns(
        request=mock_request(),
        project_id=500,
        data=_swap_req((5001, 5002)),
        user=user,
        db=db_session,
    ))

    # Both groups returned
    assert len(result.updated_groups) == 2
    group_ids = {g.id for g in result.updated_groups}
    assert group_ids == {5500, 5501}

    # Verify swap applied
    col_5001 = db_session.query(DatasetColumn).filter(DatasetColumn.id == 5001).one()
    col_5002 = db_session.query(DatasetColumn).filter(DatasetColumn.id == 5002).one()
    assert col_5001.equivalence_group_id == 5501
    assert col_5002.equivalence_group_id == 5500


def test_swap_multiple_pairs_atomic(swap_scenario, db_session):
    """Multiple swaps in one request all succeed together. Exercise the
    multi-pair path. Here: Board Q1 ↔ Board Q2 AND Staff Q1 ↔ Staff Q2.
    """
    _, user = swap_scenario

    result = _run(swap_columns(
        request=mock_request(),
        project_id=500,
        data=_swap_req((5001, 5002), (5101, 5102)),
        user=user,
        db=db_session,
    ))

    # All four columns swapped
    col_5001 = db_session.query(DatasetColumn).filter(DatasetColumn.id == 5001).one()
    col_5002 = db_session.query(DatasetColumn).filter(DatasetColumn.id == 5002).one()
    col_5101 = db_session.query(DatasetColumn).filter(DatasetColumn.id == 5101).one()
    col_5102 = db_session.query(DatasetColumn).filter(DatasetColumn.id == 5102).one()
    assert col_5001.equivalence_group_id == 5501
    assert col_5002.equivalence_group_id == 5500
    assert col_5101.equivalence_group_id == 5501
    assert col_5102.equivalence_group_id == 5500

    # Groups 5500 and 5501 still each contain exactly one column per dataset
    # (the 1:1 invariant holds post-swap)
    assert len(result.updated_groups) == 2


# ═════════════════════════════════════════════════════════════════════════════
# Validation failure paths
# ═════════════════════════════════════════════════════════════════════════════


def test_swap_rejects_unlinked_column(swap_scenario, db_session):
    """Column 5004 is unlinked (equivalence_group_id is None). Swap attempt → 400 not_linked."""
    _, user = swap_scenario

    with pytest.raises(HTTPException) as exc_info:
        _run(swap_columns(
            request=mock_request(),
            project_id=500,
            data=_swap_req((5001, 5004)),  # 5004 is unlinked
            user=user,
            db=db_session,
        ))

    assert exc_info.value.status_code == 400
    detail = exc_info.value.detail
    assert isinstance(detail, dict)
    assert detail["error"] == "not_linked"
    assert 5004 in detail["column_ids"]


def test_swap_rejects_cross_project_columns(swap_scenario, db_session):
    """Columns not in this project → 400 (via _validate_columns_belong_to_project,
    which raises 400 "Columns not found in project", NOT 404 — per Revision 3
    clarification and equivalence.py:139).
    """
    _, user = swap_scenario

    # Create a second project with a column in its own equivalence group
    other_project = Project(id=501, name="Other", user_id=1)
    db_session.add(other_project)
    other_ds = Dataset(id=510, project_id=501, name="Other DS")
    db_session.add(other_ds)
    db_session.flush()
    other_eg = EquivalenceGroup(id=5600, project_id=501, label="Other")
    db_session.add(other_eg)
    db_session.flush()
    db_session.add(DatasetColumn(
        id=5201, dataset_id=510, column_code="X1", column_name="X1",
        column_text="Other Q1", column_type=ColumnType.ORDINAL,
        sequence_order=0, display_order=0, equivalence_group_id=5600,
    ))
    db_session.flush()

    # Attempt swap using project 500 but with a column from project 501
    with pytest.raises(HTTPException) as exc_info:
        _run(swap_columns(
            request=mock_request(),
            project_id=500,
            data=_swap_req((5001, 5201)),
            user=user,
            db=db_session,
        ))

    # _validate_columns_belong_to_project raises 400 per equivalence.py:139
    assert exc_info.value.status_code == 400
    assert "Columns not found in project" in str(exc_info.value.detail)


def test_swap_rejects_type_mismatch(swap_scenario, db_session):
    """Board Q1 is ordinal, Board Q3 is nominal — same dataset but different
    types. Swap → 409 type_mismatch.

    NOTE: both columns are same-dataset on purpose. Using cross-dataset
    columns here would hit the cross_dataset 400 validator first, which is
    the wrong precondition for this test. See directive Phase 1.10
    Session A finding 1 note for the full rationale.
    """
    _, user = swap_scenario

    with pytest.raises(HTTPException) as exc_info:
        _run(swap_columns(
            request=mock_request(),
            project_id=500,
            data=_swap_req((5001, 5003)),  # both Board, ordinal vs nominal
            user=user,
            db=db_session,
        ))

    assert exc_info.value.status_code == 409
    detail = exc_info.value.detail
    assert isinstance(detail, dict)
    assert detail["error"] == "type_mismatch"
    assert set(detail["column_ids"]) == {5001, 5003}


def test_swap_rejects_cross_dataset(swap_scenario, db_session):
    """Board Q1 (dataset 500) and Staff Q1 (dataset 501) — cross-dataset swap.
    Even though they're the same type and both linked, cross-dataset swaps
    are nonsensical (swap moves a cell between rows within a dataset column).
    → 400 cross_dataset.
    """
    _, user = swap_scenario

    with pytest.raises(HTTPException) as exc_info:
        _run(swap_columns(
            request=mock_request(),
            project_id=500,
            data=_swap_req((5001, 5101)),  # Board + Staff — different datasets
            user=user,
            db=db_session,
        ))

    assert exc_info.value.status_code == 400
    detail = exc_info.value.detail
    assert isinstance(detail, dict)
    assert detail["error"] == "cross_dataset"
    assert set(detail["column_ids"]) == {5001, 5101}


# ═════════════════════════════════════════════════════════════════════════════
# GAP 3.13 Option A — synchronous recompute
# ═════════════════════════════════════════════════════════════════════════════


def test_swap_triggers_sync_recompute_single_metric(swap_scenario, db_session):
    """Domain containing a swapped column has its scale-score metric recomputed
    synchronously. After swap, the metric's stale flag is clear and the
    response's recomputed_metric_ids includes the metric.

    **Setup requires the domain to contain BOTH swapped columns + their
    equivalents** so the swap doesn't orphan any cross-dataset members (which
    would trigger the #290 post-swap validator). Realistic pattern: a
    "Leadership" domain contains {Board Q1, Board Q2, Staff Q1, Staff Q2}
    and the researcher is re-pairing which Board column goes with which
    Staff column — the domain's membership is unchanged, only the
    equivalence-group bridging reshuffles.
    """
    _, user = swap_scenario

    # Build a domain that spans all 4 ordinal Q1+Q2 columns
    domain = AnalysisDomain(id=5700, project_id=500, name="Leadership", sequence_order=0)
    db_session.add(domain)
    db_session.flush()
    db_session.add_all([
        AnalysisDomainMember(id=5701, domain_id=5700, member_type="column", member_id=5001, sequence_order=0),
        AnalysisDomainMember(id=5702, domain_id=5700, member_type="column", member_id=5002, sequence_order=1),
        AnalysisDomainMember(id=5703, domain_id=5700, member_type="column", member_id=5101, sequence_order=2),
        AnalysisDomainMember(id=5704, domain_id=5700, member_type="column", member_id=5102, sequence_order=3),
    ])
    db_session.flush()

    # Create the scale-score metric via the service function so it has
    # the correct field values, then mark it fresh (not stale).
    from app.services.metrics import create_scale_score_metric
    metric, _ = create_scale_score_metric(db_session, domain)
    db_session.flush()
    metric.stale = False
    db_session.flush()
    metric_id = metric.id

    # Swap Board Q1 ↔ Board Q2 — col 5001 is in the domain, so the metric
    # should be marked stale AND recomputed. Post-swap, all 4 columns are
    # still in the domain, and the eg bridging is still valid (Board Q1 now
    # bridges to Staff Q2, Board Q2 bridges to Staff Q1). #290 holds.
    result = _run(swap_columns(
        request=mock_request(),
        project_id=500,
        data=_swap_req((5001, 5002)),
        user=user,
        db=db_session,
    ))

    # Metric recomputed synchronously
    assert metric_id in result.recomputed_metric_ids

    # Stale flag cleared
    db_session.refresh(metric)
    assert metric.stale is False


def test_swap_fan_out_multiple_affected_metrics(swap_scenario, db_session):
    """GAP 3.13 three-level join fan-out: a swap can affect multiple metrics
    because a column can belong to multiple domains. This test exercises both.

    Setup (avoiding #290 orphan errors):
    - Domain A contains all 4 Q1+Q2 columns (cross-dataset, fully-paired —
      swap reshuffles bridging, doesn't orphan)
    - Domain B is single-dataset Board-only, contains col 5001 + col 5002
      (single-dataset domains are #290-unconstrained)
    - Each domain has an ungrouped scale score metric
    - Swap col 5001 ↔ col 5002 — col 5001 is in BOTH domains
    - Expect: both Domain A's metric AND Domain B's metric are recomputed
    """
    _, user = swap_scenario

    # Domain A: cross-dataset, contains all 4 Q1+Q2 columns so the swap
    # doesn't orphan any cross-dataset members
    domain_a = AnalysisDomain(id=5710, project_id=500, name="Domain A", sequence_order=0)
    db_session.add(domain_a)
    db_session.flush()
    db_session.add_all([
        AnalysisDomainMember(domain_id=5710, member_type="column", member_id=5001, sequence_order=0),
        AnalysisDomainMember(domain_id=5710, member_type="column", member_id=5002, sequence_order=1),
        AnalysisDomainMember(domain_id=5710, member_type="column", member_id=5101, sequence_order=2),
        AnalysisDomainMember(domain_id=5710, member_type="column", member_id=5102, sequence_order=3),
    ])

    # Domain B: single-dataset Board only (5001 + 5002). Single-dataset
    # domains don't require cross-dataset pairing per #290.
    domain_b = AnalysisDomain(id=5711, project_id=500, name="Domain B", sequence_order=1)
    db_session.add(domain_b)
    db_session.flush()
    db_session.add_all([
        AnalysisDomainMember(domain_id=5711, member_type="column", member_id=5001, sequence_order=0),
        AnalysisDomainMember(domain_id=5711, member_type="column", member_id=5002, sequence_order=1),
    ])
    db_session.flush()

    # Create scale-score metrics for both domains
    from app.services.metrics import create_scale_score_metric
    metric_a, _ = create_scale_score_metric(db_session, domain_a)
    metric_b, _ = create_scale_score_metric(db_session, domain_b)
    db_session.flush()
    metric_a.stale = False
    metric_b.stale = False
    db_session.flush()
    metric_a_id = metric_a.id
    metric_b_id = metric_b.id

    # Swap Board Q1 ↔ Board Q2 — col 5001 is in BOTH domains, so BOTH metrics
    # should be recomputed
    result = _run(swap_columns(
        request=mock_request(),
        project_id=500,
        data=_swap_req((5001, 5002)),
        user=user,
        db=db_session,
    ))

    # Both metrics in the response
    assert metric_a_id in result.recomputed_metric_ids
    assert metric_b_id in result.recomputed_metric_ids
    assert len(result.recomputed_metric_ids) >= 2


def test_swap_atomically_swaps_domain_membership_to_preserve_pairing(swap_scenario, db_session):
    """Swap atomically updates AnalysisDomainMember rows alongside the EG
    swap (audit Priority 5 / #336, 2026-04-30 Batch B). The previous
    "swap-only-EG" semantics produced phantom cells: the cell visually
    appeared in the new bracket but its domain membership pointed at the
    old bracket, so its value contributed to the wrong scale-score metric.

    Scenario (formerly the orphan-rejection scenario, now the regression
    test for Path B):
    - Domain "Q1-only" contains ONLY col 5001 (Board Q1) + col 5101
      (Staff Q1), paired through eg 5500.
    - Swap col 5001 ↔ col 5002 (Board Q2, in eg 5501, NOT in any domain).

    Pre-Path-B behavior: rejected with 409 cross_dataset_unpaired
    because col 5101 would be left without a cross-dataset partner.

    Path B behavior: the membership swap puts col 5002 into "Q1-only" in
    place of col 5001 — symmetric difference (col 5001 was in {Q1-only},
    col 5002 was in {}). After the swap col 5002 is in eg 5500 with col
    5101, so the cross-dataset pairing is preserved AT THE DOMAIN LEVEL
    even though the user dragged across rows.

    The post-swap #290 validator stays as defense-in-depth (catches
    multi-pair-batch edge cases), but for single-pair swaps it always
    passes after the membership swap.
    """
    _, user = swap_scenario

    # Build the minimal cross-dataset domain (just the Q1 pair).
    domain = AnalysisDomain(id=5720, project_id=500, name="Q1 only", sequence_order=0)
    db_session.add(domain)
    db_session.flush()
    db_session.add_all([
        AnalysisDomainMember(domain_id=5720, member_type="column", member_id=5001, sequence_order=0),
        AnalysisDomainMember(domain_id=5720, member_type="column", member_id=5101, sequence_order=1),
    ])
    db_session.commit()

    # Swap succeeds — no exception.
    result = _run(swap_columns(
        request=mock_request(),
        project_id=500,
        data=_swap_req((5001, 5002)),
        user=user,
        db=db_session,
    ))
    assert len(result.updated_groups) == 2

    # EG swap applied
    col_5001 = db_session.query(DatasetColumn).filter(DatasetColumn.id == 5001).one()
    col_5002 = db_session.query(DatasetColumn).filter(DatasetColumn.id == 5002).one()
    assert col_5001.equivalence_group_id == 5501
    assert col_5002.equivalence_group_id == 5500

    # Membership swap applied: domain "Q1 only" now has col 5002 in place
    # of col 5001, with col 5001's original sequence_order preserved.
    member_rows = (
        db_session.query(AnalysisDomainMember)
        .filter(AnalysisDomainMember.domain_id == 5720)
        .order_by(AnalysisDomainMember.sequence_order)
        .all()
    )
    member_ids = {m.member_id for m in member_rows}
    assert member_ids == {5002, 5101}, (
        "col 5001 should have been replaced by col 5002 in domain 'Q1 only'"
    )
    # sequence_order stable: the row that was col 5001 (sequence_order=0) is now col 5002
    by_id = {m.member_id: m for m in member_rows}
    assert by_id[5002].sequence_order == 0
    assert by_id[5101].sequence_order == 1


# ═════════════════════════════════════════════════════════════════════════════
# Path B (#336) — membership-swap behavior
# ═════════════════════════════════════════════════════════════════════════════
#
# These tests cover the symmetric-difference algorithm for AnalysisDomainMember
# swap: for each pair (A, B), domains containing A-but-not-B get A→B; domains
# containing B-but-not-A get B→A; same-domain (both) and no-domain (neither)
# cases are no-ops on membership. See zazzy-hopping-wolf.md "Membership-swap
# algorithm" for the rationale and routers/equivalence.py::swap_columns
# Phase 2b for the implementation.


def test_swap_swaps_membership_when_columns_in_different_domains(swap_scenario, db_session):
    """col_a in D1, col_b in D2 (no overlap). After swap: D1 has col_b
    replacing col_a; D2 has col_a replacing col_b. sequence_orders stable."""
    _, user = swap_scenario

    # D1 contains col 5001 (in eg 5500) + col 5101 (in eg 5500) — Q1 pair
    d1 = AnalysisDomain(id=5800, project_id=500, name="D1", sequence_order=0)
    # D2 contains col 5002 (in eg 5501) + col 5102 (in eg 5501) — Q2 pair
    d2 = AnalysisDomain(id=5801, project_id=500, name="D2", sequence_order=1)
    db_session.add_all([d1, d2])
    db_session.flush()
    db_session.add_all([
        AnalysisDomainMember(domain_id=5800, member_type="column", member_id=5001, sequence_order=0),
        AnalysisDomainMember(domain_id=5800, member_type="column", member_id=5101, sequence_order=1),
        AnalysisDomainMember(domain_id=5801, member_type="column", member_id=5002, sequence_order=0),
        AnalysisDomainMember(domain_id=5801, member_type="column", member_id=5102, sequence_order=1),
    ])
    db_session.commit()

    _run(swap_columns(
        request=mock_request(),
        project_id=500,
        data=_swap_req((5001, 5002)),
        user=user,
        db=db_session,
    ))

    d1_members = {
        m.member_id: m.sequence_order
        for m in db_session.query(AnalysisDomainMember).filter(AnalysisDomainMember.domain_id == 5800).all()
    }
    d2_members = {
        m.member_id: m.sequence_order
        for m in db_session.query(AnalysisDomainMember).filter(AnalysisDomainMember.domain_id == 5801).all()
    }
    # D1: col 5001 → col 5002 (replacing at sequence_order=0); col 5101 unchanged at 1
    assert d1_members == {5002: 0, 5101: 1}
    # D2: col 5002 → col 5001 (replacing at sequence_order=0); col 5102 unchanged at 1
    assert d2_members == {5001: 0, 5102: 1}


def test_swap_no_membership_change_when_both_columns_in_same_domain(swap_scenario, db_session):
    """Same-bracket swap (both cols already members of D). After swap:
    D's member set is unchanged; sequence_orders are unchanged."""
    _, user = swap_scenario

    # D contains both 5001 (eg 5500) and 5002 (eg 5501) — typical
    # same-bracket swap of two equivalence rows in the same variable group.
    d = AnalysisDomain(id=5810, project_id=500, name="D", sequence_order=0)
    db_session.add(d)
    db_session.flush()
    db_session.add_all([
        AnalysisDomainMember(domain_id=5810, member_type="column", member_id=5001, sequence_order=0),
        AnalysisDomainMember(domain_id=5810, member_type="column", member_id=5002, sequence_order=1),
        # Pair partners in S2 also members so #290 is satisfied
        AnalysisDomainMember(domain_id=5810, member_type="column", member_id=5101, sequence_order=2),
        AnalysisDomainMember(domain_id=5810, member_type="column", member_id=5102, sequence_order=3),
    ])
    db_session.commit()

    _run(swap_columns(
        request=mock_request(),
        project_id=500,
        data=_swap_req((5001, 5002)),
        user=user,
        db=db_session,
    ))

    members = {
        m.member_id: m.sequence_order
        for m in db_session.query(AnalysisDomainMember).filter(AnalysisDomainMember.domain_id == 5810).all()
    }
    # All four members still present at the same sequence_orders.
    assert members == {5001: 0, 5002: 1, 5101: 2, 5102: 3}


def test_swap_no_membership_change_when_neither_column_in_any_domain(swap_scenario, db_session):
    """Orphan-EG swap: neither column is a member of any domain. Membership
    table is untouched. (Defensive — production gestures rarely hit this.)"""
    _, user = swap_scenario

    # No domain rows touch cols 5001/5002 in this test. Confirm baseline.
    pre_count = db_session.query(AnalysisDomainMember).count()

    _run(swap_columns(
        request=mock_request(),
        project_id=500,
        data=_swap_req((5001, 5002)),
        user=user,
        db=db_session,
    ))

    post_count = db_session.query(AnalysisDomainMember).count()
    assert post_count == pre_count


def test_swap_partial_overlap_membership_changes(swap_scenario, db_session):
    """col_a in {D, E}, col_b in {D, F}. After swap: D unchanged (both
    members); E has col_b replacing col_a; F has col_a replacing col_b."""
    _, user = swap_scenario

    # D contains both cols + their cross-dataset pair partners (so #290 holds).
    # E contains only col 5001 + col 5101 (paired via eg 5500).
    # F contains only col 5002 + col 5102 (paired via eg 5501).
    d = AnalysisDomain(id=5820, project_id=500, name="D", sequence_order=0)
    e = AnalysisDomain(id=5821, project_id=500, name="E", sequence_order=1)
    f = AnalysisDomain(id=5822, project_id=500, name="F", sequence_order=2)
    db_session.add_all([d, e, f])
    db_session.flush()
    db_session.add_all([
        # D
        AnalysisDomainMember(domain_id=5820, member_type="column", member_id=5001, sequence_order=0),
        AnalysisDomainMember(domain_id=5820, member_type="column", member_id=5002, sequence_order=1),
        AnalysisDomainMember(domain_id=5820, member_type="column", member_id=5101, sequence_order=2),
        AnalysisDomainMember(domain_id=5820, member_type="column", member_id=5102, sequence_order=3),
        # E (only col_a's side)
        AnalysisDomainMember(domain_id=5821, member_type="column", member_id=5001, sequence_order=0),
        AnalysisDomainMember(domain_id=5821, member_type="column", member_id=5101, sequence_order=1),
        # F (only col_b's side)
        AnalysisDomainMember(domain_id=5822, member_type="column", member_id=5002, sequence_order=0),
        AnalysisDomainMember(domain_id=5822, member_type="column", member_id=5102, sequence_order=1),
    ])
    db_session.commit()

    _run(swap_columns(
        request=mock_request(),
        project_id=500,
        data=_swap_req((5001, 5002)),
        user=user,
        db=db_session,
    ))

    d_members = {m.member_id: m.sequence_order for m in db_session.query(AnalysisDomainMember).filter(AnalysisDomainMember.domain_id == 5820).all()}
    e_members = {m.member_id: m.sequence_order for m in db_session.query(AnalysisDomainMember).filter(AnalysisDomainMember.domain_id == 5821).all()}
    f_members = {m.member_id: m.sequence_order for m in db_session.query(AnalysisDomainMember).filter(AnalysisDomainMember.domain_id == 5822).all()}

    # D: both cols present in BOTH pre and post → membership untouched.
    assert d_members == {5001: 0, 5002: 1, 5101: 2, 5102: 3}
    # E: col 5001 → col 5002 (sequence_order=0 preserved)
    assert e_members == {5002: 0, 5101: 1}
    # F: col 5002 → col 5001 (sequence_order=0 preserved)
    assert f_members == {5001: 0, 5102: 1}


def test_swap_audit_log_records_member_swaps(swap_scenario, db_session):
    """The audit-log details dict carries `member_swaps` describing each
    domain-membership change so the activity log preserves the cross-bracket
    semantics of the swap."""
    import json
    from app.models.audit import AuditEntry

    _, user = swap_scenario

    d = AnalysisDomain(id=5830, project_id=500, name="D", sequence_order=0)
    db_session.add(d)
    db_session.flush()
    db_session.add_all([
        AnalysisDomainMember(domain_id=5830, member_type="column", member_id=5001, sequence_order=0),
        AnalysisDomainMember(domain_id=5830, member_type="column", member_id=5101, sequence_order=1),
    ])
    db_session.commit()

    _run(swap_columns(
        request=mock_request(),
        project_id=500,
        data=_swap_req((5001, 5002)),
        user=user,
        db=db_session,
    ))

    last_log = (
        db_session.query(AuditEntry)
        .filter(AuditEntry.action == "swapped")
        .order_by(AuditEntry.id.desc())
        .first()
    )
    assert last_log is not None
    details = json.loads(last_log.details) if last_log.details else {}
    member_swaps = details.get("member_swaps") or []
    # Exactly one swap row: D(5830) lost col 5001, gained col 5002.
    assert any(
        s["domain_id"] == 5830 and s["removed_col"] == 5001 and s["added_col"] == 5002
        for s in member_swaps
    ), f"expected member_swap row for domain 5830 in {member_swaps}"
