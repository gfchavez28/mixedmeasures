"""Tests for #298 cascade subset (Dataset/DatasetColumn delete I2 validation)
and #294 runtime 1:1 assertion (defense-in-depth).

#298 cascade subset closes the gap left by the EG-path subset (which shipped
in an earlier commit pre-Phase-4): when a Dataset or DatasetColumn delete cascades
to AnalysisDomainMember rows, a cross-dataset domain whose pairing depended on
the deleted columns becomes silently unpaired. Pre-fix, this state was caught
only at next-compute time by the runtime late-catch in `metrics.py`. Post-fix,
the cascade pre-validates via `assert_domains_intact_for_domain_ids` and raises
409 cross_dataset_unpaired (with `domain_id`/`domain_name` enrichment) so the
researcher gets a friendly error at delete time.

#294 adds the runtime 1:1-per-dataset assertion `_assert_eg_one_column_per_dataset`
in `metrics.py::resolve_dataset_domain`, parallel to the existing #290
`_assert_domain_members_paired`. Defense-in-depth for the partial unique index
`ix_equivalence_unique_column_per_dataset` — fires if a future refactor or raw
SQL bypasses the schema-level constraint.

Test fixture layout:
- Project 880, user 1
- Dataset 880 Board, Dataset 881 Staff, Dataset 882 Self
- EG 8800 bridges Board+Staff (Q1 columns) — supports cross-dataset domain
- EG 8801 bridges Board+Self (Q2 columns) — second cross-dataset bridge
- AnalysisDomain 8810 contains 4 members:
    Board Q1 (8801), Staff Q1 (8851), Board Q2 (8802), Self Q2 (8821)
  Pairings: Q1 via EG 8800 (Board↔Staff), Q2 via EG 8801 (Board↔Self).
"""
import asyncio

import pytest
from fastapi import HTTPException
from sqlalchemy import text

from app.models.project import Project
from app.models.user import User
from app.models.dataset import Dataset, DatasetColumn
from app.models.equivalence_group import EquivalenceGroup
from app.models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from app.routers.dataset import (
    delete_dataset,
    delete_manual_column,
    _cascade_delete_column_refs,
)
from app.services.metrics import _assert_eg_one_column_per_dataset


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture
def project_with_three_datasets_and_cross_domain(db_session):
    """Three-dataset cross-dataset domain fixture (see module docstring)."""
    db = db_session
    project = Project(id=880, name="Cascade Integrity Test", user_id=1)
    db.add(project)

    board = Dataset(id=880, project_id=880, name="Board")
    staff = Dataset(id=881, project_id=880, name="Staff")
    self_ds = Dataset(id=882, project_id=880, name="Self")
    db.add_all([board, staff, self_ds])

    eg_q1 = EquivalenceGroup(id=8800, project_id=880, label="Q1 Board↔Staff")
    eg_q2 = EquivalenceGroup(id=8801, project_id=880, label="Q2 Board↔Self")
    db.add_all([eg_q1, eg_q2])
    db.flush()

    db.add_all([
        DatasetColumn(id=8801, dataset_id=880, column_code="BQ1", column_name="BQ1",
                      column_text="Board Q1", column_type="ordinal",
                      sequence_order=0, display_order=0,
                      equivalence_group_id=8800),
        DatasetColumn(id=8851, dataset_id=881, column_code="SQ1", column_name="SQ1",
                      column_text="Staff Q1", column_type="ordinal",
                      sequence_order=0, display_order=0,
                      equivalence_group_id=8800),
        DatasetColumn(id=8802, dataset_id=880, column_code="BQ2", column_name="BQ2",
                      column_text="Board Q2", column_type="ordinal",
                      sequence_order=1, display_order=1,
                      equivalence_group_id=8801),
        DatasetColumn(id=8821, dataset_id=882, column_code="ZQ2", column_name="ZQ2",
                      column_text="Self Q2", column_type="ordinal",
                      sequence_order=0, display_order=0,
                      equivalence_group_id=8801),
    ])
    db.flush()

    domain = AnalysisDomain(id=8810, project_id=880, name="Cross-Survey Domain")
    db.add(domain)
    db.flush()

    db.add_all([
        AnalysisDomainMember(domain_id=8810, member_type="column", member_id=8801, sequence_order=0),
        AnalysisDomainMember(domain_id=8810, member_type="column", member_id=8851, sequence_order=1),
        AnalysisDomainMember(domain_id=8810, member_type="column", member_id=8802, sequence_order=2),
        AnalysisDomainMember(domain_id=8810, member_type="column", member_id=8821, sequence_order=3),
    ])
    db.flush()

    user = db.query(User).filter(User.id == 1).one()
    return project, user


