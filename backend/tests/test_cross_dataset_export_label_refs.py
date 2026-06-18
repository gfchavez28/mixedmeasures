"""Tests for #293, #292, #296 — cross-dataset export comments,
domain-score subset labels, and Material referential integrity.

#293 R export: cross-dataset domains emit a comment block + per-dataset
breakdown alongside the all-up `mean(colMeans(...))`. Single-dataset
domains use the original form unchanged.

#292 /domain-scores response includes `is_cross_dataset_subset`,
`subset_dataset_name`, and `member_dataset_count` so the Dataset View
virtual column header can render "Wellness — Board subset" with a
tooltip explaining the scope.

#296 MaterialResponse includes `has_missing_refs` + `missing_refs`. The
detection walks `config.column_ids` / `config.domain_ids` and the
grouping/compare scalar keys; misses (deleted column IDs) surface in
the response so the canvas embed can show a "Sources missing" warning.
"""
import asyncio
import json

import pytest

from app.models.project import Project
from app.models.user import User
from app.models.dataset import Dataset, DatasetColumn
from app.models.equivalence_group import EquivalenceGroup
from app.models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from app.models.materials import MaterialCollection, Material
from app.routers.dataset import get_domain_scores
from app.routers.export_r import _emit_domain_aggregate_r_lines
from app.routers.materials import (
    _build_material_response,
    _build_existence_sets,
    _collect_material_refs,
)


def _run(coro):
    return asyncio.run(coro)


# ── #293 — R export per-dataset breakdown ────────────────────────────────────


def test_r_export_single_dataset_domain_unchanged():
    """Single-dataset domains use the original mean(colMeans(...)) form
    — no comment block, no per-dataset breakdown."""
    members_by_ds = {"Board": ["BQ1", "BQ2", "BQ3"]}
    lines = _emit_domain_aggregate_r_lines(members_by_ds, "domains$wellness")
    assert lines == [
        # #363: ordinal members are ordered factors; .mm_num() coerces them to
        # numeric so colMeans doesn't error on factor columns.
        "domain_means <- colMeans(.mm_num(data[, domains$wellness]), na.rm = TRUE)",
        "mean(domain_means)",
    ]


def test_r_export_cross_dataset_domain_emits_comment_and_per_dataset_breakdown():
    """Cross-dataset domain emits the all-up form (matches
    compute_domain_aggregate) PLUS a comment block + per-dataset
    `colMeans(data[data$dataset == "...", c(...)])` blocks for transparency.
    Datasets emitted in deterministic sorted order."""
    members_by_ds = {
        "Staff": ["SQ1", "SQ2"],
        "Board": ["BQ1", "BQ2"],
    }
    lines = _emit_domain_aggregate_r_lines(members_by_ds, "domains$wellness")

    text = "\n".join(lines)
    # All-up form preserved (matches compute_domain_aggregate semantics)
    assert "domain_means <- colMeans(.mm_num(data[, domains$wellness]), na.rm = TRUE)" in text
    assert "mean(domain_means)" in text
    # Clarifying comment block surfaces the cross-dataset interpretation
    assert "Cross-dataset domain" in text
    assert "compute_domain_aggregate" in text
    # The comment is hard-wrapped across two lines; check for either half.
    assert "disjoint" in text and "respondent populations" in text
    # Per-dataset breakdowns (deterministic alphabetic order: Board, Staff)
    board_idx = text.find("# Board subset")
    staff_idx = text.find("# Staff subset")
    assert board_idx > 0 and staff_idx > 0
    assert board_idx < staff_idx
    # Each per-dataset block uses the correct subset filter + members
    assert 'data[data$dataset == "Board", c("BQ1", "BQ2")]' in text
    assert 'data[data$dataset == "Staff", c("SQ1", "SQ2")]' in text


def test_r_export_empty_or_missing_breakdown_falls_back_to_original():
    """If members_by_dataset is None (legacy callers / portability import),
    behavior matches the original code path."""
    lines_none = _emit_domain_aggregate_r_lines(None, "domains$x")
    assert "Cross-dataset" not in "\n".join(lines_none)
    assert "domain_means <- colMeans(.mm_num(data[, domains$x]), na.rm = TRUE)" in lines_none


# ── #292 — domain-scores subset label ────────────────────────────────────────


