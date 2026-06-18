"""Tests for the metric-grouping validation hardening surfaced by scenario-1.

Two distinct findings get pinned here:

1. `metric_type='domain_aggregate'` + `grouping_column_id` is silently broken
   because `compute_domain_aggregate` only reads the None-key bucket. Before
   this hardening, the resulting MetricDefinition computed one ungrouped
   result with `valid_n=0` and no error surface. The router validator now
   rejects the combination so callers see the mistake.

2. Quick-compute / metric-create requests that set `grouping_column_id`
   without `grouping_mode` left the DB column NULL. Find_or_create's cache
   key normalizes NULL → 'column' so the lookup is unaffected, but the
   stored metric isn't self-describing (UI filters and exports that read
   grouping_mode must coalesce NULL → 'column' themselves). The Pydantic
   model validator now auto-defaults grouping_mode='column' so persisted
   metrics are unambiguous.
"""

from app.routers.metrics import _validate_grouping_mode
from app.schemas.metric import MetricDefinitionCreate, QuickComputeRequest


# ── Rejection: domain_aggregate + column grouping ────────────────────────────


def test_validator_rejects_domain_aggregate_with_grouping_column():
    errors = _validate_grouping_mode(
        grouping_mode="column",
        input_source_type="dataset_domain",
        metric_type="domain_aggregate",
        grouping_column_id=42,
    )
    assert errors, "Expected at least one error"
    assert any("domain aggregate" in e.lower() for e in errors)


def test_validator_accepts_domain_aggregate_without_grouping():
    errors = _validate_grouping_mode(
        grouping_mode=None,
        input_source_type="dataset_domain",
        metric_type="domain_aggregate",
        grouping_column_id=None,
    )
    assert errors == []


def test_validator_accepts_mean_on_domain_with_grouping_column():
    """The recommended path for 'domain score by group' — mean on the domain.
    This must remain valid; it's the workaround the rejection message points
    callers toward."""
    errors = _validate_grouping_mode(
        grouping_mode="column",
        input_source_type="dataset_domain",
        metric_type="mean",
        grouping_column_id=42,
    )
    assert errors == []


def test_validator_preserves_existing_dataset_grouping_rejection():
    """Existing 'group by dataset is not supported for domain aggregate'
    rejection (line 219) must still fire — regression guard."""
    errors = _validate_grouping_mode(
        grouping_mode="dataset",
        input_source_type="dataset_domain",
        metric_type="domain_aggregate",
        grouping_column_id=None,
    )
    assert errors
    assert any("dataset" in e.lower() and "domain aggregate" in e.lower() for e in errors)


# ── Auto-default: grouping_mode='column' when grouping_column_id is set ──────


def test_metric_create_auto_defaults_grouping_mode_to_column():
    payload = MetricDefinitionCreate(
        name="Mean: Q5 by Neighborhood",
        metric_type="mean",
        config={},
        input_source_type="dataset_column",
        input_source_id=10,
        grouping_column_id=20,
        # grouping_mode intentionally omitted
    )
    assert payload.grouping_mode == "column"


def test_metric_create_preserves_explicit_grouping_mode():
    payload = MetricDefinitionCreate(
        name="Mean: Q5 by dataset",
        metric_type="mean",
        config={},
        input_source_type="dataset_domain",
        input_source_id=10,
        grouping_mode="dataset",
    )
    assert payload.grouping_mode == "dataset"


def test_metric_create_leaves_grouping_mode_null_when_no_grouping():
    payload = MetricDefinitionCreate(
        name="Mean: Q5 ungrouped",
        metric_type="mean",
        config={},
        input_source_type="dataset_column",
        input_source_id=10,
    )
    assert payload.grouping_mode is None


def test_quick_compute_auto_defaults_grouping_mode_to_column():
    payload = QuickComputeRequest(
        sources=[{"source_type": "dataset_column", "source_id": 10}],
        metric_type="mean",
        config={},
        grouping_column_id=20,
        # grouping_mode intentionally omitted
    )
    assert payload.grouping_mode == "column"


def test_quick_compute_preserves_explicit_grouping_mode_dataset():
    payload = QuickComputeRequest(
        sources=[{"source_type": "dataset_domain", "source_id": 10}],
        metric_type="mean",
        config={},
        grouping_mode="dataset",
    )
    assert payload.grouping_mode == "dataset"


def test_quick_compute_no_grouping_no_default():
    """Bare quick-compute (no grouping) must not invent a grouping_mode."""
    payload = QuickComputeRequest(
        sources=[{"source_type": "dataset_column", "source_id": 10}],
        metric_type="frequency_distribution",
        config={},
    )
    assert payload.grouping_mode is None