# ── #298 cascade subset: Dataset delete ──────────────────────────────────────


def test_delete_dataset_blocked_when_leaves_cross_dataset_domain_unpaired(
    project_with_three_datasets_and_cross_domain, db_session,
):
    """Deleting Self would remove member 8821 from the domain. Members 8801
    + 8851 stay paired via EG 8800. Member 8802 (Board Q2) was paired with
    8821 via EG 8801; with 8821 gone, EG 8801 has only 8802. The remaining
    domain spans Board+Staff (datasets 880, 881), and 8802 (Board) has no
    Staff partner via EG 8801 → 8802 is unpaired → 409.
    """
    _, user = project_with_three_datasets_and_cross_domain
    db = db_session

    with pytest.raises(HTTPException) as exc_info:
        _run(delete_dataset(
            project_id=880,
            dataset_id=882,  # Self
            user=user,
            db=db,
        ))
    assert exc_info.value.status_code == 409
    detail = exc_info.value.detail
    assert isinstance(detail, dict)
    assert detail["error"] == "cross_dataset_unpaired"
    # Improvement: domain context surfaces in the 409 detail
    assert detail["domain_id"] == 8810
    assert detail["domain_name"] == "Cross-Survey Domain"
    assert "Cross-Survey Domain" in detail["message"]


def test_delete_dataset_succeeds_when_domain_becomes_single_dataset(
    project_with_three_datasets_and_cross_domain, db_session,
):
    """If we remove the Q2 pairing first (so the domain only has Board↔Staff
    Q1), then delete Staff, the domain becomes single-dataset Board-only —
    which is valid per #290. Validator must NOT fire a false positive.

    Setup: drop members 8802 + 8821 from the domain, then delete Staff.
    Expected: succeeds. Domain is left with only 8801 (Board), single-dataset.
    """
    _, user = project_with_three_datasets_and_cross_domain
    db = db_session

    db.query(AnalysisDomainMember).filter(
        AnalysisDomainMember.domain_id == 8810,
        AnalysisDomainMember.member_id.in_([8802, 8821]),
    ).delete(synchronize_session="fetch")
    db.flush()

    result = _run(delete_dataset(
        project_id=880,
        dataset_id=881,  # Staff
        user=user,
        db=db,
    ))
    assert result["ok"] is True

    staff = db.query(Dataset).filter(Dataset.id == 881).first()
    assert staff is None


def test_delete_dataset_succeeds_when_no_cross_dataset_domain_affected(
    project_with_three_datasets_and_cross_domain, db_session,
):
    """Delete a fourth dataset that isn't part of any domain — no validator
    activity, no false positive."""
    _, user = project_with_three_datasets_and_cross_domain
    db = db_session

    extra = Dataset(id=883, project_id=880, name="Extra")
    db.add(extra)
    db.add(DatasetColumn(
        id=8830, dataset_id=883, column_code="EQ1", column_name="EQ1",
        column_text="Extra Q1", column_type="ordinal",
        sequence_order=0, display_order=0,
    ))
    db.flush()

    result = _run(delete_dataset(
        project_id=880,
        dataset_id=883,
        user=user,
        db=db,
    ))
    assert result["ok"] is True

    # The cross-dataset domain is untouched.
    members = db.query(AnalysisDomainMember).filter(
        AnalysisDomainMember.domain_id == 8810
    ).all()
    assert len(members) == 4


# ── #298 cascade subset: DatasetColumn delete ────────────────────────────────


def test_delete_manual_column_blocked_when_leaves_domain_unpaired(
    project_with_three_datasets_and_cross_domain, db_session,
):
    """Make Self Q2 (8821) a manual column, then delete it. With only 8821 gone,
    EG 8801 has just Board Q2 left, leaving Board Q2 unpaired in the cross-dataset
    domain (Board+Staff+Self → Board+Staff after delete; Board Q2 has no
    Staff partner). Validator should reject.

    Per `delete_manual_column`'s source-check guard, only `source='manual'`
    columns can be deleted, so we set 8821 to manual first.
    """
    _, user = project_with_three_datasets_and_cross_domain
    db = db_session

    db.query(DatasetColumn).filter(DatasetColumn.id == 8821).update(
        {"source": "manual"}, synchronize_session="fetch",
    )
    db.flush()

    with pytest.raises(HTTPException) as exc_info:
        _run(delete_manual_column(
            project_id=880,
            dataset_id=882,
            column_id=8821,
            user=user,
            db=db,
        ))
    assert exc_info.value.status_code == 409
    detail = exc_info.value.detail
    assert detail["error"] == "cross_dataset_unpaired"
    assert detail["domain_name"] == "Cross-Survey Domain"