@pytest.fixture
def project_with_cross_dataset_domain(db_session):
    """Two-dataset domain fixture for domain-score testing."""
    db = db_session
    project = Project(id=920, name="DomainScores Test", user_id=1)
    db.add(project)

    board = Dataset(id=920, project_id=920, name="Board")
    staff = Dataset(id=921, project_id=920, name="Staff")
    db.add_all([board, staff])

    eg = EquivalenceGroup(id=9200, project_id=920, label="Q1 bridge")
    db.add(eg)
    db.flush()

    db.add_all([
        DatasetColumn(id=9201, dataset_id=920, column_code="BQ1", column_name="BQ1",
                      column_text="Board Q1", column_type="ordinal",
                      sequence_order=0, display_order=0,
                      equivalence_group_id=9200),
        DatasetColumn(id=9251, dataset_id=921, column_code="SQ1", column_name="SQ1",
                      column_text="Staff Q1", column_type="ordinal",
                      sequence_order=0, display_order=0,
                      equivalence_group_id=9200),
    ])
    db.flush()

    domain = AnalysisDomain(id=9210, project_id=920, name="Vision")
    db.add(domain)
    db.flush()

    db.add_all([
        AnalysisDomainMember(domain_id=9210, member_type="column", member_id=9201, sequence_order=0),
        AnalysisDomainMember(domain_id=9210, member_type="column", member_id=9251, sequence_order=1),
    ])
    db.flush()

    user = db.query(User).filter(User.id == 1).one()
    return project, user


def test_domain_scores_flags_cross_dataset_subset(project_with_cross_dataset_domain, db_session):
    """A cross-dataset domain viewed from one dataset surfaces the subset
    metadata so the frontend can render '<name> — <dataset> subset'."""
    from app.models.metric import MetricDefinition
    db = db_session

    metric = MetricDefinition(
        project_id=920,
        name="Vision aggregate",
        metric_type="domain_aggregate",
        input_source_type="dataset_domain",
        input_source_id=9210,
        config="{}",
        origin="human",
        origin_context="crosswalk_auto",
        stale=False,
    )
    db.add(metric)
    db.flush()

    _, user = project_with_cross_dataset_domain
    result = _run(get_domain_scores(
        project_id=920,
        dataset_id=920,  # Board
        user=user,
        db=db,
    ))
    scores = result["domain_scores"]
    assert len(scores) == 1
    s = scores[0]
    assert s["domain_name"] == "Vision"
    assert s["is_cross_dataset_subset"] is True
    assert s["subset_dataset_name"] == "Board"
    assert s["member_dataset_count"] == 2


def test_domain_scores_single_dataset_no_subset_flag(project_with_cross_dataset_domain, db_session):
    """A single-dataset domain in the same project must NOT trigger the
    subset flag — no false positives on the common case."""
    from app.models.metric import MetricDefinition
    db = db_session

    db.add(DatasetColumn(
        id=9202, dataset_id=920, column_code="BQ_solo", column_name="BQ_solo",
        column_text="Board solo", column_type="ordinal",
        sequence_order=1, display_order=1,
    ))
    solo_domain = AnalysisDomain(id=9211, project_id=920, name="Solo Board")
    db.add(solo_domain)
    db.flush()
    db.add(AnalysisDomainMember(
        domain_id=9211, member_type="column", member_id=9202, sequence_order=0,
    ))
    metric = MetricDefinition(
        project_id=920,
        name="Solo aggregate",
        metric_type="domain_aggregate",
        input_source_type="dataset_domain",
        input_source_id=9211,
        config="{}",
        origin="human",
        origin_context="crosswalk_auto",
        stale=False,
    )
    db.add(metric)
    db.flush()

    _, user = project_with_cross_dataset_domain
    result = _run(get_domain_scores(
        project_id=920,
        dataset_id=920,
        user=user,
        db=db,
    ))
    solo = next(s for s in result["domain_scores"] if s["domain_name"] == "Solo Board")
    assert solo["is_cross_dataset_subset"] is False
    assert solo["subset_dataset_name"] is None
    assert solo["member_dataset_count"] == 1


# ── #296 — Material referential integrity ────────────────────────────────────


@pytest.fixture
def project_with_material(db_session):
    """Project with two columns + one domain + a material referencing all three."""
    db = db_session
    project = Project(id=960, name="Material Refs Test", user_id=1)
    db.add(project)

    ds = Dataset(id=960, project_id=960, name="Board")
    db.add(ds)

    db.add_all([
        DatasetColumn(id=9601, dataset_id=960, column_code="Q1", column_name="Q1",
                      column_text="Q1", column_type="ordinal",
                      sequence_order=0, display_order=0),
        DatasetColumn(id=9602, dataset_id=960, column_code="Q2", column_name="Q2",
                      column_text="Q2", column_type="ordinal",
                      sequence_order=1, display_order=1),
    ])
    domain = AnalysisDomain(id=9610, project_id=960, name="Vision")
    db.add(domain)
    db.flush()

    coll = MaterialCollection(id=9620, project_id=960, name="Materials", display_order=0)
    db.add(coll)
    db.flush()

    return project, ds, coll


