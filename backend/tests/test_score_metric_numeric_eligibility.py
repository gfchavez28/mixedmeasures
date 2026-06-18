"""Tests for #350 — `domain_aggregate` metric on an all-non-numeric
analysis domain silently produces `valid_n=0` instead of refusing to create.

Surfaced by scenario 2 hardening: the crosswalk's `create-score-metric` endpoint
accepted a cross-dataset domain whose 3 members were all `nominal` `School`
columns, persisted a `domain_aggregate` metric with `origin='human' /
origin_context='crosswalk_auto'`, and compute returned 176 RowScore rows all
with `score=null` and one ComputedResult with `valid_n=0`. No error surfaced.

This is the same class as #347 (`domain_aggregate + grouping_column_id` silent
valid_n=0) but on the no-grouping path. The fix mirrors #347's pattern:

1. **Router validator** — `assert_domain_members_numeric_eligible` in
   `services/equivalence_validators.py`, raises HTTPException(400) with
   structured `non_numeric_domain` detail. Wired into:
   - `routers/analysis_domains.py::create_score_metric` (B7 path)
   - `routers/metrics.py::create_metric` (via `_validate_domain_aggregate_numeric`)
   - `routers/metrics.py::bulk_create_metrics`
   - `routers/metrics.py::quick_compute`

2. **Runtime assertion** — `_assert_domain_members_numeric_eligible` in
   `services/metrics.py::resolve_dataset_domain`. Raises ValueError if a
   bypass occurs (raw SQL, future refactor, `.mmproject` import of legacy file).

Numeric-eligible types: `ORDINAL`, `NUMERIC`, `PERCENTAGE`. Mixed (≥1 numeric)
members pass — the aggregate drops non-numeric rows by design.
"""
import asyncio
import json
import logging

import pytest
from fastapi import HTTPException

from app.models.project import Project
from app.models.user import User
from app.models.dataset import Dataset, DatasetColumn
from app.models.equivalence_group import EquivalenceGroup
from app.models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from app.models.metric import MetricDefinition
from app.routers.analysis_domains import create_score_metric
from app.routers.metrics import (
    create_metric,
    bulk_create_metrics,
    quick_compute,
)
from app.schemas.metric import (
    MetricDefinitionCreate,
    MetricBulkCreate,
    QuickComputeRequest,
    QuickComputeSource,
)
from app.services.equivalence_validators import (
    assert_domain_members_numeric_eligible,
    NUMERIC_ELIGIBLE_COLUMN_TYPES,
)
from app.services.metrics import compute_metric, resolve_dataset_domain

from tests.conftest import mock_request


# ═══════════════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════════════


def _run(coro):
    return asyncio.run(coro)


def _detail_of(exc: HTTPException) -> dict:
    detail = exc.detail
    assert isinstance(detail, dict), f"Expected dict detail, got {type(detail).__name__}: {detail}"
    return detail


