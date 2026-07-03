"""Metric definition endpoints for the Computed Metrics Engine."""

import json
import logging

logger = logging.getLogger(__name__)

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func as sa_func
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..database import get_db
from ..models.user import User
from ..models.metric import MetricDefinition, ComputedResult
from ..schemas.metric import (
    MetricDefinitionCreate,
    MetricDefinitionUpdate,
    MetricBulkCreate,
    MetricReorderRequest,
    ComputeAllRequest,
    ValidateConfigRequest,
    ComputedResultResponse,
    MetricDefinitionResponse,
    MetricDefinitionSummaryResponse,
    MetricListResponse,
    ComputeAllResponse,
    ValidateConfigResponse,
    BulkCreateResponse,
    QuickComputeRequest,
    QuickComputeResponse,
    AnalysisColumnsResponse,
    AnalysisColumnItem,
    AnalysisDatasetGroup,
    AnalysisDomainItem,
    AnalysisDemographicItem,
    CrossTabRequest,
    CrossTabCell,
    CrossTabResponse,
    ChiSquareResult,
    RowScoreItem,
    RowScoresResponse,
    MatrixColumnInfo,
    MatrixRowItem,
    RowMatrixResponse,
)
from ..services.metrics import (
    validate_metric_config,
    compute_metric,
    compute_all_for_project,
    resolve_input_source_labels,
    find_or_create_metric,
    decompose_domain_sources,
    _check_source_exists,
    _parse_json,
)
from ..services.metric_cleanup import cleanup_auto_metrics
from ..services.equivalence_validators import assert_domain_members_numeric_eligible
from ..services.audit import log_action
from ..models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from .helpers import _get_project_or_404, _validate_column_in_project
from .export_helpers import csv_safe


def _validate_domain_aggregate_numeric(
    db: Session, metric_type: str, input_source_type: str, input_source_id: int,
) -> None:
    """#350 pre-check: a `domain_aggregate` metric on a `dataset_domain` source
    rejects up-front when every member column of the domain is non-numeric.

    Raises HTTPException(400) with structured `non_numeric_domain` detail
    (see `assert_domain_members_numeric_eligible` in equivalence_validators).
    No-op for non-domain or non-aggregate metrics.

    Wired into `create_metric`, `bulk_create_metrics`, and `quick_compute`
    so all 4 create paths for `domain_aggregate` carry the same guard.
    (`create_score_metric` in `routers/analysis_domains.py` calls the
    validator directly with the loaded domain members.)
    """
    if metric_type != "domain_aggregate":
        return
    if input_source_type != "dataset_domain":
        return
    member_col_ids = [
        row[0] for row in
        db.query(AnalysisDomainMember.member_id)
        .filter(
            AnalysisDomainMember.domain_id == input_source_id,
            AnalysisDomainMember.member_type == "column",
        )
        .all()
    ]
    assert_domain_members_numeric_eligible(db, member_col_ids)

router = APIRouter(
    prefix="/api/projects/{project_id}/metrics",
    tags=["metrics"],
)


# ── Helpers ──────────────────────────────────────────────────────────────────


def _get_metric_or_404(
    db: Session, project_id: int, metric_id: int,
) -> MetricDefinition:
    metric = (
        db.query(MetricDefinition)
        .filter(
            MetricDefinition.id == metric_id,
            MetricDefinition.project_id == project_id,
        )
        .first()
    )
    if not metric:
        raise HTTPException(status_code=404, detail="Metric definition not found")
    return metric


def _build_metric_response(
    metric: MetricDefinition,
    db: Session,
    label_map: dict[tuple[str, int], str] | None = None,
) -> MetricDefinitionResponse:
    """Build a full MetricDefinitionResponse with parsed JSON and resolved label."""
    if label_map is None:
        label_map = resolve_input_source_labels(db, [metric])

    config = _parse_json(metric.config) or {}
    exclude_values = _parse_json(metric.exclude_values)

    results = []
    for r in metric.results:
        results.append(ComputedResultResponse(
            id=r.id,
            group_value=r.group_value,
            result_data=_parse_json(r.result_data) or {},
            valid_n=r.valid_n,
            total_n=r.total_n,
            computed_at=r.computed_at,
        ))

    # Use decompose_label as input_source_label when present
    decompose_label = config.get("decompose_label")
    source_label = decompose_label or label_map.get(
        (metric.input_source_type, metric.input_source_id)
    )

    return MetricDefinitionResponse(
        id=metric.id,
        project_id=metric.project_id,
        name=metric.name,
        description=metric.description,
        metric_type=metric.metric_type,
        config=config,
        input_source_type=metric.input_source_type,
        input_source_id=metric.input_source_id,
        input_source_label=source_label,
        grouping_column_id=metric.grouping_column_id,
        grouping_column_id_2=metric.grouping_column_id_2,
        grouping_mode=metric.grouping_mode,
        exclude_values=exclude_values,
        sequence_order=metric.sequence_order,
        origin=metric.origin,
        origin_context=metric.origin_context,
        stale=metric.stale,
        result_type=metric.result_type,
        results=results,
        last_accessed_at=metric.last_accessed_at,
        created_at=metric.created_at,
        updated_at=metric.updated_at,
    )