def test_collect_material_refs_extracts_lists_and_scalars():
    """Helper extracts the canvas-relevant ref keys: column_ids, domain_ids,
    and the grouping/compare scalar keys."""
    config = {
        "column_ids": [101, 102],
        "domain_ids": [201],
        "selected_columns": [103],  # legacy alias
        "selected_domains": [202],
        "grouping_column_id": 301,
        "grouping_column_id_2": 302,
        "compareBy": 303,
        "metric_type": "mean",  # not a ref; should be ignored
    }
    cols, doms = _collect_material_refs(config)
    assert cols == {101, 102, 103, 301, 302, 303}
    assert doms == {201, 202}


def test_collect_material_refs_handles_invalid_config():
    """Missing or malformed config returns empty sets — never raises."""
    assert _collect_material_refs({}) == (set(), set())
    assert _collect_material_refs({"column_ids": "not a list"}) == (set(), set())
    assert _collect_material_refs({"column_ids": [None, "x", 0, -1]}) == (set(), set())


def test_material_response_flags_missing_column_refs(project_with_material, db_session):
    """A material referencing a deleted column ID surfaces has_missing_refs
    + the specific missing ID in missing_refs."""
    _, _ds, coll = project_with_material
    db = db_session

    config = {"column_ids": [9601, 99999], "metric_type": "mean"}
    m = Material(
        collection_id=coll.id,
        material_type="chart",
        config=json.dumps(config),
        auto_name="Test chart",
        display_order=0,
        source_tab="descriptives",
    )
    db.add(m)
    db.flush()

    existing_cols, existing_doms = _build_existence_sets(db, project_id=960, materials=[m])
    response = _build_material_response(m, existing_cols, existing_doms)

    assert response.has_missing_refs is True
    assert {"type": "column", "id": 99999} in response.missing_refs
    # 9601 exists; only 99999 missing
    assert len(response.missing_refs) == 1


def test_material_response_clean_when_all_refs_exist(project_with_material, db_session):
    """No false positive: all refs exist → has_missing_refs is False."""
    _, _ds, coll = project_with_material
    db = db_session

    config = {"column_ids": [9601, 9602], "domain_ids": [9610]}
    m = Material(
        collection_id=coll.id,
        material_type="chart",
        config=json.dumps(config),
        auto_name="Clean chart",
        display_order=0,
        source_tab="descriptives",
    )
    db.add(m)
    db.flush()

    existing_cols, existing_doms = _build_existence_sets(db, project_id=960, materials=[m])
    response = _build_material_response(m, existing_cols, existing_doms)

    assert response.has_missing_refs is False
    assert response.missing_refs == []


def test_material_response_flags_missing_domain_ref(project_with_material, db_session):
    """Domain-typed ref check works the same way."""
    _, _ds, coll = project_with_material
    db = db_session

    config = {"domain_ids": [88888]}
    m = Material(
        collection_id=coll.id,
        material_type="chart",
        config=json.dumps(config),
        auto_name="Missing domain",
        display_order=0,
        source_tab="descriptives",
    )
    db.add(m)
    db.flush()

    existing_cols, existing_doms = _build_existence_sets(db, project_id=960, materials=[m])
    response = _build_material_response(m, existing_cols, existing_doms)

    assert response.has_missing_refs is True
    assert response.missing_refs == [{"type": "domain", "id": 88888}]


def test_material_response_skips_check_when_no_existence_sets(project_with_material, db_session):
    """Write paths (create/update) call _build_material_response without
    existence sets — the check is skipped entirely (fresh refs by
    construction)."""
    _, _ds, coll = project_with_material
    db = db_session

    config = {"column_ids": [99999]}
    m = Material(
        collection_id=coll.id,
        material_type="chart",
        config=json.dumps(config),
        auto_name="Write-path test",
        display_order=0,
        source_tab="descriptives",
    )
    db.add(m)
    db.flush()

    response = _build_material_response(m)
    assert response.has_missing_refs is False
    assert response.missing_refs == []