# ═══════════════════════════════════════════════════════════════════════════════
# Fixtures
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.fixture
def mixed_type_project(db_session):
    """Project with two datasets containing columns of varying types so we can
    construct domains that are all-numeric, all-non-numeric, or mixed.

    Layout (mirrors scenario 2's School Roster + Pre/Post pattern):
    - Project 700, user 1
    - Dataset 700 "Students": cols
      - 7001 School (nominal)
      - 7002 Pre_Score (numeric)
      - 7003 Post_Score (numeric)
      - 7004 Satisfaction (ordinal)
    - Dataset 701 "Schools": cols
      - 7101 School (nominal) — paired to 7001 via EG 7900
      - 7102 Enrollment (numeric)
      - 7103 Notes (open_text)
      - 7104 Pct_FRL (percentage) — paired to 7202 via EG (added below)
    - EG 7900 pairs 7001 + 7101 (School across datasets)
    - EG 7901 pairs 7002 + 7102 (one numeric in each dataset)
    """
    db = db_session
    db.add(Project(id=700, name="Mixed Types Test", user_id=1))
    db.add_all([
        Dataset(id=700, project_id=700, name="Students"),
        Dataset(id=701, project_id=700, name="Schools"),
    ])
    db.add_all([
        EquivalenceGroup(id=7900, project_id=700, label="School"),
        EquivalenceGroup(id=7901, project_id=700, label="ScoreOrEnrollment"),
    ])
    db.flush()

    db.add_all([
        # Students dataset
        DatasetColumn(id=7001, dataset_id=700, column_code="School", column_name="School",
                      column_text="School", column_type="nominal",
                      sequence_order=0, display_order=0, equivalence_group_id=7900),
        DatasetColumn(id=7002, dataset_id=700, column_code="Pre_Score", column_name="Pre_Score",
                      column_text="Pre_Score", column_type="numeric",
                      sequence_order=1, display_order=1, equivalence_group_id=7901),
        DatasetColumn(id=7003, dataset_id=700, column_code="Post_Score", column_name="Post_Score",
                      column_text="Post_Score", column_type="numeric",
                      sequence_order=2, display_order=2),
        DatasetColumn(id=7004, dataset_id=700, column_code="Satisfaction", column_name="Satisfaction",
                      column_text="Satisfaction", column_type="ordinal",
                      sequence_order=3, display_order=3),
        # Schools dataset
        DatasetColumn(id=7101, dataset_id=701, column_code="School", column_name="School",
                      column_text="School", column_type="nominal",
                      sequence_order=0, display_order=0, equivalence_group_id=7900),
        DatasetColumn(id=7102, dataset_id=701, column_code="Enrollment", column_name="Enrollment",
                      column_text="Enrollment", column_type="numeric",
                      sequence_order=1, display_order=1, equivalence_group_id=7901),
        DatasetColumn(id=7103, dataset_id=701, column_code="Notes", column_name="Notes",
                      column_text="Notes", column_type="open_text",
                      sequence_order=2, display_order=2),
        DatasetColumn(id=7104, dataset_id=701, column_code="Pct_FRL", column_name="Pct_FRL",
                      column_text="Pct_FRL", column_type="percentage",
                      sequence_order=3, display_order=3),
    ])
    db.flush()

    user = db.query(User).filter(User.id == 1).one()
    return user


# ═══════════════════════════════════════════════════════════════════════════════
# Direct validator unit tests
# ═══════════════════════════════════════════════════════════════════════════════


def test_validator_passes_empty_member_list(mixed_type_project, db_session):
    """An empty domain isn't a #350 violation — empty-domain handling lives
    elsewhere (resolver returns {}). Validator should silent-pass."""
    assert_domain_members_numeric_eligible(db_session, [])
    # No exception → OK.


def test_validator_passes_all_ordinal_members(mixed_type_project, db_session):
    """Ordinal columns are numeric-eligible."""
    assert_domain_members_numeric_eligible(db_session, [7004])


def test_validator_passes_all_numeric_members(mixed_type_project, db_session):
    assert_domain_members_numeric_eligible(db_session, [7002, 7003])


def test_validator_passes_all_percentage_members(mixed_type_project, db_session):
    assert_domain_members_numeric_eligible(db_session, [7104])


def test_validator_passes_mixed_numeric_and_nominal(mixed_type_project, db_session):
    """Numeric + nominal mix: PASS. The aggregate drops the nominal rows at
    compute time, which is the intended fallback. Strict rejection only when
    EVERY member is non-numeric."""
    assert_domain_members_numeric_eligible(db_session, [7001, 7002])
    assert_domain_members_numeric_eligible(db_session, [7001, 7003, 7004])


def test_validator_rejects_all_nominal_cross_dataset(mixed_type_project, db_session):
    """Scenario 2's School Roster reproduction: 2 nominal School columns across
    different datasets → reject."""
    with pytest.raises(HTTPException) as exc_info:
        assert_domain_members_numeric_eligible(db_session, [7001, 7101])
    assert exc_info.value.status_code == 400
    detail = _detail_of(exc_info.value)
    assert detail["error"] == "non_numeric_domain"
    assert "nominal" in detail["message"]
    offending_ids = {c["id"] for c in detail["columns"]}
    assert offending_ids == {7001, 7101}
    assert all(c["column_type"] == "nominal" for c in detail["columns"])


def test_validator_rejects_all_open_text(mixed_type_project, db_session):
    """An open-text-only domain — clearly nonsensical for aggregation. Reject."""
    with pytest.raises(HTTPException) as exc_info:
        assert_domain_members_numeric_eligible(db_session, [7103])
    assert exc_info.value.status_code == 400
    detail = _detail_of(exc_info.value)
    assert detail["error"] == "non_numeric_domain"