def test_delete_manual_column_succeeds_when_no_domain_impact(
    project_with_three_datasets_and_cross_domain, db_session,
):
    """A manual column not part of any domain deletes cleanly."""
    _, user = project_with_three_datasets_and_cross_domain
    db = db_session

    db.add(DatasetColumn(
        id=8899, dataset_id=880, column_code="MQ1", column_name="MQ1",
        column_text="Manual Q1", column_type="numeric",
        sequence_order=99, display_order=99,
        source="manual",
    ))
    db.flush()

    _run(delete_manual_column(
        project_id=880,
        dataset_id=880,
        column_id=8899,
        user=user,
        db=db,
    ))
    col = db.query(DatasetColumn).filter(DatasetColumn.id == 8899).first()
    assert col is None


def test_cascade_delete_column_refs_validates_via_helper(
    project_with_three_datasets_and_cross_domain, db_session,
):
    """`_cascade_delete_column_refs` is the shared cleanup used by computed
    column delete. Passing in column 8821 (the Self Q2 cross-dataset bridge)
    must surface the 409 the same way as delete_manual_column."""
    _, _user = project_with_three_datasets_and_cross_domain
    db = db_session

    with pytest.raises(HTTPException) as exc_info:
        _cascade_delete_column_refs(db, project_id=880, column_id=8821)
    assert exc_info.value.status_code == 409
    assert exc_info.value.detail["domain_name"] == "Cross-Survey Domain"


# ── #294 runtime 1:1-per-dataset assertion ───────────────────────────────────


def test_runtime_assertion_passes_for_valid_state(
    project_with_three_datasets_and_cross_domain, db_session,
):
    """Negative control: well-formed EG state must not trip the runtime
    1:1-per-dataset assertion."""
    db = db_session
    member_col_ids = [8801, 8851, 8802, 8821]
    # Should not raise
    _assert_eg_one_column_per_dataset(db, domain_id=8810, member_col_ids=member_col_ids)


def test_runtime_assertion_fires_when_partial_unique_index_bypassed(
    project_with_three_datasets_and_cross_domain, db_session,
):
    """If a future refactor drops the partial unique index, two columns from
    the same dataset could end up in the same EG. The runtime assertion in
    `_assert_eg_one_column_per_dataset` is the safety net. Simulate the bypass
    by dropping the index, then writing the violation directly.

    The test proves: if the schema constraint is gone, the runtime check
    fires before any metric compute proceeds with a corrupt state.
    """
    db = db_session

    # Drop the partial unique index so we can construct the invalid state.
    db.execute(text("DROP INDEX IF EXISTS ix_equivalence_unique_column_per_dataset"))
    db.flush()

    # Add a second Board column and assign it to EG 8800 (already contains
    # Board column 8801). This violates the 1:1-per-dataset rule.
    db.add(DatasetColumn(
        id=8803, dataset_id=880, column_code="BQ1B", column_name="BQ1B",
        column_text="Board Q1 dupe", column_type="ordinal",
        sequence_order=2, display_order=2,
        equivalence_group_id=8800,
    ))
    db.flush()

    member_col_ids = [8801, 8851, 8803]
    with pytest.raises(ValueError) as exc_info:
        _assert_eg_one_column_per_dataset(db, domain_id=8810, member_col_ids=member_col_ids)

    msg = str(exc_info.value)
    assert "#289" in msg
    assert "8800" in msg  # the offending EG
    assert "880" in msg  # the offending dataset


def test_runtime_assertion_skips_columns_without_eg(
    project_with_three_datasets_and_cross_domain, db_session,
):
    """Columns with `equivalence_group_id == None` are not subject to the
    1:1 rule (they're not in any EG)."""
    db = db_session

    db.add(DatasetColumn(
        id=8804, dataset_id=880, column_code="BQ_unlinked", column_name="BQ_unlinked",
        column_text="Board unlinked", column_type="ordinal",
        sequence_order=3, display_order=3,
    ))
    db.flush()

    # Mixing a Board column already in EG 8800 (8801) with an unlinked
    # Board column (8804) should NOT trip the assertion — only one is in
    # an EG. This is the canonical valid mixed state for cross-dataset
    # domains with single-dataset extras (#290 forbids that mixed shape
    # for cross-dataset domains, but the 1:1 assertion is independent
    # and only cares about EG membership counts per dataset).
    _assert_eg_one_column_per_dataset(
        db, domain_id=8810, member_col_ids=[8801, 8851, 8804]
    )