def _build_summary_response(
    metric: MetricDefinition,
    stats_tuple: tuple | None,
    label_map: dict[tuple[str, int], str],
) -> MetricDefinitionSummaryResponse:
    """Build a summary response for the list endpoint."""
    config = _parse_json(metric.config) or {}
    exclude_values = _parse_json(metric.exclude_values)

    latest_computed_at = None
    total_valid_n = None
    result_count = 0
    real_group_count = 0
    if stats_tuple:
        latest_computed_at, total_valid_n, result_count, real_group_count = stats_tuple

    # Use decompose_label as input_source_label when present
    decompose_label = config.get("decompose_label")
    source_label = decompose_label or label_map.get(
        (metric.input_source_type, metric.input_source_id)
    )

    return MetricDefinitionSummaryResponse(
        id=metric.id,
        project_id=metric.project_id,
        name=metric.name,
        description=metric.description,
        metric_type=metric.metric_type,
        config=config,
        input_source_type=metric.input_source_type,
        input_source_id=metric.input_source_id,
        input_source_label=source_label,
        grouping_column_id=metric.grouping_column_id,
        grouping_column_id_2=metric.grouping_column_id_2,
        grouping_mode=metric.grouping_mode,
        exclude_values=exclude_values,
        sequence_order=metric.sequence_order,
        origin=metric.origin,
        origin_context=metric.origin_context,
        stale=metric.stale,
        result_type=metric.result_type,
        latest_computed_at=latest_computed_at,
        total_valid_n=int(total_valid_n) if total_valid_n is not None else None,
        result_count=result_count or 0,
        real_group_count=real_group_count or 0,
        last_accessed_at=metric.last_accessed_at,
        created_at=metric.created_at,
        updated_at=metric.updated_at,
    )


def _validate_grouping_mode(
    grouping_mode: str | None,
    input_source_type: str,
    metric_type: str,
    grouping_column_id: int | None,
    grouping_column_id_2: int | None = None,
) -> list[str]:
    """Validate grouping_mode and composite grouping constraints. Returns list of error messages."""
    errors: list[str] = []

    # Composite grouping constraints
    if grouping_column_id_2 is not None:
        if grouping_column_id is None:
            errors.append("grouping_column_id_2 requires grouping_column_id to also be set")
        if grouping_mode == "dataset":
            errors.append("Composite grouping cannot be combined with dataset grouping")
        if metric_type == "domain_aggregate":
            errors.append("Composite grouping is not supported for domain aggregate metrics")
        if grouping_column_id is not None and grouping_column_id_2 == grouping_column_id:
            errors.append("Cannot group by the same column twice")

    # Dataset grouping constraints
    if grouping_mode == "dataset":
        if input_source_type == "dataset_column":
            errors.append(
                "Group by dataset is only available for variable group metrics, "
                "not individual column metrics"
            )
        if metric_type == "domain_aggregate":
            errors.append(
                "Group by dataset is not supported for domain aggregate metrics"
            )
        if grouping_column_id is not None:
            errors.append(
                "grouping_column_id must be null when grouping_mode is 'dataset'"
            )

    # Column grouping + domain_aggregate is silently broken — compute_domain_aggregate
    # only reads the None-key bucket (services/metrics.py::compute_domain_aggregate),
    # so a grouped domain_aggregate computes one ungrouped result with valid_n=0
    # rather than splitting by group. Reject up-front so callers see the mistake
    # instead of an empty chart. Use `mean` on the domain for grouped scale-score-
    # like analyses (pools rows across member columns per group).
    if (
        metric_type == "domain_aggregate"
        and grouping_column_id is not None
    ):
        errors.append(
            "Group by column is not supported for domain aggregate metrics. "
            "Use metric_type='mean' on the domain for grouped scale-score analysis."
        )

    return errors


def _validate_and_prepare(
    db: Session, project_id: int, data: MetricDefinitionCreate,
) -> tuple[list[str], str, str | None]:
    """Validate config and source, return (errors, config_json, exclude_json)."""
    errors = validate_metric_config(data.metric_type, data.config)

    source_err = _check_source_exists(
        db, project_id, data.input_source_type, data.input_source_id,
    )
    if source_err:
        errors.append(source_err)

    errors.extend(_validate_grouping_mode(
        data.grouping_mode, data.input_source_type,
        data.metric_type, data.grouping_column_id,
        data.grouping_column_id_2,
    ))

    # Validate grouping columns belong to project
    if data.grouping_column_id is not None:
        _validate_column_in_project(db, data.grouping_column_id, project_id)
    if data.grouping_column_id_2 is not None:
        _validate_column_in_project(db, data.grouping_column_id_2, project_id)

    config_json = json.dumps(data.config)
    exclude_json = json.dumps(data.exclude_values) if data.exclude_values else None

    return errors, config_json, exclude_json