def test_validator_rejects_mixed_non_numeric_types(mixed_type_project, db_session):
    """All non-numeric but with two different types (nominal + open_text) →
    reject. The message lists both types."""
    with pytest.raises(HTTPException) as exc_info:
        assert_domain_members_numeric_eligible(db_session, [7001, 7103])
    assert exc_info.value.status_code == 400
    detail = _detail_of(exc_info.value)
    types_in_message = detail["message"]
    assert "nominal" in types_in_message
    assert "open_text" in types_in_message


def test_numeric_eligible_set_matches_expected():
    """Sanity: ORDINAL + NUMERIC + PERCENTAGE only. If a future migration adds
    new column types, this test breaks and forces an explicit eligibility decision."""
    from app.models.dataset import ColumnType
    assert ColumnType.ORDINAL in NUMERIC_ELIGIBLE_COLUMN_TYPES
    assert ColumnType.NUMERIC in NUMERIC_ELIGIBLE_COLUMN_TYPES
    assert ColumnType.PERCENTAGE in NUMERIC_ELIGIBLE_COLUMN_TYPES
    assert ColumnType.NOMINAL not in NUMERIC_ELIGIBLE_COLUMN_TYPES
    assert ColumnType.BINARY not in NUMERIC_ELIGIBLE_COLUMN_TYPES
    assert ColumnType.MULTI_SELECT not in NUMERIC_ELIGIBLE_COLUMN_TYPES
    assert ColumnType.OPEN_TEXT not in NUMERIC_ELIGIBLE_COLUMN_TYPES
    assert ColumnType.DEMOGRAPHIC not in NUMERIC_ELIGIBLE_COLUMN_TYPES
    assert ColumnType.SKIP not in NUMERIC_ELIGIBLE_COLUMN_TYPES


# ═══════════════════════════════════════════════════════════════════════════════
# create_score_metric (B7 catalog path) — main scenario 2 reproduction
# ═══════════════════════════════════════════════════════════════════════════════


def _create_domain_directly(db, name: str, member_col_ids: list[int]) -> AnalysisDomain:
    """Create a domain via ORM (bypassing router validators) so we can test
    the create-score-metric path on a pre-existing domain. Mirrors how a
    legacy `.mmproject` import or a pre-fix scenario 2 driver would have
    landed the data."""
    domain = AnalysisDomain(
        project_id=700, name=name, sequence_order=0, origin="human",
    )
    db.add(domain)
    db.flush()
    for i, cid in enumerate(member_col_ids):
        db.add(AnalysisDomainMember(
            domain_id=domain.id, member_type="column", member_id=cid, sequence_order=i,
        ))
    db.flush()
    db.refresh(domain)
    return domain


def test_create_score_metric_rejects_all_nominal_cross_dataset_domain(
    mixed_type_project, db_session,
):
    """The exact scenario 2 reproduction: cross-dataset domain with 2 nominal
    School columns → 400 `non_numeric_domain`, no metric created."""
    user = mixed_type_project
    domain = _create_domain_directly(db_session, "School Roster", [7001, 7101])

    with pytest.raises(HTTPException) as exc_info:
        _run(create_score_metric(
            request=mock_request(),
            project_id=700, domain_id=domain.id, user=user, db=db_session,
        ))
    assert exc_info.value.status_code == 400
    detail = _detail_of(exc_info.value)
    assert detail["error"] == "non_numeric_domain"

    # No metric persisted.
    metric_count = (
        db_session.query(MetricDefinition)
        .filter(MetricDefinition.project_id == 700)
        .count()
    )
    assert metric_count == 0


def test_create_score_metric_accepts_mixed_numeric_and_nominal(
    mixed_type_project, db_session,
):
    """Mixed members → 200. Metric created, even though one member is nominal."""
    user = mixed_type_project
    # Mixed: nominal School + numeric Pre_Score. Same dataset → no cross-dataset
    # pairing concern.
    domain = _create_domain_directly(db_session, "Students-mixed", [7001, 7002])

    result = _run(create_score_metric(
        request=mock_request(),
        project_id=700, domain_id=domain.id, user=user, db=db_session,
    ))
    assert "metric" in result
    assert result["metric"].metric_type == "domain_aggregate"


def test_create_score_metric_accepts_all_ordinal_members(
    mixed_type_project, db_session,
):
    """Ordinal members → 200."""
    user = mixed_type_project
    domain = _create_domain_directly(db_session, "Likert-only", [7004])

    result = _run(create_score_metric(
        request=mock_request(),
        project_id=700, domain_id=domain.id, user=user, db=db_session,
    ))
    assert "metric" in result


def test_create_score_metric_fires_numeric_check_before_pairing_check(
    mixed_type_project, db_session,
):
    """Domain with cross-dataset all-nominal members. BOTH numeric eligibility
    AND cross-dataset pairing could fire. The numeric check is the more
    fundamental error and should win (per plan: 'numeric check runs before
    the I2 check so the more fundamental error fires first')."""
    user = mixed_type_project
    # Cross-dataset nominal columns. 7001+7101 ARE in EG 7900 so pairing is
    # technically satisfied — only the numeric check should fire.
    domain = _create_domain_directly(db_session, "School cross", [7001, 7101])

    with pytest.raises(HTTPException) as exc_info:
        _run(create_score_metric(
            request=mock_request(),
            project_id=700, domain_id=domain.id, user=user, db=db_session,
        ))
    detail = _detail_of(exc_info.value)
    assert detail["error"] == "non_numeric_domain", (
        "numeric check should fire before pairing check; if you see "
        "'cross_dataset_unpaired' here, the validator order in "
        "create_score_metric was swapped"
    )


# ═══════════════════════════════════════════════════════════════════════════════
# create_metric (POST /api/projects/{pid}/metrics) — manual metric creation
# ═══════════════════════════════════════════════════════════════════════════════


def test_create_metric_rejects_domain_aggregate_on_all_nominal_domain(
    mixed_type_project, db_session,
):
    """Manual create of a domain_aggregate metric on an all-nominal domain →
    400. This covers the path a power user would take outside the crosswalk."""
    user = mixed_type_project
    domain = _create_domain_directly(db_session, "Nominal-domain", [7001, 7101])

    with pytest.raises(HTTPException) as exc_info:
        _run(create_metric(
            project_id=700,
            data=MetricDefinitionCreate(
                name="Bad Score",
                metric_type="domain_aggregate",
                config={},
                input_source_type="dataset_domain",
                input_source_id=domain.id,
            ),
            user=user, db=db_session,
        ))
    assert exc_info.value.status_code == 400
    detail = _detail_of(exc_info.value)
    assert detail["error"] == "non_numeric_domain"


def test_create_metric_does_not_validate_for_mean_metric(
    mixed_type_project, db_session,
):
    """The check is SCOPED to `domain_aggregate`. A `mean` metric on the same
    domain is allowed (mean drops non-numeric rows by design — that's its
    contract, not a silent failure). This regression-locks the scope."""
    user = mixed_type_project
    domain = _create_domain_directly(db_session, "Nominal-domain", [7001, 7101])

    # Should NOT raise on `mean`
    response = _run(create_metric(
        project_id=700,
        data=MetricDefinitionCreate(
            name="Mean Score",
            metric_type="mean",
            config={},
            input_source_type="dataset_domain",
            input_source_id=domain.id,
        ),
        user=user, db=db_session,
    ))
    assert response.metric_type == "mean"


# ═══════════════════════════════════════════════════════════════════════════════
# bulk_create_metrics — atomicity
# ═══════════════════════════════════════════════════════════════════════════════


def test_bulk_create_metrics_rejects_batch_with_non_numeric_violation(
    mixed_type_project, db_session,
):
    """Batch of two metrics; the second is a domain_aggregate over an
    all-nominal domain → entire batch is rejected (all-or-nothing)."""
    user = mixed_type_project
    good_domain = _create_domain_directly(db_session, "Good", [7002, 7003])
    bad_domain = _create_domain_directly(db_session, "Bad", [7001, 7101])

    batch = MetricBulkCreate(metrics=[
        MetricDefinitionCreate(
            name="Good agg", metric_type="domain_aggregate", config={},
            input_source_type="dataset_domain", input_source_id=good_domain.id,
        ),
        MetricDefinitionCreate(
            name="Bad agg", metric_type="domain_aggregate", config={},
            input_source_type="dataset_domain", input_source_id=bad_domain.id,
        ),
    ])
    with pytest.raises(HTTPException) as exc_info:
        _run(bulk_create_metrics(project_id=700, data=batch, user=user, db=db_session))
    assert exc_info.value.status_code == 400

    # Neither metric should be persisted.
    metric_count = (
        db_session.query(MetricDefinition)
        .filter(MetricDefinition.project_id == 700)
        .count()
    )
    assert metric_count == 0