# ── Endpoints ────────────────────────────────────────────────────────────────
# CRITICAL: Fixed-string paths must come BEFORE /{metric_id} paths


@router.get("", response_model=MetricListResponse)
async def list_metrics(
    project_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """List all metric definitions with summary stats."""
    _get_project_or_404(db, project_id, user.id)

    # Subquery for computed result stats per metric
    stats_subq = (
        db.query(
            ComputedResult.metric_definition_id,
            sa_func.max(ComputedResult.computed_at).label("latest_computed_at"),
            sa_func.sum(ComputedResult.valid_n).label("total_valid_n"),
            sa_func.count(ComputedResult.id).label("result_count"),
            # #506: COUNT(group_value) skips NULLs — the None listwise-deletion
            # bucket is a result row but not a real group; test pickers and
            # "(N groups)" displays must use this, not result_count.
            sa_func.count(ComputedResult.group_value).label("real_group_count"),
        )
        .group_by(ComputedResult.metric_definition_id)
        .subquery()
    )

    rows = (
        db.query(MetricDefinition, stats_subq)
        .outerjoin(
            stats_subq,
            MetricDefinition.id == stats_subq.c.metric_definition_id,
        )
        .filter(MetricDefinition.project_id == project_id)
        .order_by(
            MetricDefinition.sequence_order.asc(),
            MetricDefinition.id.asc(),
        )
        .all()
    )

    # Extract metrics for label resolution
    metrics = [row[0] for row in rows]
    label_map = resolve_input_source_labels(db, metrics)

    responses = []
    for row in rows:
        metric = row[0]
        # row layout: (MetricDefinition, metric_definition_id, latest_computed_at, total_valid_n, result_count, real_group_count)
        stats = (row[2], row[3], row[4], row[5]) if row[2] is not None else None
        responses.append(_build_summary_response(metric, stats, label_map))

    return MetricListResponse(metrics=responses, total=len(responses))


@router.post("", response_model=MetricDefinitionResponse, status_code=201)
async def create_metric(
    project_id: int,
    data: MetricDefinitionCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create a metric definition."""
    _get_project_or_404(db, project_id, user.id)

    # #350: reject domain_aggregate over an all-non-numeric domain. Raises
    # HTTPException(400) with structured detail; propagates ahead of the
    # error-string aggregation below so the frontend gets the structured
    # error rather than a flattened-string fallback.
    _validate_domain_aggregate_numeric(
        db, data.metric_type, data.input_source_type, data.input_source_id,
    )

    errors, config_json, exclude_json = _validate_and_prepare(db, project_id, data)
    if errors:
        raise HTTPException(status_code=400, detail="; ".join(errors))

    # Auto-assign sequence_order
    max_order = (
        db.query(sa_func.max(MetricDefinition.sequence_order))
        .filter(MetricDefinition.project_id == project_id)
        .scalar()
    )
    next_order = (max_order or 0) + 1 if data.sequence_order == 0 else data.sequence_order

    metric = MetricDefinition(
        project_id=project_id,
        name=data.name,
        description=data.description,
        metric_type=data.metric_type,
        config=config_json,
        input_source_type=data.input_source_type,
        input_source_id=data.input_source_id,
        grouping_column_id=data.grouping_column_id,
        grouping_column_id_2=data.grouping_column_id_2,
        grouping_mode=data.grouping_mode,
        exclude_values=exclude_json,
        sequence_order=next_order,
    )
    db.add(metric)
    db.flush()

    log_action(
        db,
        action="created",
        entity_type="metric_definition",
        entity_id=metric.id,
        user_id=user.id,
        project_id=project_id,
        details={"name": metric.name, "metric_type": metric.metric_type},
    )
    db.commit()
    db.refresh(metric)

    return _build_metric_response(metric, db)


@router.post("/bulk", response_model=BulkCreateResponse, status_code=201)
async def bulk_create_metrics(
    project_id: int,
    data: MetricBulkCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create multiple metric definitions at once."""
    _get_project_or_404(db, project_id, user.id)

    # Validate all first
    all_errors: list[str] = []
    for i, m in enumerate(data.metrics):
        # #350: structured-error pre-check (propagates as 400 with
        # `non_numeric_domain` detail). Rolls back the entire bulk batch on
        # first violation — matches the existing "all-or-nothing" semantics
        # below where any per-metric error fails the whole batch.
        _validate_domain_aggregate_numeric(
            db, m.metric_type, m.input_source_type, m.input_source_id,
        )

        errors = validate_metric_config(m.metric_type, m.config)
        source_err = _check_source_exists(
            db, project_id, m.input_source_type, m.input_source_id,
        )
        if source_err:
            errors.append(source_err)
        errors.extend(_validate_grouping_mode(
            m.grouping_mode, m.input_source_type,
            m.metric_type, m.grouping_column_id,
            m.grouping_column_id_2,
        ))
        for err in errors:
            all_errors.append(f"metrics[{i}]: {err}")

    if all_errors:
        raise HTTPException(status_code=400, detail="; ".join(all_errors))

    max_order = (
        db.query(sa_func.max(MetricDefinition.sequence_order))
        .filter(MetricDefinition.project_id == project_id)
        .scalar()
    )
    next_order = (max_order or 0) + 1

    created_metrics: list[MetricDefinition] = []
    for m_data in data.metrics:
        config_json = json.dumps(m_data.config)
        exclude_json = json.dumps(m_data.exclude_values) if m_data.exclude_values else None

        metric = MetricDefinition(
            project_id=project_id,
            name=m_data.name,
            description=m_data.description,
            metric_type=m_data.metric_type,
            config=config_json,
            input_source_type=m_data.input_source_type,
            input_source_id=m_data.input_source_id,
            grouping_column_id=m_data.grouping_column_id,
            grouping_column_id_2=m_data.grouping_column_id_2,
            grouping_mode=m_data.grouping_mode,
            exclude_values=exclude_json,
            sequence_order=next_order,
        )
        db.add(metric)
        db.flush()
        next_order += 1

        log_action(
            db,
            action="created",
            entity_type="metric_definition",
            entity_id=metric.id,
            user_id=user.id,
            project_id=project_id,
            details={"name": metric.name, "metric_type": metric.metric_type},
        )
        created_metrics.append(metric)

    db.commit()

    label_map = resolve_input_source_labels(db, created_metrics)
    responses = [_build_metric_response(m, db, label_map) for m in created_metrics]
    return BulkCreateResponse(created=len(responses), metrics=responses)


@router.post("/reorder")
async def reorder_metrics(
    project_id: int,
    data: MetricReorderRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Reorder metric definitions by updating sequence_order."""
    _get_project_or_404(db, project_id, user.id)

    for i, metric_id in enumerate(data.metric_ids):
        db.query(MetricDefinition).filter(
            MetricDefinition.id == metric_id,
            MetricDefinition.project_id == project_id,
        ).update({"sequence_order": i}, synchronize_session="fetch")

    db.commit()
    return {"status": "ok"}


@router.post("/compute-all", response_model=ComputeAllResponse)
async def compute_all(
    project_id: int,
    data: ComputeAllRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Compute (or recompute) all metrics for a project."""
    _get_project_or_404(db, project_id, user.id)

    result = compute_all_for_project(db, project_id, stale_only=data.stale_only)

    log_action(
        db,
        action="computed",
        entity_type="metric_definition",
        entity_id=None,
        user_id=user.id,
        project_id=project_id,
        details={"computed": result["computed"], "error_count": len(result["errors"])},
    )
    db.commit()

    return ComputeAllResponse(**result)


@router.post("/validate-config", response_model=ValidateConfigResponse)
async def validate_config(
    project_id: int,
    data: ValidateConfigRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Validate a metric configuration without creating it."""
    _get_project_or_404(db, project_id, user.id)

    errors = validate_metric_config(data.metric_type, data.config)

    source_err = _check_source_exists(
        db, project_id, data.input_source_type, data.input_source_id,
    )
    if source_err:
        errors.append(source_err)

    return ValidateConfigResponse(valid=len(errors) == 0, errors=errors)


@router.post("/quick-compute", response_model=QuickComputeResponse)
async def quick_compute(
    project_id: int,
    data: QuickComputeRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Find-or-create metrics for the given sources and compute any that need it.

    This is the primary endpoint for the column-picker workflow: the frontend
    sends a list of column/domain IDs + a metric type, and gets back fully
    computed MetricDefinitionResponses.
    """
    _get_project_or_404(db, project_id, user.id)

    # Validate config once
    if data.config:
        errors = validate_metric_config(data.metric_type, data.config)
        if errors:
            raise HTTPException(status_code=400, detail="; ".join(errors))

    # Validate decompose constraints
    if data.decompose and data.metric_type == "domain_aggregate":
        raise HTTPException(
            status_code=400,
            detail="Cannot decompose domain aggregate metrics",
        )

    # Validate grouping columns belong to project
    if data.grouping_column_id is not None:
        _validate_column_in_project(db, data.grouping_column_id, project_id)
    if data.grouping_column_id_2 is not None:
        _validate_column_in_project(db, data.grouping_column_id_2, project_id)

    # Phase A: lazy GC + find or create (single transaction)
    cleanup_auto_metrics(db, project_id)

    # Expand sources: when decompose=True, domain sources become N sub-sources
    expanded: list[tuple[str, int, dict]] = []  # (source_type, source_id, config)
    for src in data.sources:
        source_err = _check_source_exists(db, project_id, src.source_type, src.source_id)
        if source_err:
            raise HTTPException(status_code=400, detail=source_err)

        # #350 pre-check per source (no-op for non-domain sources). Raises
        # structured HTTPException(400) `non_numeric_domain` on violation;
        # quickCompute aborts the whole batch on first error to match the
        # existing per-source error handling below.
        _validate_domain_aggregate_numeric(
            db, data.metric_type, src.source_type, src.source_id,
        )

        gm_errors = _validate_grouping_mode(
            data.grouping_mode, src.source_type,
            data.metric_type, data.grouping_column_id,
            data.grouping_column_id_2,
        )
        if gm_errors:
            raise HTTPException(status_code=400, detail="; ".join(gm_errors))

        if data.decompose and src.source_type == "dataset_domain":
            sub_sources = decompose_domain_sources(db, src.source_id)
            for sub in sub_sources:
                merged_config = {
                    **data.config,
                    "decompose_column_ids": sorted(sub.column_ids),
                    "decompose_label": sub.label,
                }
                expanded.append((src.source_type, src.source_id, merged_config))
        else:
            expanded.append((src.source_type, src.source_id, data.config))

    pairs: list[tuple] = []  # (metric, is_new)
    for source_type, source_id, config in expanded:
        metric, is_new = find_or_create_metric(
            db, project_id,
            source_type=source_type,
            source_id=source_id,
            metric_type=data.metric_type,
            config=config,
            grouping_column_id=data.grouping_column_id,
            grouping_column_id_2=data.grouping_column_id_2,
            exclude_values=data.exclude_values,
            grouping_mode=data.grouping_mode,
        )
        pairs.append((metric, is_new))

    db.commit()

    # Phase B: compute stale / empty metrics (per-metric commits)
    computed_count = 0
    reused_count = 0

    for metric, is_new in pairs:
        db.refresh(metric)
        needs_compute = metric.stale or len(metric.results) == 0
        if needs_compute:
            try:
                compute_metric(db, metric)
                db.commit()
                computed_count += 1
            except Exception as exc:
                db.rollback()
                logger.warning("Failed to compute metric %d: %s", metric.id, exc)
        else:
            reused_count += 1

    # Build responses
    all_metrics = [m for m, _ in pairs]
    label_map = resolve_input_source_labels(db, all_metrics)
    responses = [_build_metric_response(m, db, label_map) for m in all_metrics]

    return QuickComputeResponse(
        metrics=responses,
        computed_count=computed_count,
        reused_count=reused_count,
    )


@router.get("/analysis-columns", response_model=AnalysisColumnsResponse)
async def get_analysis_columns(
    project_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Return all project columns grouped by dataset, plus domains and demographics.

    This is the data source for the ColumnPicker component.
    """
    from ..models.dataset import Dataset, DatasetColumn
    from ..models.analysis_domain import AnalysisDomain, AnalysisDomainMember

    _get_project_or_404(db, project_id, user.id)

    # Load all columns with dataset info
    columns = (
        db.query(DatasetColumn, Dataset.name, Dataset.id)
        .join(Dataset)
        .filter(Dataset.project_id == project_id)
        .order_by(Dataset.id, DatasetColumn.display_order, DatasetColumn.id)
        .all()
    )

    # Build domain membership reverse map: column_id -> [domain_id, ...]
    domain_members = (
        db.query(AnalysisDomainMember)
        .join(AnalysisDomain)
        .filter(AnalysisDomain.project_id == project_id)
        .all()
    )

    # Map equiv_group_id -> [column_id, ...]
    equiv_columns: dict[int, list[int]] = {}
    for col, _, _ in columns:
        if col.equivalence_group_id:
            equiv_columns.setdefault(col.equivalence_group_id, []).append(col.id)

    # Build column_id -> domain_ids mapping
    col_domain_map: dict[int, list[int]] = {}
    for dm in domain_members:
        if dm.member_type == "column":
            col_domain_map.setdefault(dm.member_id, []).append(dm.domain_id)

    # Group by dataset, separating columns and demographics
    datasets_map: dict[int, dict] = {}
    demographics: list[AnalysisDemographicItem] = []

    for col, ds_name, ds_id in columns:
        col_type = col.column_type.value if col.column_type else ""

        if col_type in ("skip", "open_text"):
            continue

        if col_type == "demographic":
            demographics.append(AnalysisDemographicItem(
                id=col.id,
                column_name=col.column_name,
                column_text=col.column_text or "",
                dataset_id=ds_id,
                dataset_name=ds_name,
                subtype=col.demographic_subtype,
            ))
            continue

        # Group-by candidates: nominal columns ARE valid grouping/cross-tab
        # partners (#371) — the compute path buckets by value_text, so a chart
        # can be split by e.g. Department the same way it splits by Gender. Add
        # nominal to the group-by list (named `demographics` for API stability)
        # but do NOT `continue` — nominal stays in the selectable per-dataset
        # columns below so it remains a valid metric input (frequency).
        if col_type == "nominal":
            demographics.append(AnalysisDemographicItem(
                id=col.id,
                column_name=col.column_name,
                column_text=col.column_text or "",
                dataset_id=ds_id,
                dataset_name=ds_name,
                subtype=col.demographic_subtype,
            ))

        # Parse scale_labels
        scale_labels = None
        if col.scale_labels:
            try:
                scale_labels = json.loads(col.scale_labels) if isinstance(col.scale_labels, str) else col.scale_labels
            except (json.JSONDecodeError, TypeError):
                pass

        column = AnalysisColumnItem(
            id=col.id,
            dataset_id=ds_id,
            dataset_name=ds_name,
            column_code=col.column_code,
            column_name=col.column_name,
            column_text=col.column_text or "",
            column_type=col_type,
            scale_labels=scale_labels,
            equivalence_group_id=col.equivalence_group_id,
            domain_ids=col_domain_map.get(col.id, []),
        )

        if ds_id not in datasets_map:
            datasets_map[ds_id] = {"id": ds_id, "name": ds_name, "columns": []}
        datasets_map[ds_id]["columns"].append(column)

    dataset_groups = [
        AnalysisDatasetGroup(**ds_data)
        for ds_data in datasets_map.values()
    ]

    # Load domains with member counts and dataset names
    domains = (
        db.query(AnalysisDomain)
        .filter(AnalysisDomain.project_id == project_id)
        .order_by(AnalysisDomain.sequence_order, AnalysisDomain.id)
        .all()
    )

    # Batch-load ALL domain members for the project in one query, group by domain_id
    all_domain_members = (
        db.query(AnalysisDomainMember)
        .filter(AnalysisDomainMember.domain_id.in_([d.id for d in domains]))
        .all()
    ) if domains else []

    members_by_domain: dict[int, list] = {}
    for m in all_domain_members:
        members_by_domain.setdefault(m.domain_id, []).append(m)

    # Pre-build col_id -> ds_name map for O(1) lookups
    col_ds_name: dict[int, str] = {}
    for col, ds_name, ds_id in columns:
        col_ds_name[col.id] = ds_name

    domain_items: list[AnalysisDomainItem] = []
    for domain in domains:
        members = members_by_domain.get(domain.id, [])

        # Collect dataset names for this domain
        member_col_ids: set[int] = set()
        for m in members:
            if m.member_type == "column":
                member_col_ids.add(m.member_id)

        ds_names = {col_ds_name[cid] for cid in member_col_ids if cid in col_ds_name}

        domain_items.append(AnalysisDomainItem(
            id=domain.id,
            name=domain.name,
            member_count=len(members),
            datasets=sorted(ds_names),
        ))

    return AnalysisColumnsResponse(
        datasets=dataset_groups,
        domains=domain_items,
        demographics=demographics,
    )


@router.post("/cross-tabulation", response_model=CrossTabResponse)
async def cross_tabulation(
    project_id: int,
    data: CrossTabRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Cross-tabulate two columns from the same dataset."""
    from ..services.cross_tabulation import compute_cross_tabulation

    _get_project_or_404(db, project_id, user.id)

    try:
        result = compute_cross_tabulation(
            db, project_id,
            row_column_id=data.row_column_id,
            col_column_id=data.col_column_id,
            include_chi_square=data.include_chi_square,
        )
    except ValueError as e:
        detail = str(e)
        status = 404 if "not found" in detail else 400
        raise HTTPException(status_code=status, detail=detail)

    chi_result = None
    if result["chi_square"]:
        chi_result = ChiSquareResult(**result["chi_square"])

    matrix = [
        [CrossTabCell(**cell) for cell in row]
        for row in result["matrix"]
    ]

    return CrossTabResponse(
        row_values=result["row_values"],
        col_values=result["col_values"],
        matrix=matrix,
        row_totals=result["row_totals"],
        col_totals=result["col_totals"],
        n_shared=result["n_shared"],
        row_column_label=result["row_column_label"],
        col_column_label=result["col_column_label"],
        chi_square=chi_result,
    )


@router.get("/row-matrix", response_model=RowMatrixResponse)
async def get_row_matrix(
    project_id: int,
    metric_ids: str | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Export record × variable matrix.

    Returns a pivot table of row scores across metrics.
    metric_ids: comma-separated list of metric IDs (omit for all with scores).
    """
    from ..models.row_score import RowScore
    from ..models.dataset import Dataset, DatasetRow

    _get_project_or_404(db, project_id, user.id)

    # Load target metrics
    if metric_ids:
        try:
            ids = [int(x.strip()) for x in metric_ids.split(",") if x.strip()]
        except ValueError:
            raise HTTPException(status_code=400, detail="metric_ids must be comma-separated integers")
        metrics = (
            db.query(MetricDefinition)
            .filter(
                MetricDefinition.id.in_(ids),
                MetricDefinition.project_id == project_id,
            )
            .order_by(MetricDefinition.sequence_order)
            .all()
        )
        if len(metrics) != len(ids):
            found = {m.id for m in metrics}
            missing = [i for i in ids if i not in found]
            raise HTTPException(status_code=404, detail=f"Metrics not found: {missing}")
    else:
        # All metrics with scores
        metric_with_scores = (
            db.query(RowScore.metric_definition_id)
            .distinct()
            .subquery()
        )
        metrics = (
            db.query(MetricDefinition)
            .filter(
                MetricDefinition.project_id == project_id,
                MetricDefinition.id.in_(
                    db.query(metric_with_scores.c.metric_definition_id)
                ),
            )
            .order_by(MetricDefinition.sequence_order)
            .all()
        )

    if not metrics:
        return RowMatrixResponse(columns=[], rows=[])

    # Resolve labels
    label_map = resolve_input_source_labels(db, metrics)
    columns = []
    metric_id_list = []
    for m in metrics:
        config = _parse_json(m.config) or {}
        decompose_label = config.get("decompose_label")
        label = decompose_label or label_map.get(
            (m.input_source_type, m.input_source_id), m.name
        )
        columns.append(MatrixColumnInfo(
            metric_id=m.id,
            label=label,
            metric_type=m.metric_type,
        ))
        metric_id_list.append(m.id)

    # Load all scores in one query
    all_scores = (
        db.query(RowScore)
        .filter(RowScore.metric_definition_id.in_(metric_id_list))
        .all()
    )

    # Pivot: row_id -> {metric_id: score}
    pivot: dict[int, dict[int, float | None]] = {}
    all_row_ids: set[int] = set()
    for s in all_scores:
        pivot.setdefault(s.dataset_row_id, {})[s.metric_definition_id] = s.score
        all_row_ids.add(s.dataset_row_id)

    if not all_row_ids:
        return RowMatrixResponse(columns=columns, rows=[])

    # Load row metadata
    row_meta = (
        db.query(DatasetRow.id, DatasetRow.row_identifier, Dataset.name)
        .join(Dataset, DatasetRow.dataset_id == Dataset.id)
        .filter(DatasetRow.id.in_(all_row_ids))
        .all()
    )
    meta_map = {r_id: (resp_id, ds_name) for r_id, resp_id, ds_name in row_meta}

    rows = []
    for row_id in sorted(all_row_ids):
        resp_id, ds_name = meta_map.get(row_id, (None, None))
        scores_dict = {
            str(mid): pivot.get(row_id, {}).get(mid)
            for mid in metric_id_list
        }
        rows.append(MatrixRowItem(
            dataset_row_id=row_id,
            row_identifier=resp_id,
            dataset_name=ds_name,
            scores=scores_dict,
        ))

    return RowMatrixResponse(columns=columns, rows=rows)


@router.get("/row-matrix/csv")
async def get_row_matrix_csv(
    project_id: int,
    metric_ids: str | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Export record × variable matrix as CSV download."""
    from fastapi.responses import StreamingResponse
    import csv
    import io

    # Reuse JSON endpoint logic
    matrix = await get_row_matrix(project_id, metric_ids, user, db)

    output = io.StringIO()
    writer = csv.writer(output)

    # Header row — col.label originates from user-typed metric/column names.
    header = ["row_id", "dataset"]
    for col in matrix.columns:
        header.append(csv_safe(col.label))
    writer.writerow(header)

    # Data rows
    for row in matrix.rows:
        csv_row = [csv_safe(row.row_identifier or ""), csv_safe(row.dataset_name or "")]
        for col in matrix.columns:
            score = row.scores.get(str(col.metric_id))
            csv_row.append(str(score) if score is not None else "")
        writer.writerow(csv_row)

    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={
            "Content-Disposition": 'attachment; filename="row_matrix.csv"',
        },
    )


# ── Single metric endpoints (AFTER fixed-string paths) ───────────────────────


@router.get("/{metric_id}", response_model=MetricDefinitionResponse)
async def get_metric(
    project_id: int,
    metric_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get a metric definition with full results."""
    _get_project_or_404(db, project_id, user.id)
    metric = _get_metric_or_404(db, project_id, metric_id)
    return _build_metric_response(metric, db)


@router.patch("/{metric_id}", response_model=MetricDefinitionResponse)
async def update_metric(
    project_id: int,
    metric_id: int,
    data: MetricDefinitionUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Update a metric definition. Marks stale if config/input fields changed."""
    _get_project_or_404(db, project_id, user.id)
    metric = _get_metric_or_404(db, project_id, metric_id)

    # Track fields that affect computation for staleness
    stale_fields = {"metric_type", "config", "input_source_type", "input_source_id",
                    "grouping_column_id", "grouping_column_id_2", "grouping_mode", "exclude_values"}
    mark_stale = False

    update_data = data.model_dump(exclude_unset=True)
    for field_name, value in update_data.items():
        if field_name in stale_fields:
            mark_stale = True

        if field_name == "config" and value is not None:
            # Validate new config
            metric_type = data.metric_type or metric.metric_type
            errors = validate_metric_config(metric_type, value)
            if errors:
                raise HTTPException(status_code=400, detail="; ".join(errors))
            metric.config = json.dumps(value)
        elif field_name == "exclude_values":
            metric.exclude_values = json.dumps(value) if value else None
        elif field_name == "input_source_type" and value is not None:
            source_err = _check_source_exists(
                db, project_id, value, data.input_source_id or metric.input_source_id,
            )
            if source_err:
                raise HTTPException(status_code=400, detail=source_err)
            metric.input_source_type = value
        elif field_name == "input_source_id" and value is not None:
            source_err = _check_source_exists(
                db, project_id,
                data.input_source_type or metric.input_source_type, value,
            )
            if source_err:
                raise HTTPException(status_code=400, detail=source_err)
            metric.input_source_id = value
        else:
            setattr(metric, field_name, value)

    if mark_stale:
        metric.stale = True

    # Validate grouping_mode constraints on the resulting metric state
    gm_errors = _validate_grouping_mode(
        metric.grouping_mode, metric.input_source_type,
        metric.metric_type, metric.grouping_column_id,
        metric.grouping_column_id_2,
    )
    if gm_errors:
        raise HTTPException(status_code=400, detail="; ".join(gm_errors))

    log_action(
        db,
        action="updated",
        entity_type="metric_definition",
        entity_id=metric.id,
        user_id=user.id,
        project_id=project_id,
        details={"name": metric.name},
    )
    db.commit()
    db.refresh(metric)

    return _build_metric_response(metric, db)


@router.delete("/{metric_id}")
async def delete_metric(
    project_id: int,
    metric_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Delete a metric definition. Results are cascade-deleted."""
    _get_project_or_404(db, project_id, user.id)
    metric = _get_metric_or_404(db, project_id, metric_id)

    name = metric.name

    log_action(
        db,
        action="deleted",
        entity_type="metric_definition",
        entity_id=metric_id,
        user_id=user.id,
        project_id=project_id,
        details={"name": name},
    )

    # Orphan cleanup: delete statistical tests targeting this metric
    from ..models.statistical_test import StatisticalTest
    db.query(StatisticalTest).filter(
        StatisticalTest.target_type == "metric_definition",
        StatisticalTest.target_id == metric_id,
    ).delete(synchronize_session="fetch")

    db.delete(metric)
    db.commit()

    return {"status": "ok", "deleted_id": metric_id}


@router.post("/{metric_id}/compute", response_model=list[ComputedResultResponse])
async def compute_single_metric(
    project_id: int,
    metric_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Compute (or recompute) a single metric."""
    _get_project_or_404(db, project_id, user.id)
    metric = _get_metric_or_404(db, project_id, metric_id)

    try:
        results = compute_metric(db, metric)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Mark statistical tests targeting this metric as stale (data has changed)
    from ..models.statistical_test import StatisticalTest
    db.query(StatisticalTest).filter(
        StatisticalTest.target_type == "metric_definition",
        StatisticalTest.target_id == metric_id,
        StatisticalTest.stale == False,  # noqa: E712
    ).update({"stale": True}, synchronize_session="fetch")

    log_action(
        db,
        action="computed",
        entity_type="metric_definition",
        entity_id=metric.id,
        user_id=user.id,
        project_id=project_id,
        details={"name": metric.name, "result_count": len(results)},
    )
    db.commit()

    return [
        ComputedResultResponse(
            id=r.id,
            group_value=r.group_value,
            result_data=_parse_json(r.result_data) or {},
            valid_n=r.valid_n,
            total_n=r.total_n,
            computed_at=r.computed_at,
        )
        for r in results
    ]


@router.get("/{metric_id}/results", response_model=list[ComputedResultResponse])
async def get_metric_results(
    project_id: int,
    metric_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get computed results for a metric."""
    _get_project_or_404(db, project_id, user.id)
    metric = _get_metric_or_404(db, project_id, metric_id)

    return [
        ComputedResultResponse(
            id=r.id,
            group_value=r.group_value,
            result_data=_parse_json(r.result_data) or {},
            valid_n=r.valid_n,
            total_n=r.total_n,
            computed_at=r.computed_at,
        )
        for r in metric.results
    ]


@router.get("/{metric_id}/row-scores", response_model=RowScoresResponse)
async def get_row_scores(
    project_id: int,
    metric_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get per-row scores for a metric."""
    from ..models.row_score import RowScore
    from ..models.dataset import DatasetRow

    _get_project_or_404(db, project_id, user.id)
    metric = _get_metric_or_404(db, project_id, metric_id)

    scores = (
        db.query(RowScore, DatasetRow.row_identifier)
        .join(DatasetRow, RowScore.dataset_row_id == DatasetRow.id)
        .filter(RowScore.metric_definition_id == metric_id)
        .order_by(DatasetRow.row_identifier, DatasetRow.id)
        .all()
    )

    return RowScoresResponse(
        metric_id=metric.id,
        metric_name=metric.name,
        scores=[
            RowScoreItem(
                dataset_row_id=s.dataset_row_id,
                row_identifier=resp_id,
                score=s.score,
            )
            for s, resp_id in scores
        ],
    )