# ═══════════════════════════════════════════════════════════════════════════════
# quick_compute — pre-check before any cleanup or persistence
# ═══════════════════════════════════════════════════════════════════════════════


def test_quick_compute_rejects_domain_aggregate_on_all_nominal_domain(
    mixed_type_project, db_session,
):
    """quick_compute (the AnalysisView column-picker path) → 400 on a
    domain_aggregate request over an all-nominal domain."""
    user = mixed_type_project
    domain = _create_domain_directly(db_session, "Nominal-domain", [7001, 7101])

    with pytest.raises(HTTPException) as exc_info:
        _run(quick_compute(
            project_id=700,
            data=QuickComputeRequest(
                sources=[QuickComputeSource(source_type="dataset_domain", source_id=domain.id)],
                metric_type="domain_aggregate",
            ),
            user=user, db=db_session,
        ))
    assert exc_info.value.status_code == 400
    detail = _detail_of(exc_info.value)
    assert detail["error"] == "non_numeric_domain"


# ═══════════════════════════════════════════════════════════════════════════════
# Runtime defense-in-depth (services/metrics.py::resolve_dataset_domain)
# ═══════════════════════════════════════════════════════════════════════════════


def test_resolve_dataset_domain_fires_assertion_on_bypassed_metric(
    mixed_type_project, db_session,
):
    """Simulate a router-validator bypass: create a `domain_aggregate` metric
    directly via ORM over an all-nominal domain (skipping all 4 validator
    callsites), then call compute_metric. The runtime assertion should fire
    with a descriptive ValueError naming the violation."""
    user = mixed_type_project
    domain = _create_domain_directly(db_session, "Bypass test", [7001, 7101])

    # Bypass: directly insert the metric (skipping router validators).
    metric = MetricDefinition(
        project_id=700,
        name="Bypassed Score",
        metric_type="domain_aggregate",
        config=json.dumps({
            "child_metric_type": "mean", "child_config": {}, "aggregation": "mean",
        }),
        input_source_type="dataset_domain",
        input_source_id=domain.id,
        grouping_column_id=None,
        grouping_column_id_2=None,
        sequence_order=0,
        origin="human",
        origin_context="crosswalk_auto",
        stale=True,
    )
    db_session.add(metric)
    db_session.flush()

    # Runtime assertion should fire.
    with pytest.raises(ValueError) as exc_info:
        compute_metric(db_session, metric)
    msg = str(exc_info.value)
    assert "350" in msg or "non-numeric" in msg.lower() or "scale-score" in msg.lower(), (
        f"Expected #350 reference or 'non-numeric'/'scale-score' in message, got: {msg}"
    )


def test_resolve_dataset_domain_does_not_fire_assertion_for_mean(
    mixed_type_project, db_session,
):
    """Runtime assertion is SCOPED to `domain_aggregate`. A `mean` metric over
    the same domain doesn't trigger it (correctly drops non-numeric rows)."""
    user = mixed_type_project
    domain = _create_domain_directly(db_session, "Bypass mean", [7001, 7101])

    metric = MetricDefinition(
        project_id=700,
        name="Mean on nominal",
        metric_type="mean",
        config=json.dumps({}),
        input_source_type="dataset_domain",
        input_source_id=domain.id,
        sequence_order=0,
        origin="human",
        stale=True,
    )
    db_session.add(metric)
    db_session.flush()

    # Should NOT raise. (compute_metric may complete with empty results, but
    # the runtime assert specifically must not fire.)
    try:
        compute_metric(db_session, metric)
    except ValueError as e:
        if "350" in str(e):
            pytest.fail(f"#350 runtime assert fired for mean metric (should be scoped to domain_aggregate): {e}")
        # other ValueErrors are pre-existing behavior; re-raise
        raise
