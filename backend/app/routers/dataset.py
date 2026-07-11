"""Dataset import and read endpoints."""

import csv
import io
import json
import logging
import re
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from sqlalchemy import case, func
from sqlalchemy.orm import Session, joinedload

from ..auth import get_current_user
from ..database import get_db
from ..models.user import User
from ..models.dataset import (
    ColumnType,
    Dataset,
    DatasetColumn,
    DatasetRow,
    DatasetValue,
)
from ..models.participant import Participant
from ..schemas.dataset import (
    DatasetPreviewResponse,
    DatasetColumnPreview,
    DatasetImportRequest,
    DatasetImportResponse,
    DatasetResponse,
    DatasetListResponse,
    DatasetUpdate,
    DatasetColumnResponse,
    DatasetRowSummary,
    DatasetValueResponse,
    DatasetRowDetail,
    DatasetValueCell,
    DatasetDataRow,
    DatasetDataResponse,
    DatasetDataColumnResponse,
    RecodeDefinitionSummary,
    LinkParticipantRequest,
    LinkParticipantResponse,
    BulkLinkRequest,
    BulkLinkResponse,
    BulkLinkResultItem,
    BulkLinkSkippedItem,
    ManualColumnCreate,
    ComputedColumnCreate,
    ComputedColumnUpdate,
    ManualColumnUpdate,
    ColumnHeaderUpdate,
    ValueUpdate,
    ValueCellResponse,
    ALLOWED_MANUAL_TYPES,
    AppendMatchedColumn,
    AppendUnmatchedCsvColumn,
    AppendUnmatchedColumn,
    AppendPreviewRow,
    AppendLinkColumnOffer,
    DatasetAppendPreviewResponse,
    DatasetAppendRequest,
    DatasetAppendResponse,
    ColumnReorderRequest,
    LinkByColumnRequest,
    ParticipantLinkReport,
)
from ..models.recode import RecodeDefinition, RecodeType
from ..services.dataset_import import (
    preview_dataset_csv,
    import_dataset_csv,
    parse_header,
    _is_na,
    _strip_bom,
    _compute_value_numeric,
    is_xlsx_upload,
    xlsx_to_csv_text,
    XlsxImportError,
)
from ..services.sav_import import (
    apply_sav_metadata,
    is_sav_upload,
    sav_to_csv_text,
    SavColumnMeta,
    SavImportError,
)
from ..models.equivalence_group import EquivalenceGroup
from ..schemas.equivalence import ProjectColumnInfo, ProjectColumnListResponse
from ..services.recode import (
    apply_definition_to_column,
    clear_value_numeric,
    compute_value,
)
from ..models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from ..models.metric import MetricDefinition
from ..models.row_score import RowScore
from ..models.statistical_test import StatisticalTest
from ..services.staleness import mark_metrics_stale
from ..services.equivalence_validators import assert_domains_intact_for_domain_ids
from ..services.computed_columns import (
    ExpressionError as ComputedExpressionError,
    parse as parse_expression,
    validate as validate_expression,
    to_r_expression,
    ColumnInfo,
    evaluate_computed_column,
)
from ..services.audit import log_action
from ..services.participant_linking import (
    auto_fill_role_from_linked_row,
    link_rows_by_identifier_column,
)

router = APIRouter(
    prefix="/api/projects/{project_id}/datasets",
    tags=["datasets"],
)


from .helpers import _get_project_or_404, _get_dataset_or_404, read_upload_with_limit, validate_encoding


def _safe_json_loads(text: str | None, fallback=None):
    """Parse JSON from a DB field, returning fallback on corruption."""
    if not text:
        return fallback
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        logger.warning("Corrupted JSON in DB field: %.80s", text)
        return fallback


def _column_to_response(q: DatasetColumn) -> DatasetColumnResponse:
    """Convert a DatasetColumn ORM object to response schema."""
    scale_labels = None
    if q.scale_labels:
        try:
            scale_labels = json.loads(q.scale_labels)
        except (json.JSONDecodeError, TypeError) as e:
            logger.warning("Failed to parse scale_labels JSON for column %s: %s", q.id, e)
            scale_labels = None

    eq_group = getattr(q, 'equivalence_group', None)
    return DatasetColumnResponse(
        id=q.id,
        column_code=q.column_code,
        column_name=q.column_name,
        group_code=q.group_code,
        group_label=q.group_label,
        column_text=q.column_text,
        column_type=q.column_type.value if hasattr(q.column_type, 'value') else q.column_type,
        sequence_order=q.sequence_order,
        display_order=q.display_order,
        scale_labels=scale_labels,
        scale_points=q.scale_points,
        numeric_min=q.numeric_min,
        numeric_max=q.numeric_max,
        numeric_format=q.numeric_format,
        source=q.source,
        expression=q.expression,
        depends_on_column_ids=_safe_json_loads(q.depends_on_column_ids) if q.depends_on_column_ids else None,
        stale=q.stale,
        demographic_subtype=q.demographic_subtype,
        equivalence_group_id=q.equivalence_group_id,
        equivalence_group_label=eq_group.label if eq_group else None,
        show_in_participant_profile=q.show_in_participant_profile,  # #353
    )


# ── Import endpoints ─────────────────────────────────────────────────────────


@router.post("/preview", response_model=DatasetPreviewResponse)
async def preview_dataset(
    project_id: int,
    file: UploadFile = File(...),
    encoding: str = Form("utf-8"),
    sheet_name: str | None = Form(None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Preview a dataset file (CSV, .xlsx #523, or SPSS .sav #28) before importing."""
    _get_project_or_404(db, project_id, user.id)
    validate_encoding(encoding)

    text, sheet_names, sav_meta = await _upload_to_csv_text(file, encoding, sheet_name)

    try:
        result = preview_dataset_csv(text)
    except (ValueError, csv.Error, TypeError) as e:
        logger.warning("CSV parse failed: %s", e)
        raise HTTPException(status_code=400, detail="Unable to parse CSV file. Check the file format and try again.")

    # #28: SPSS carries an authoritative ordinal order + scale codes that no amount
    # of inference over the CSV text can recover. Overlay it onto the suggestions;
    # the wizard still shows them to the user for confirmation.
    if sav_meta:
        apply_sav_metadata(result["columns"], sav_meta)

    return DatasetPreviewResponse(
        total_rows=result["total_rows"],
        columns=[DatasetColumnPreview(**col) for col in result["columns"]],
        sheet_names=sheet_names,
    )


@router.post("/import", response_model=DatasetImportResponse)
async def import_dataset(
    project_id: int,
    file: UploadFile = File(...),
    import_config: str = Form(...),
    encoding: str = Form("utf-8"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Import a dataset CSV with confirmed column configs."""
    _get_project_or_404(db, project_id, user.id)
    validate_encoding(encoding)

    # Parse import config
    try:
        config = DatasetImportRequest.model_validate(json.loads(import_config))
    except (json.JSONDecodeError, ValueError) as e:
        raise HTTPException(
            status_code=400, detail=f"Invalid import config: {e}",
        )

    text, _sheet_names, _sav_meta = await _upload_to_csv_text(file, encoding, config.sheet_name)

    # Convert Pydantic models to dicts for the service
    column_configs = [cfg.model_dump() for cfg in config.column_configs]

    try:
        result = import_dataset_csv(
            db=db,
            project_id=project_id,
            name=config.name,
            column_configs=column_configs,
            file_contents=text,
            description=config.description,
            source=config.source,
            participant_link_column_index=config.participant_link_column_index,
        )
    except (ValueError, csv.Error, TypeError, KeyError) as e:
        db.rollback()
        logger.warning("Dataset import failed: %s", e)
        raise HTTPException(status_code=400, detail="Import failed. Check the file format and column configuration.")

    log_action(
        db,
        action="imported",
        entity_type="dataset",
        entity_id=result["dataset_id"],
        user_id=user.id,
        project_id=project_id,
        details={
            "name": config.name,
            "columns_created": result["columns_created"],
            "rows_created": result["rows_created"],
            "values_created": result["values_created"],
            # #414: record what linking did when it ran
            **(
                {
                    "participants_linked": result["participant_link_report"]["linked"],
                    "participants_created": result["participant_link_report"]["created"],
                }
                if result.get("participant_link_report")
                else {}
            ),
        },
    )
    # Service flushed; commit import data + audit log together
    db.commit()

    return DatasetImportResponse(**result)


# ── Read endpoints ───────────────────────────────────────────────────────────


@router.get("/", response_model=DatasetListResponse)
async def list_datasets(
    project_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """List datasets for a project with column and row counts."""
    _get_project_or_404(db, project_id, user.id)

    datasets = (
        db.query(Dataset)
        .filter(Dataset.project_id == project_id)
        .order_by(Dataset.created_at.desc())
        .all()
    )

    if not datasets:
        return DatasetListResponse(datasets=[], total=0)

    dataset_ids = [d.id for d in datasets]

    # Batch COUNT queries — column counts + open-ended in one pass
    col_stats = (
        db.query(
            DatasetColumn.dataset_id,
            func.count(DatasetColumn.id),
            func.count(case(
                (DatasetColumn.column_type.in_([ColumnType.OPEN_TEXT.value]), DatasetColumn.id),
                else_=None,
            )),
        )
        .filter(DatasetColumn.dataset_id.in_(dataset_ids))
        .group_by(DatasetColumn.dataset_id)
        .all()
    )
    column_counts = {r[0]: r[1] for r in col_stats}
    open_ended_counts = {r[0]: r[2] for r in col_stats}
    row_counts = dict(
        db.query(DatasetRow.dataset_id, func.count(DatasetRow.id))
        .filter(DatasetRow.dataset_id.in_(dataset_ids))
        .group_by(DatasetRow.dataset_id)
        .all()
    )

    items = [
        DatasetResponse(
            id=ds.id,
            name=ds.name,
            description=ds.description,
            source=ds.source,
            color=ds.color,
            created_at=ds.created_at,
            column_count=column_counts.get(ds.id, 0),
            row_count=row_counts.get(ds.id, 0),
            open_ended_count=open_ended_counts.get(ds.id, 0),
        )
        for ds in datasets
    ]

    return DatasetListResponse(datasets=items, total=len(items))


@router.get("/columns", response_model=ProjectColumnListResponse)
async def list_all_columns(
    project_id: int,
    ungrouped: bool = False,
    dataset_id: int | None = None,
    search: str | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """List all columns across all datasets in a project."""
    _get_project_or_404(db, project_id, user.id)

    query = (
        db.query(DatasetColumn)
        .join(Dataset)
        .options(
            joinedload(DatasetColumn.dataset),
            joinedload(DatasetColumn.equivalence_group),
            joinedload(DatasetColumn.recode_definitions),
        )
        .filter(Dataset.project_id == project_id)
    )

    # Exclude skip type
    query = query.filter(DatasetColumn.column_type != ColumnType.SKIP)

    if ungrouped:
        query = query.filter(DatasetColumn.equivalence_group_id.is_(None))

    if dataset_id is not None:
        query = query.filter(DatasetColumn.dataset_id == dataset_id)

    if search:
        search_term = f"%{search}%"
        query = query.filter(
            (DatasetColumn.column_text.ilike(search_term)) |
            (DatasetColumn.column_code.ilike(search_term))
        )

    columns = query.order_by(
        Dataset.name,
        DatasetColumn.sequence_order,
    ).all()

    items = []
    for q in columns:
        qtype = q.column_type.value
        if qtype == "skip":
            continue
        # Phase 4.5: enrich with scale_labels (for mismatch v2 detection) and
        # recode_def_count (for the TypePickerPopover pre-flight gate).
        scale_labels_parsed: list[str] | None = None
        if q.scale_labels:
            try:
                parsed = json.loads(q.scale_labels) if isinstance(q.scale_labels, str) else q.scale_labels
                if isinstance(parsed, list):
                    scale_labels_parsed = [str(x) for x in parsed]
            except (ValueError, TypeError):
                scale_labels_parsed = None
        items.append(ProjectColumnInfo(
            id=q.id,
            dataset_id=q.dataset_id,
            dataset_name=q.dataset.name,
            dataset_color=q.dataset.color,
            column_code=q.column_code,
            column_name=q.column_name,
            column_text=q.column_text,
            column_type=qtype,
            scale_points=q.scale_points,
            scale_labels=scale_labels_parsed,
            recode_def_count=len(q.recode_definitions or []),
            equivalence_group_id=q.equivalence_group_id,
            equivalence_group_label=q.equivalence_group.label if q.equivalence_group else None,
        ))

    return ProjectColumnListResponse(columns=items, total=len(items))


@router.get(
    "/{dataset_id}",
    response_model=DatasetResponse,
)
async def get_dataset(
    project_id: int,
    dataset_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get a single dataset with column and row counts."""
    ds = _get_dataset_or_404(db, project_id, dataset_id, user.id)

    col_count = (
        db.query(func.count(DatasetColumn.id))
        .filter(DatasetColumn.dataset_id == dataset_id)
        .scalar()
    )
    row_count = (
        db.query(func.count(DatasetRow.id))
        .filter(DatasetRow.dataset_id == dataset_id)
        .scalar()
    )

    return DatasetResponse(
        id=ds.id,
        name=ds.name,
        description=ds.description,
        source=ds.source,
        color=ds.color,
        created_at=ds.created_at,
        column_count=col_count,
        row_count=row_count,
    )


@router.patch("/{dataset_id}")
async def update_dataset(
    project_id: int,
    dataset_id: int,
    data: DatasetUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Update dataset name and/or description."""
    ds = _get_dataset_or_404(db, project_id, dataset_id, user.id)

    for field in data.model_fields_set:
        setattr(ds, field, getattr(data, field))

    db.commit()
    db.refresh(ds)

    log_action(
        db,
        action="dataset_updated",
        entity_type="dataset",
        entity_id=ds.id,
        user_id=user.id,
        project_id=project_id,
    )

    col_count = (
        db.query(func.count(DatasetColumn.id))
        .filter(DatasetColumn.dataset_id == dataset_id)
        .scalar()
    )
    row_count = (
        db.query(func.count(DatasetRow.id))
        .filter(DatasetRow.dataset_id == dataset_id)
        .scalar()
    )

    return DatasetResponse(
        id=ds.id,
        name=ds.name,
        description=ds.description,
        source=ds.source,
        color=ds.color,
        created_at=ds.created_at,
        column_count=col_count,
        row_count=row_count,
    )


@router.delete("/{dataset_id}")
async def delete_dataset(
    project_id: int,
    dataset_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Delete an entire dataset and all its columns, rows, and values."""
    dataset = _get_dataset_or_404(db, project_id, dataset_id, user.id)

    # Unlink any equivalence group references before deletion
    db.query(DatasetColumn).filter(
        DatasetColumn.dataset_id == dataset_id,
        DatasetColumn.equivalence_group_id.isnot(None),
    ).update({DatasetColumn.equivalence_group_id: None}, synchronize_session="fetch")

    # Clean up analysis domain memberships referencing this dataset's columns
    column_ids = [
        r[0] for r in
        db.query(DatasetColumn.id)
        .filter(DatasetColumn.dataset_id == dataset_id)
        .all()
    ]

    # #298 cascade subset: capture domain IDs that contain any of these columns
    # BEFORE the cleanup deletes the AnalysisDomainMember rows. After cleanup,
    # the column-driven validator can't find these domains (zero member rows
    # match), so we drive validation by the captured domain IDs.
    affected_domain_ids: list[int] = []
    if column_ids:
        affected_domain_ids = [
            r[0] for r in
            db.query(AnalysisDomainMember.domain_id)
            .filter(
                AnalysisDomainMember.member_type == "column",
                AnalysisDomainMember.member_id.in_(column_ids),
            )
            .distinct()
            .all()
        ]

    if column_ids:
        db.query(AnalysisDomainMember).filter(
            AnalysisDomainMember.member_type == "column",
            AnalysisDomainMember.member_id.in_(column_ids),
        ).delete(synchronize_session="fetch")

        # Orphan cleanup: delete statistical tests targeting metrics about to be deleted
        col_metric_ids = [
            r[0] for r in db.query(MetricDefinition.id).filter(
                MetricDefinition.input_source_type == "dataset_column",
                MetricDefinition.input_source_id.in_(column_ids),
            ).all()
        ]
        if col_metric_ids:
            db.query(StatisticalTest).filter(
                StatisticalTest.target_type == "metric_definition",
                StatisticalTest.target_id.in_(col_metric_ids),
            ).delete(synchronize_session="fetch")

        # Clean up metric definitions referencing this dataset's columns
        db.query(MetricDefinition).filter(
            MetricDefinition.input_source_type == "dataset_column",
            MetricDefinition.input_source_id.in_(column_ids),
        ).delete(synchronize_session="fetch")

    # Delete equivalence groups that now have 0 linked columns
    empty_group_ids = [
        g.id for g in
        db.query(EquivalenceGroup)
        .outerjoin(DatasetColumn, DatasetColumn.equivalence_group_id == EquivalenceGroup.id)
        .filter(EquivalenceGroup.project_id == project_id)
        .group_by(EquivalenceGroup.id)
        .having(func.count(DatasetColumn.id) == 0)
        .all()
    ]
    if empty_group_ids:
        db.query(EquivalenceGroup).filter(
            EquivalenceGroup.id.in_(empty_group_ids),
        ).delete(synchronize_session="fetch")

    # #298 cascade subset: validate that surviving cross-dataset domains are
    # still I2-paired now that this dataset's columns + their EG links are gone.
    # Empty domains are skipped by the helper — the empty-domain cleanup below
    # handles them. Failure raises 409 cross_dataset_unpaired and rolls back.
    db.flush()
    assert_domains_intact_for_domain_ids(db, affected_domain_ids)

    # Delete analysis domains that now have 0 members
    empty_domain_ids = [
        d.id for d in
        db.query(AnalysisDomain)
        .outerjoin(AnalysisDomainMember)
        .filter(AnalysisDomain.project_id == project_id)
        .group_by(AnalysisDomain.id)
        .having(func.count(AnalysisDomainMember.id) == 0)
        .all()
    ]
    if empty_domain_ids:
        # Orphan cleanup: delete statistical tests targeting these domains
        db.query(StatisticalTest).filter(
            StatisticalTest.target_type == "analysis_domain",
            StatisticalTest.target_id.in_(empty_domain_ids),
        ).delete(synchronize_session="fetch")

        # Orphan cleanup: delete statistical tests targeting domain metrics about to be deleted
        domain_metric_ids = [
            r[0] for r in db.query(MetricDefinition.id).filter(
                MetricDefinition.input_source_type == "dataset_domain",
                MetricDefinition.input_source_id.in_(empty_domain_ids),
            ).all()
        ]
        if domain_metric_ids:
            db.query(StatisticalTest).filter(
                StatisticalTest.target_type == "metric_definition",
                StatisticalTest.target_id.in_(domain_metric_ids),
            ).delete(synchronize_session="fetch")

        # Clean up metrics referencing these domains
        db.query(MetricDefinition).filter(
            MetricDefinition.input_source_type == "dataset_domain",
            MetricDefinition.input_source_id.in_(empty_domain_ids),
        ).delete(synchronize_session="fetch")
        db.query(AnalysisDomain).filter(
            AnalysisDomain.id.in_(empty_domain_ids),
        ).delete(synchronize_session="fetch")

    log_action(
        db,
        action="deleted",
        entity_type="dataset",
        entity_id=dataset.id,
        user_id=user.id,
        project_id=project_id,
        details={"name": dataset.name},
    )

    db.delete(dataset)
    db.commit()
    return {"ok": True}


@router.delete("/{dataset_id}/rows/{row_id}")
async def delete_row(
    project_id: int,
    dataset_id: int,
    row_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Delete a single dataset row (case) and all its values."""
    _get_dataset_or_404(db, project_id, dataset_id, user.id)
    row = (
        db.query(DatasetRow)
        .filter(
            DatasetRow.id == row_id,
            DatasetRow.dataset_id == dataset_id,
        )
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Row not found")

    # Get all column IDs for the dataset before deleting
    col_ids = [
        c[0] for c in db.query(DatasetColumn.id)
        .filter(DatasetColumn.dataset_id == dataset_id)
        .all()
    ]

    db.delete(row)
    db.flush()

    if col_ids:
        mark_metrics_stale(db, project_id, column_ids=col_ids)

    log_action(
        db,
        action="deleted",
        entity_type="dataset_row",
        entity_id=row.id,
        user_id=user.id,
        project_id=project_id,
        details={"record": row.row_identifier},
    )
    db.commit()
    return {"ok": True}


@router.get(
    "/{dataset_id}/columns",
    response_model=list[DatasetColumnResponse],
)
async def list_columns(
    project_id: int,
    dataset_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """List columns for a dataset, ordered by sequence."""
    _get_dataset_or_404(db, project_id, dataset_id, user.id)

    columns = (
        db.query(DatasetColumn)
        .options(joinedload(DatasetColumn.equivalence_group))
        .filter(DatasetColumn.dataset_id == dataset_id)
        .order_by(DatasetColumn.sequence_order)
        .all()
    )

    return [_column_to_response(q) for q in columns]


@router.get(
    "/{dataset_id}/rows",
    response_model=list[DatasetRowSummary],
)
async def list_rows(
    project_id: int,
    dataset_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """List rows for a dataset with value counts."""
    _get_dataset_or_404(db, project_id, dataset_id, user.id)

    rows = (
        db.query(DatasetRow)
        .filter(DatasetRow.dataset_id == dataset_id)
        .order_by(DatasetRow.id)
        .all()
    )

    if not rows:
        return []

    row_ids = [r.id for r in rows]

    # Batch value counts
    value_counts = dict(
        db.query(DatasetValue.row_id, func.count(DatasetValue.id))
        .filter(DatasetValue.row_id.in_(row_ids))
        .group_by(DatasetValue.row_id)
        .all()
    )

    return [
        DatasetRowSummary(
            id=r.id,
            participant_id=r.participant_id,
            row_identifier=r.row_identifier,
            submitted_at=r.submitted_at,
            value_count=value_counts.get(r.id, 0),
        )
        for r in rows
    ]


@router.get(
    "/{dataset_id}/rows/{row_id}",
    response_model=DatasetRowDetail,
)
async def get_row(
    project_id: int,
    dataset_id: int,
    row_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get a single row with all its values."""
    _get_dataset_or_404(db, project_id, dataset_id, user.id)

    row = (
        db.query(DatasetRow)
        .options(joinedload(DatasetRow.values))
        .filter(
            DatasetRow.id == row_id,
            DatasetRow.dataset_id == dataset_id,
        )
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Row not found")

    return DatasetRowDetail(
        id=row.id,
        participant_id=row.participant_id,
        row_identifier=row.row_identifier,
        submitted_at=row.submitted_at,
        values=[
            DatasetValueResponse(
                id=v.id,
                column_id=v.column_id,
                value_text=v.value_text,
                value_numeric=v.value_numeric,
            )
            for v in row.values
        ],
    )


@router.get(
    "/{dataset_id}/data",
    response_model=DatasetDataResponse,
)
async def get_dataset_data(
    project_id: int,
    dataset_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get full dataset data as a spreadsheet-like grid (columns as columns, rows as rows)."""
    ds = _get_dataset_or_404(db, project_id, dataset_id, user.id)

    # Columns ordered by sequence, with recode definitions and equivalence group eager-loaded
    columns = (
        db.query(DatasetColumn)
        .options(
            joinedload(DatasetColumn.recode_definitions),
            joinedload(DatasetColumn.equivalence_group),
        )
        .filter(DatasetColumn.dataset_id == dataset_id)
        .order_by(
            DatasetColumn.display_order.asc().nulls_last(),
            DatasetColumn.sequence_order,
        )
        .all()
    )

    # Rows with values and participant eagerly loaded
    rows = (
        db.query(DatasetRow)
        .options(
            joinedload(DatasetRow.values),
            joinedload(DatasetRow.participant),
        )
        .filter(DatasetRow.dataset_id == dataset_id)
        .order_by(DatasetRow.submitted_at.asc().nulls_last(), DatasetRow.id.asc())
        .all()
    )

    # Build dataset response with counts from loaded collections
    dataset_resp = DatasetResponse(
        id=ds.id,
        name=ds.name,
        description=ds.description,
        source=ds.source,
        color=ds.color,
        created_at=ds.created_at,
        column_count=len(columns),
        row_count=len(rows),
    )

    # Build data rows
    data_rows = []
    for row in rows:
        values_dict: dict[str, DatasetValueCell] = {}
        for val in row.values:
            values_dict[str(val.column_id)] = DatasetValueCell(
                id=val.id,
                value_text=val.value_text,
                value_numeric=val.value_numeric,
            )

        participant_name = None
        if row.participant:
            participant_name = row.participant.display_name or row.participant.identifier

        data_rows.append(DatasetDataRow(
            id=row.id,
            participant_id=row.participant_id,
            participant_display_name=participant_name,
            row_identifier=row.row_identifier,
            submitted_at=row.submitted_at,
            values=values_dict,
        ))

    # Build column responses with recode definitions
    data_columns = []
    for q in columns:
        base = _column_to_response(q)
        defs = []
        for d in q.recode_definitions:
            mapping = {}
            try:
                mapping = json.loads(d.mapping) if d.mapping else {}
            except (json.JSONDecodeError, TypeError) as e:
                logger.warning("Failed to parse mapping JSON for recode definition %s: %s", d.id, e)
            exclude_values = None
            try:
                if d.exclude_values:
                    exclude_values = json.loads(d.exclude_values)
            except (json.JSONDecodeError, TypeError) as e:
                logger.warning("Failed to parse exclude_values JSON for recode definition %s: %s", d.id, e)

            defs.append(RecodeDefinitionSummary(
                id=d.id,
                name=d.name,
                recode_type=d.recode_type.value if hasattr(d.recode_type, "value") else str(d.recode_type),
                output_type=d.output_type.value if hasattr(d.output_type, "value") else str(d.output_type),
                mapping=mapping,
                exclude_values=exclude_values,
                is_primary=bool(d.is_primary),
                is_auto_detected=bool(d.is_auto_detected),
                source_definition_id=d.source_definition_id,
            ))

        data_columns.append(DatasetDataColumnResponse(
            **base.model_dump(),
            recode_definitions=defs,
        ))

    return DatasetDataResponse(
        dataset=dataset_resp,
        columns=data_columns,
        rows=data_rows,
    )


# ── Participant linking endpoints ────────────────────────────────────────────


@router.patch(
    "/{dataset_id}/rows/{row_id}/link-participant",
    response_model=LinkParticipantResponse,
)
async def link_participant(
    project_id: int,
    dataset_id: int,
    row_id: int,
    req: LinkParticipantRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Link or unlink a dataset row to a participant."""
    _get_dataset_or_404(db, project_id, dataset_id, user.id)

    row = (
        db.query(DatasetRow)
        .filter(
            DatasetRow.id == row_id,
            DatasetRow.dataset_id == dataset_id,
        )
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Row not found")

    participant_name = None

    if req.participant_id is not None:
        # Verify participant belongs to same project
        participant = (
            db.query(Participant)
            .filter(
                Participant.id == req.participant_id,
                Participant.project_id == project_id,
            )
            .first()
        )
        if not participant:
            raise HTTPException(status_code=404, detail="Participant not found")

        # Check uniqueness: participant can only be linked once per dataset
        existing = (
            db.query(DatasetRow)
            .filter(
                DatasetRow.dataset_id == dataset_id,
                DatasetRow.participant_id == req.participant_id,
                DatasetRow.id != row_id,
            )
            .first()
        )
        if existing:
            existing_label = existing.row_identifier or f"Row #{existing.id}"
            p_name = participant.display_name or participant.identifier
            raise HTTPException(
                status_code=409,
                detail=f"{p_name} is already linked to {existing_label}",
            )

        participant_name = participant.display_name or participant.identifier

    row.participant_id = req.participant_id

    # Auto-fill role from linked row if applicable
    if req.participant_id is not None:
        auto_fill_role_from_linked_row(db, participant, row)

    db.flush()

    action = "linked_participant" if req.participant_id else "unlinked_participant"
    log_action(
        db,
        action=action,
        entity_type="dataset_row",
        entity_id=row_id,
        user_id=user.id,
        project_id=project_id,
        details={
            "dataset_id": dataset_id,
            "participant_id": req.participant_id,
        },
    )
    db.commit()

    return LinkParticipantResponse(
        row_id=row.id,
        participant_id=row.participant_id,
        participant_display_name=participant_name,
        row_identifier=row.row_identifier,
    )


@router.post(
    "/{dataset_id}/rows/bulk-link-participants",
    response_model=BulkLinkResponse,
)
async def bulk_link_participants(
    project_id: int,
    dataset_id: int,
    req: BulkLinkRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Bulk link/unlink dataset rows to participants."""
    _get_dataset_or_404(db, project_id, dataset_id, user.id)

    # Validate no duplicate row_ids
    row_ids = [item.row_id for item in req.links]
    if len(row_ids) != len(set(row_ids)):
        raise HTTPException(
            status_code=422, detail="Duplicate row_id values in request",
        )

    # Validate no duplicate non-null participant_ids
    participant_ids = [item.participant_id for item in req.links if item.participant_id is not None]
    if len(participant_ids) != len(set(participant_ids)):
        raise HTTPException(
            status_code=422, detail="Duplicate participant_id values in request",
        )

    # Batch-load rows for this dataset
    rows_map = {
        r.id: r
        for r in db.query(DatasetRow)
        .filter(
            DatasetRow.id.in_(row_ids),
            DatasetRow.dataset_id == dataset_id,
        )
        .all()
    }

    # Batch-load participants for this project
    all_participant_ids = [item.participant_id for item in req.links if item.participant_id is not None]
    participants_map = {}
    if all_participant_ids:
        participants_map = {
            p.id: p
            for p in db.query(Participant)
            .filter(
                Participant.id.in_(all_participant_ids),
                Participant.project_id == project_id,
            )
            .all()
        }

    # Build existing-links map: participant_id → row_identifier
    # for rows already linked on this dataset (excluding items in this batch)
    existing_links = {}
    existing = (
        db.query(DatasetRow)
        .filter(
            DatasetRow.dataset_id == dataset_id,
            DatasetRow.participant_id.isnot(None),
        )
        .all()
    )
    for r in existing:
        if r.id not in rows_map:
            existing_links[r.participant_id] = r.row_identifier or f"Row #{r.id}"

    linked: list[BulkLinkResultItem] = []
    unlinked: list[BulkLinkResultItem] = []
    skipped: list[BulkLinkSkippedItem] = []

    for item in req.links:
        row = rows_map.get(item.row_id)
        if not row:
            skipped.append(BulkLinkSkippedItem(
                row_id=item.row_id, reason="Row not found",
            ))
            continue

        if item.participant_id is None:
            # Unlink
            row.participant_id = None
            unlinked.append(BulkLinkResultItem(
                row_id=row.id, participant_id=None, participant_display_name=None,
            ))
            continue

        participant = participants_map.get(item.participant_id)
        if not participant:
            skipped.append(BulkLinkSkippedItem(
                row_id=item.row_id, reason="Participant not found",
            ))
            continue

        # Check if participant already linked to a different row
        if item.participant_id in existing_links:
            skipped.append(BulkLinkSkippedItem(
                row_id=item.row_id,
                reason=f"Already linked to {existing_links[item.participant_id]}",
            ))
            continue

        row.participant_id = item.participant_id
        p_name = participant.display_name or participant.identifier
        linked.append(BulkLinkResultItem(
            row_id=row.id,
            participant_id=item.participant_id,
            participant_display_name=p_name,
        ))
        # Track this participant as linked for subsequent items
        existing_links[item.participant_id] = row.row_identifier or f"Row #{row.id}"

    log_action(
        db,
        action="bulk_linked_participants",
        entity_type="dataset",
        entity_id=dataset_id,
        user_id=user.id,
        project_id=project_id,
        details={
            "linked": len(linked),
            "unlinked": len(unlinked),
            "skipped": len(skipped),
        },
    )
    db.commit()

    return BulkLinkResponse(linked=linked, unlinked=unlinked, skipped=skipped)


@router.post("/{dataset_id}/link-by-column", response_model=ParticipantLinkReport)
async def link_by_column(
    project_id: int,
    dataset_id: int,
    payload: LinkByColumnRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """#414 (DEC-8) — retro bulk-link: run the identifier-column linking over
    a dataset that already exists (imported before the feature, or imported
    with linking opted out). Processes UNLINKED rows only — a manual link is
    user intent and is never overwritten (the service counts them
    ``already_linked``). Same service, same semantics as import-time linking.
    """
    _get_project_or_404(db, project_id, user.id)
    _get_dataset_or_404(db, project_id, dataset_id, user.id)

    try:
        report = link_rows_by_identifier_column(
            db,
            project_id=project_id,
            dataset_id=dataset_id,
            column_id=payload.column_id,
        )
    except ValueError as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e))

    log_action(
        db,
        action="participants_linked_by_column",
        entity_type="dataset",
        entity_id=dataset_id,
        user_id=user.id,
        project_id=project_id,
        details={
            "column_id": payload.column_id,
            "linked": report["linked"],
            "created": report["created"],
            "matched": report["matched"],
            "skipped_duplicate": report["skipped_duplicate"],
            "skipped_conflict": report["skipped_conflict"],
        },
    )
    db.commit()

    return ParticipantLinkReport(**report)


# ── Linkable rows endpoint ───────────────────────────────────────────────


@router.get("/{dataset_id}/linkable-rows")
async def get_linkable_rows(
    project_id: int,
    dataset_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get all rows from a dataset with linking status, display labels, and
    searchable values (#418)."""
    _get_project_or_404(db, project_id, user.id)
    _get_dataset_or_404(db, project_id, dataset_id, user.id)

    # 1. Get the dataset's columns once; demographic subset keeps the labeled
    #    values shape, text-ish identifying columns drive display_values (#418
    #    — a row labeled only by its demographic values is anonymous when a
    #    dataset has none, e.g. Teacher_ID/School typed nominal).
    all_cols = (
        db.query(DatasetColumn)
        .filter(DatasetColumn.dataset_id == dataset_id)
        .order_by(DatasetColumn.sequence_order)
        .all()
    )
    demo_cols = [c for c in all_cols if c.column_type == ColumnType.DEMOGRAPHIC]
    # #414: identifier columns are the BEST row label — they exist to name rows.
    identifying_types = {ColumnType.IDENTIFIER, ColumnType.OPEN_TEXT, ColumnType.NOMINAL, ColumnType.DEMOGRAPHIC}
    identifying_col_ids = [c.id for c in all_cols if c.column_type in identifying_types]

    # 2. Get all rows with optional participant
    rows = (
        db.query(DatasetRow)
        .outerjoin(Participant, DatasetRow.participant_id == Participant.id)
        .filter(DatasetRow.dataset_id == dataset_id)
        .order_by(DatasetRow.id)
        .all()
    )

    # 3. Get ALL values for the rows — display labels come from identifying
    #    columns; search must cover every column's value_text (#418: searching
    #    "S001"/"T05"/"Maple" previously found nothing).
    values: dict[tuple[int, int], str | None] = {}
    row_ids = [r.id for r in rows]
    if row_ids and all_cols:
        vals = (
            db.query(DatasetValue)
            .filter(
                DatasetValue.row_id.in_(row_ids),
                DatasetValue.column_id.in_([c.id for c in all_cols]),
            )
            .all()
        )
        for v in vals:
            values[(v.row_id, v.column_id)] = v.value_text

    # 4. Build participant name map
    participant_ids = [r.participant_id for r in rows if r.participant_id]
    participant_names: dict[int, str] = {}
    if participant_ids:
        participants = (
            db.query(Participant)
            .filter(Participant.id.in_(participant_ids))
            .all()
        )
        participant_names = {
            p.id: p.display_name or p.identifier for p in participants
        }

    # 5. Build response
    result_rows = []
    for row in rows:
        demo_vals = []
        for col in demo_cols:
            label = col.demographic_subtype or col.column_text
            demo_vals.append({
                "label": label,
                "value": values.get((row.id, col.id)),
            })

        # #418: up to 3 identifying values for the row label — skip
        # recognized-N/A values (a slot spent on "N/A" identifies nothing)
        # and truncate long open-text values so notes don't flood the label.
        display_values: list[str] = []
        for col_id in identifying_col_ids:
            val = values.get((row.id, col_id))
            if val and val.strip() and not _is_na(val):
                cleaned = val.strip()
                if len(cleaned) > 40:
                    cleaned = cleaned[:39].rstrip() + "…"
                display_values.append(cleaned)
                if len(display_values) >= 3:
                    break
        # … and every value for search.
        search_parts = []
        for col in all_cols:
            val = values.get((row.id, col.id))
            if val and val.strip():
                search_parts.append(val.strip())
        search_text = " ".join(search_parts).lower()

        result_rows.append({
            "row_id": row.id,
            "row_identifier": row.row_identifier,
            "linked_participant_name": participant_names.get(row.participant_id) if row.participant_id else None,
            "demographic_values": demo_vals,
            "display_values": display_values,
            "search_text": search_text,
        })

    return {"rows": result_rows}


# ── Column subtype endpoint ──────────────────────────────────────────────


from pydantic import BaseModel as _BaseModel


class _SubtypeUpdateRequest(_BaseModel):
    demographic_subtype: str | None = None


@router.patch("/{dataset_id}/columns/{column_id}/subtype")
async def update_column_subtype(
    project_id: int,
    dataset_id: int,
    column_id: int,
    req: _SubtypeUpdateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Update the demographic subtype for a column."""
    _get_project_or_404(db, project_id, user.id)
    _get_dataset_or_404(db, project_id, dataset_id, user.id)

    column = (
        db.query(DatasetColumn)
        .filter(
            DatasetColumn.id == column_id,
            DatasetColumn.dataset_id == dataset_id,
        )
        .first()
    )
    if not column:
        raise HTTPException(status_code=404, detail="Column not found")

    if column.column_type != ColumnType.DEMOGRAPHIC:
        raise HTTPException(
            status_code=422,
            detail="Column must be of type 'demographic' to set a subtype",
        )

    column.demographic_subtype = req.demographic_subtype

    log_action(
        db,
        action="updated_subtype",
        entity_type="dataset_column",
        entity_id=column_id,
        user_id=user.id,
        project_id=project_id,
        details={
            "dataset_id": dataset_id,
            "demographic_subtype": req.demographic_subtype,
        },
    )
    db.commit()

    return {"status": "ok", "demographic_subtype": column.demographic_subtype}


# ── Column header edit endpoint ───────────────────────────────────────────


@router.patch(
    "/{dataset_id}/columns/{column_id}/header",
    response_model=DatasetColumnResponse,
)
async def update_column_header(
    project_id: int,
    dataset_id: int,
    column_id: int,
    req: ColumnHeaderUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Update column_name and/or column_text for any column."""
    _get_project_or_404(db, project_id, user.id)
    _get_dataset_or_404(db, project_id, dataset_id, user.id)

    column = (
        db.query(DatasetColumn)
        .options(joinedload(DatasetColumn.equivalence_group))
        .filter(
            DatasetColumn.id == column_id,
            DatasetColumn.dataset_id == dataset_id,
        )
        .first()
    )
    if not column:
        raise HTTPException(status_code=404, detail="Column not found")

    changed_text = False

    if req.column_name is not None:
        column.column_name = req.column_name.strip() or None

    if req.column_text is not None:
        new_text = req.column_text.strip()
        if new_text and new_text != column.column_text:
            column.column_text = new_text
            changed_text = True

    # #353: per-column opt-out for the participant detail panel.
    if req.show_in_participant_profile is not None:
        column.show_in_participant_profile = req.show_in_participant_profile

    if changed_text:
        mark_metrics_stale(db, project_id, column_ids=[column_id])

    log_action(
        db,
        action="updated_header",
        entity_type="dataset_column",
        entity_id=column_id,
        user_id=user.id,
        project_id=project_id,
        details={
            "dataset_id": dataset_id,
            "column_name": column.column_name,
            "column_text": column.column_text,
            "show_in_participant_profile": column.show_in_participant_profile,
        },
    )
    db.commit()

    return _column_to_response(column)


# ── Column reorder endpoint ──────────────────────────────────────────────


@router.post("/{dataset_id}/columns/reorder")
async def reorder_columns(
    project_id: int,
    dataset_id: int,
    req: ColumnReorderRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Set display_order for columns based on the provided ID list."""
    _get_project_or_404(db, project_id, user.id)
    _get_dataset_or_404(db, project_id, dataset_id, user.id)

    # Verify all column IDs belong to this dataset
    existing_ids = set(
        cid for (cid,) in db.query(DatasetColumn.id)
        .filter(DatasetColumn.dataset_id == dataset_id)
        .all()
    )

    provided_ids = set(req.ordered_column_ids)
    if provided_ids != existing_ids:
        raise HTTPException(
            status_code=422,
            detail="ordered_column_ids must contain exactly all column IDs for this dataset",
        )

    # Bulk update display_order
    for idx, cid in enumerate(req.ordered_column_ids):
        db.query(DatasetColumn).filter(DatasetColumn.id == cid).update(
            {DatasetColumn.display_order: idx},
            synchronize_session=False,
        )

    db.commit()
    return {"status": "ok"}


# ── Manual column endpoints ────────────────────────────────────────────────


@router.post(
    "/{dataset_id}/columns/manual",
    response_model=DatasetColumnResponse,
    status_code=201,
)
async def create_manual_column(
    project_id: int,
    dataset_id: int,
    req: ManualColumnCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create a new manual column in a dataset."""
    _get_project_or_404(db, project_id, user.id)
    ds = _get_dataset_or_404(db, project_id, dataset_id, user.id)

    # Validate column_type
    if req.column_type not in ALLOWED_MANUAL_TYPES:
        raise HTTPException(
            status_code=422,
            detail=f"column_type must be one of: {', '.join(sorted(ALLOWED_MANUAL_TYPES))}",
        )

    # Validate ordinal scale labels
    if req.column_type == "ordinal":
        if not req.scale_labels or len(req.scale_labels) < 2:
            raise HTTPException(
                status_code=422,
                detail="Ordinal columns must have at least 2 scale labels",
            )

    # Auto-generate column_code if omitted
    column_code = req.column_code
    if not column_code:
        existing_codes = (
            db.query(DatasetColumn.column_code)
            .filter(
                DatasetColumn.dataset_id == dataset_id,
                DatasetColumn.source == "manual",
                DatasetColumn.column_code.like("M%"),
            )
            .all()
        )
        max_num = 0
        for (code,) in existing_codes:
            try:
                num = int(code[1:])
                if num > max_num:
                    max_num = num
            except (ValueError, IndexError):
                pass
        column_code = f"M{max_num + 1:03d}"

    # sequence_order = max + 1
    max_seq = (
        db.query(func.max(DatasetColumn.sequence_order))
        .filter(DatasetColumn.dataset_id == dataset_id)
        .scalar()
    )
    seq_order = (max_seq or 0) + 1

    # display_order = max + 1 (ensures new manual column appears at end of reordered view)
    max_display = (
        db.query(func.max(DatasetColumn.display_order))
        .filter(DatasetColumn.dataset_id == dataset_id)
        .scalar()
    )
    display_order = (max_display or 0) + 1

    # Build scale metadata
    scale_labels_json = None
    scale_values_json = None
    scale_points = None
    if req.scale_labels:
        scale_labels_json = json.dumps(req.scale_labels)
        scale_values = req.scale_values or list(range(1, len(req.scale_labels) + 1))
        scale_values_json = json.dumps(scale_values)
        scale_points = len(req.scale_labels)

    # Handle binary type defaults
    if req.column_type == "binary" and not req.scale_labels:
        scale_labels_json = json.dumps(["Yes", "No"])
        scale_values_json = json.dumps([1, 0])
        scale_points = 2

    new_col = DatasetColumn(
        dataset_id=dataset_id,
        column_code=column_code,
        group_code=req.group_code,
        group_label=req.group_label,
        column_text=req.column_text,
        column_type=req.column_type,
        sequence_order=seq_order,
        display_order=display_order,
        scale_labels=scale_labels_json,
        scale_values=scale_values_json,
        scale_points=scale_points,
        numeric_min=req.numeric_min,
        numeric_max=req.numeric_max,
        numeric_format=req.numeric_format,
        demographic_subtype=req.demographic_subtype if req.column_type == "demographic" else None,
        source="manual",
    )
    db.add(new_col)
    db.flush()

    # Bulk-create empty value rows for all existing rows
    rows = (
        db.query(DatasetRow.id)
        .filter(DatasetRow.dataset_id == dataset_id)
        .all()
    )
    if rows:
        db.execute(
            DatasetValue.__table__.insert(),
            [{"row_id": r.id, "column_id": new_col.id} for r in rows],
        )

    log_action(
        db,
        action="manual_column_created",
        entity_type="dataset_column",
        entity_id=new_col.id,
        user_id=user.id,
        project_id=project_id,
        details={
            "dataset_id": dataset_id,
            "column_text": req.column_text,
            "column_type": req.column_type,
            "column_code": column_code,
        },
    )
    db.commit()

    return _column_to_response(new_col)


@router.patch(
    "/{dataset_id}/columns/{column_id}/manual",
    response_model=DatasetColumnResponse,
)
async def update_manual_column(
    project_id: int,
    dataset_id: int,
    column_id: int,
    req: ManualColumnUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Update metadata of a manual column."""
    _get_project_or_404(db, project_id, user.id)
    _get_dataset_or_404(db, project_id, dataset_id, user.id)

    column = (
        db.query(DatasetColumn)
        .filter(
            DatasetColumn.id == column_id,
            DatasetColumn.dataset_id == dataset_id,
        )
        .first()
    )
    if not column:
        raise HTTPException(status_code=404, detail="Column not found")
    if column.source != "manual":
        raise HTTPException(status_code=403, detail="Only manual columns can be edited")

    # Validate new type if changing
    if req.column_type is not None and req.column_type != (
        column.column_type.value
    ):
        if req.column_type not in ALLOWED_MANUAL_TYPES:
            raise HTTPException(
                status_code=422,
                detail=f"column_type must be one of: {', '.join(sorted(ALLOWED_MANUAL_TYPES))}",
            )

        # Check if column has recode definitions
        recode_count = (
            db.query(func.count(RecodeDefinition.id))
            .filter(RecodeDefinition.column_id == column_id)
            .scalar()
        )
        if recode_count > 0:
            raise HTTPException(
                status_code=409,
                detail=f"Cannot change type: column has {recode_count} recode definition(s). Delete them first.",
            )

        column.column_type = req.column_type

        # Clear inapplicable metadata when type changes
        if req.column_type not in ("ordinal", "binary"):
            column.scale_labels = None
            column.scale_values = None
            column.scale_points = None
        if req.column_type not in ("numeric", "percentage"):
            column.numeric_min = None
            column.numeric_max = None
            column.numeric_format = None
        if req.column_type != "demographic":
            column.demographic_subtype = None

    if req.column_text is not None:
        column.column_text = req.column_text
    if req.column_code is not None:
        column.column_code = req.column_code
    if req.group_code is not None:
        column.group_code = req.group_code
    if req.group_label is not None:
        column.group_label = req.group_label

    # Update scale metadata if provided
    if req.scale_labels is not None:
        column.scale_labels = json.dumps(req.scale_labels) if req.scale_labels else None
        scale_values = req.scale_values or (list(range(1, len(req.scale_labels) + 1)) if req.scale_labels else None)
        column.scale_values = json.dumps(scale_values) if scale_values else None
        column.scale_points = len(req.scale_labels) if req.scale_labels else None

    if req.numeric_min is not None:
        column.numeric_min = req.numeric_min
    if req.numeric_max is not None:
        column.numeric_max = req.numeric_max
    if req.numeric_format is not None:
        column.numeric_format = req.numeric_format
    if req.demographic_subtype is not None:
        column.demographic_subtype = req.demographic_subtype if column.column_type == ColumnType.DEMOGRAPHIC else None

    log_action(
        db,
        action="manual_column_updated",
        entity_type="dataset_column",
        entity_id=column_id,
        user_id=user.id,
        project_id=project_id,
        details={"dataset_id": dataset_id},
    )
    db.commit()

    return _column_to_response(column)


@router.delete(
    "/{dataset_id}/columns/{column_id}/manual",
    status_code=204,
)
async def delete_manual_column(
    project_id: int,
    dataset_id: int,
    column_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Delete a manual column and all its values/recode definitions."""
    _get_project_or_404(db, project_id, user.id)
    _get_dataset_or_404(db, project_id, dataset_id, user.id)

    column = (
        db.query(DatasetColumn)
        .filter(
            DatasetColumn.id == column_id,
            DatasetColumn.dataset_id == dataset_id,
        )
        .first()
    )
    if not column:
        raise HTTPException(status_code=404, detail="Column not found")
    if column.source != "manual":
        raise HTTPException(status_code=403, detail="Only manual columns can be deleted")

    # Block deletion if this column is referenced by computed columns
    computed_deps = (
        db.query(DatasetColumn)
        .filter(
            DatasetColumn.dataset_id == dataset_id,
            DatasetColumn.expression.isnot(None),
        )
        .all()
    )
    dep_names = []
    for cc in computed_deps:
        if cc.depends_on_column_ids:
            try:
                dep_ids = json.loads(cc.depends_on_column_ids)
                if column_id in dep_ids:
                    dep_names.append(cc.column_text)
            except (json.JSONDecodeError, TypeError):
                pass
    if dep_names:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot delete: computed column(s) depend on this column: {', '.join(dep_names)}",
        )

    # #298 cascade subset: capture domain IDs that contain this column BEFORE
    # the AnalysisDomainMember cleanup. Required because the column-driven
    # validator can't find the affected domains after their member rows are gone.
    affected_domain_ids = [
        r[0] for r in
        db.query(AnalysisDomainMember.domain_id)
        .filter(
            AnalysisDomainMember.member_type == "column",
            AnalysisDomainMember.member_id == column_id,
        )
        .distinct()
        .all()
    ]

    # Clean up analysis domain membership referencing this column
    db.query(AnalysisDomainMember).filter(
        AnalysisDomainMember.member_type == "column",
        AnalysisDomainMember.member_id == column_id,
    ).delete(synchronize_session="fetch")

    # Orphan cleanup: delete statistical tests targeting metrics about to be deleted
    manual_col_metric_ids = [
        r[0] for r in db.query(MetricDefinition.id).filter(
            MetricDefinition.input_source_type == "dataset_column",
            MetricDefinition.input_source_id == column_id,
        ).all()
    ]
    if manual_col_metric_ids:
        db.query(StatisticalTest).filter(
            StatisticalTest.target_type == "metric_definition",
            StatisticalTest.target_id.in_(manual_col_metric_ids),
        ).delete(synchronize_session="fetch")

    # Clean up metric definitions referencing this column
    db.query(MetricDefinition).filter(
        MetricDefinition.input_source_type == "dataset_column",
        MetricDefinition.input_source_id == column_id,
    ).delete(synchronize_session="fetch")

    # Clean up equivalence groups that now have 0 linked columns
    empty_group_ids = [
        g.id for g in
        db.query(EquivalenceGroup)
        .outerjoin(DatasetColumn, DatasetColumn.equivalence_group_id == EquivalenceGroup.id)
        .filter(EquivalenceGroup.project_id == project_id)
        .group_by(EquivalenceGroup.id)
        .having(func.count(DatasetColumn.id) == 0)
        .all()
    ]
    if empty_group_ids:
        db.query(EquivalenceGroup).filter(
            EquivalenceGroup.id.in_(empty_group_ids),
        ).delete(synchronize_session="fetch")

    # #298 cascade subset: validate post-cascade I2 pairing for surviving
    # cross-dataset domains. Empty domains are skipped (cleaned up below).
    db.flush()
    assert_domains_intact_for_domain_ids(db, affected_domain_ids)

    # Clean up analysis domains that now have 0 members
    empty_domain_ids = [
        d.id for d in
        db.query(AnalysisDomain)
        .outerjoin(AnalysisDomainMember)
        .filter(AnalysisDomain.project_id == project_id)
        .group_by(AnalysisDomain.id)
        .having(func.count(AnalysisDomainMember.id) == 0)
        .all()
    ]
    if empty_domain_ids:
        db.query(AnalysisDomain).filter(
            AnalysisDomain.id.in_(empty_domain_ids),
        ).delete(synchronize_session="fetch")

    log_action(
        db,
        action="manual_column_deleted",
        entity_type="dataset_column",
        entity_id=column_id,
        user_id=user.id,
        project_id=project_id,
        details={
            "dataset_id": dataset_id,
            "column_text": column.column_text,
        },
    )

    db.delete(column)
    db.commit()


# ── Computed column endpoints ────────────────────────────────────────────────


def _cascade_delete_column_refs(db: Session, project_id: int, column_id: int):
    """Shared cascade cleanup for deleting a column (manual or computed).

    Includes the #298 cascade subset I2 validator: captures affected domain
    IDs before deleting member rows, then validates surviving cross-dataset
    domains after the cleanup but before empty-domain pruning. Failure
    raises 409 cross_dataset_unpaired and rolls back the transaction.
    """
    # #298 cascade subset: capture domain IDs before the member cleanup
    # nukes them (column-driven validator wouldn't find them post-cleanup).
    affected_domain_ids = [
        r[0] for r in
        db.query(AnalysisDomainMember.domain_id)
        .filter(
            AnalysisDomainMember.member_type == "column",
            AnalysisDomainMember.member_id == column_id,
        )
        .distinct()
        .all()
    ]

    db.query(AnalysisDomainMember).filter(
        AnalysisDomainMember.member_type == "column",
        AnalysisDomainMember.member_id == column_id,
    ).delete(synchronize_session="fetch")

    col_metric_ids = [
        r[0] for r in db.query(MetricDefinition.id).filter(
            MetricDefinition.input_source_type == "dataset_column",
            MetricDefinition.input_source_id == column_id,
        ).all()
    ]
    if col_metric_ids:
        db.query(StatisticalTest).filter(
            StatisticalTest.target_type == "metric_definition",
            StatisticalTest.target_id.in_(col_metric_ids),
        ).delete(synchronize_session="fetch")

    db.query(MetricDefinition).filter(
        MetricDefinition.input_source_type == "dataset_column",
        MetricDefinition.input_source_id == column_id,
    ).delete(synchronize_session="fetch")

    empty_group_ids = [
        g.id for g in
        db.query(EquivalenceGroup)
        .outerjoin(DatasetColumn, DatasetColumn.equivalence_group_id == EquivalenceGroup.id)
        .filter(EquivalenceGroup.project_id == project_id)
        .group_by(EquivalenceGroup.id)
        .having(func.count(DatasetColumn.id) == 0)
        .all()
    ]
    if empty_group_ids:
        db.query(EquivalenceGroup).filter(
            EquivalenceGroup.id.in_(empty_group_ids),
        ).delete(synchronize_session="fetch")

    # #298 cascade subset: validate surviving cross-dataset domains.
    db.flush()
    assert_domains_intact_for_domain_ids(db, affected_domain_ids)

    empty_domain_ids = [
        d.id for d in
        db.query(AnalysisDomain)
        .outerjoin(AnalysisDomainMember)
        .filter(AnalysisDomain.project_id == project_id)
        .group_by(AnalysisDomain.id)
        .having(func.count(AnalysisDomainMember.id) == 0)
        .all()
    ]
    if empty_domain_ids:
        db.query(AnalysisDomain).filter(
            AnalysisDomain.id.in_(empty_domain_ids),
        ).delete(synchronize_session="fetch")


@router.get("/{dataset_id}/domain-scores")
async def get_domain_scores(
    project_id: int,
    dataset_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Return per-row domain aggregate scores for this dataset's domains."""
    _get_project_or_404(db, project_id, user.id)
    _get_dataset_or_404(db, project_id, dataset_id, user.id)

    # Find domains that have member columns in this dataset
    domain_ids_in_dataset = (
        db.query(AnalysisDomainMember.domain_id)
        .join(DatasetColumn, (AnalysisDomainMember.member_type == "column") & (AnalysisDomainMember.member_id == DatasetColumn.id))
        .filter(DatasetColumn.dataset_id == dataset_id)
        .distinct()
        .all()
    )
    domain_ids = [r[0] for r in domain_ids_in_dataset]
    if not domain_ids:
        return {"domain_scores": []}

    # Load domain metadata
    domains = (
        db.query(AnalysisDomain)
        .filter(AnalysisDomain.id.in_(domain_ids))
        .all()
    )
    domain_map = {d.id: d for d in domains}

    # #292: count distinct datasets per domain so we can flag virtual columns
    # whose label ("Wellness") understates that the value is only the
    # current-dataset subset of a cross-dataset domain. Returned alongside
    # the per-row scores; frontend renders "Wellness — Board subset" when
    # `is_cross_dataset_subset` is true.
    members_by_domain = (
        db.query(AnalysisDomainMember.domain_id, DatasetColumn.dataset_id)
        .join(DatasetColumn, (AnalysisDomainMember.member_type == "column") & (AnalysisDomainMember.member_id == DatasetColumn.id))
        .filter(AnalysisDomainMember.domain_id.in_(domain_ids))
        .all()
    )
    domain_dataset_counts: dict[int, set[int]] = {}
    for dom_id, ds_id in members_by_domain:
        domain_dataset_counts.setdefault(dom_id, set()).add(ds_id)

    current_dataset = (
        db.query(Dataset).filter(Dataset.id == dataset_id).first()
    )
    current_dataset_name = current_dataset.name if current_dataset else None

    # Find ungrouped domain_aggregate metrics for these domains
    metrics = (
        db.query(MetricDefinition)
        .filter(
            MetricDefinition.project_id == project_id,
            MetricDefinition.metric_type == "domain_aggregate",
            MetricDefinition.input_source_type == "dataset_domain",
            MetricDefinition.input_source_id.in_(domain_ids),
            MetricDefinition.grouping_column_id.is_(None),
            MetricDefinition.grouping_column_id_2.is_(None),
        )
        .all()
    )
    if not metrics:
        return {"domain_scores": []}

    metric_ids = [m.id for m in metrics]

    # Load row scores, filtered to rows in this dataset
    row_ids = [r[0] for r in db.query(DatasetRow.id).filter(DatasetRow.dataset_id == dataset_id).all()]
    scores = (
        db.query(RowScore.dataset_row_id, RowScore.metric_definition_id, RowScore.score)
        .filter(
            RowScore.metric_definition_id.in_(metric_ids),
            RowScore.dataset_row_id.in_(row_ids),
        )
        .all()
    ) if row_ids else []

    # Pivot: {metric_id: {row_id: score}}
    score_pivot: dict[int, dict[int, float | None]] = {}
    for row_id, metric_id, score in scores:
        score_pivot.setdefault(metric_id, {})[row_id] = score

    result = []
    for m in metrics:
        dom = domain_map.get(m.input_source_id)
        if not dom:
            continue
        ds_count = len(domain_dataset_counts.get(dom.id, set()))
        is_subset = ds_count > 1
        result.append({
            "domain_id": dom.id,
            "domain_name": dom.name,
            "domain_color": dom.color,
            "metric_id": m.id,
            "stale": m.stale,
            # #292: subset metadata so the frontend can render
            # "Wellness — Board subset" with a tooltip explaining the scope.
            "is_cross_dataset_subset": is_subset,
            "subset_dataset_name": current_dataset_name if is_subset else None,
            "member_dataset_count": ds_count,
            "scores": {str(k): v for k, v in score_pivot.get(m.id, {}).items()},
        })

    return {"domain_scores": result}


@router.post("/{dataset_id}/columns/computed/preview")
async def preview_computed_column(
    project_id: int,
    dataset_id: int,
    req: ComputedColumnCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Validate an expression and return a preview of first 5 rows without persisting."""
    _get_project_or_404(db, project_id, user.id)
    _get_dataset_or_404(db, project_id, dataset_id, user.id)

    try:
        ast = parse_expression(req.expression)
    except ComputedExpressionError as e:
        return {"valid": False, "error": str(e), "warnings": [], "preview_rows": []}

    existing_cols = (
        db.query(DatasetColumn)
        .filter(DatasetColumn.dataset_id == dataset_id)
        .all()
    )
    col_infos = [
        ColumnInfo(
            id=c.id, code=c.column_code, text=c.column_text,
            column_type=c.column_type.value if hasattr(c.column_type, 'value') else str(c.column_type),
        )
        for c in existing_cols
    ]
    try:
        result = validate_expression(ast, col_infos)
    except ComputedExpressionError as e:
        return {"valid": False, "error": str(e), "warnings": [], "preview_rows": []}

    from ..services.computed_columns import evaluate as eval_expr

    # Load first 5 rows
    first_rows = (
        db.query(DatasetRow.id)
        .filter(DatasetRow.dataset_id == dataset_id)
        .order_by(DatasetRow.id)
        .limit(5)
        .all()
    )
    row_ids = [r[0] for r in first_rows]

    # Load source values
    dep_ids = result.dependency_ids
    source_values_q = (
        db.query(DatasetValue.row_id, DatasetValue.column_id,
                 DatasetValue.value_text, DatasetValue.value_numeric)
        .filter(DatasetValue.column_id.in_(dep_ids), DatasetValue.row_id.in_(row_ids))
        .all()
    ) if dep_ids and row_ids else []

    row_data: dict[int, dict[int, tuple]] = {}
    for resp_id, col_id, vt, vn in source_values_q:
        row_data.setdefault(resp_id, {})[col_id] = (vt, vn)

    # Build column name lookup for source display
    col_name_map = {c.id: c.column_code or c.column_text for c in existing_cols}

    preview_rows = []
    for rid in row_ids:
        rd = row_data.get(rid, {})
        try:
            vt, vn = eval_expr(result.resolved_ast, rd)
        except ComputedExpressionError:
            vt, vn = None, None
        source_vals = {col_name_map.get(cid, str(cid)): pair[0] for cid, pair in rd.items() if cid in dep_ids}
        preview_rows.append({
            "row_id": rid,
            "source_values": source_vals,
            "result_text": vt,
            "result_numeric": vn,
        })

    # Generate R code equivalent
    r_code = None
    try:
        col_r_names = {}
        for c in existing_cols:
            r_name = (c.column_code or c.column_text).lower()
            r_name = re.sub(r'[^a-z0-9_]', '_', r_name)
            col_r_names[c.id] = r_name
        r_code = to_r_expression(result.resolved_ast, col_r_names)
    except Exception:
        logger.debug("R expression preview failed", exc_info=True)

    return {
        "valid": True,
        "error": None,
        "warnings": result.warnings,
        "preview_rows": preview_rows,
        "r_expression": r_code,
    }


@router.post(
    "/{dataset_id}/columns/computed",
    response_model=DatasetColumnResponse,
    status_code=201,
)
async def create_computed_column(
    project_id: int,
    dataset_id: int,
    req: ComputedColumnCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create a computed column with a formula expression."""
    _get_project_or_404(db, project_id, user.id)
    _get_dataset_or_404(db, project_id, dataset_id, user.id)

    # Parse and validate expression
    try:
        ast = parse_expression(req.expression)
    except ComputedExpressionError as e:
        raise HTTPException(status_code=400, detail=f"Expression error: {e}")

    existing_cols = (
        db.query(DatasetColumn)
        .filter(DatasetColumn.dataset_id == dataset_id)
        .all()
    )
    col_infos = [
        ColumnInfo(
            id=c.id,
            code=c.column_code,
            text=c.column_text,
            column_type=c.column_type.value if hasattr(c.column_type, 'value') else str(c.column_type),
        )
        for c in existing_cols
    ]
    try:
        result = validate_expression(ast, col_infos)
    except ComputedExpressionError as e:
        raise HTTPException(status_code=400, detail=f"Expression error: {e}")

    # Auto-generate column_code
    existing_codes = {c.column_code for c in existing_cols if c.column_code}
    code_num = 1
    while f"C{code_num}" in existing_codes:
        code_num += 1
    column_code = req.column_code or f"C{code_num}"

    # Compute ordering
    max_seq = (
        db.query(func.max(DatasetColumn.sequence_order))
        .filter(DatasetColumn.dataset_id == dataset_id)
        .scalar()
    )
    max_disp = (
        db.query(func.max(DatasetColumn.display_order))
        .filter(DatasetColumn.dataset_id == dataset_id)
        .scalar()
    )
    seq_order = (max_seq or 0) + 1
    display_order = (max_disp or 0) + 1

    new_col = DatasetColumn(
        dataset_id=dataset_id,
        column_code=column_code,
        column_text=req.column_text,
        column_type=req.column_type,
        sequence_order=seq_order,
        display_order=display_order,
        source="computed",
        expression=req.expression,
        depends_on_column_ids=json.dumps(result.dependency_ids),
        stale=False,
    )
    db.add(new_col)
    db.flush()

    # Evaluate all rows. A per-row evaluation error is a client-side expression
    # problem (the formula can't be applied to this data), not a server fault —
    # surface it as 400, not an unhandled 500 (#360). new_col was only flushed,
    # not committed, so it's discarded when the session closes on the raise.
    try:
        evaluate_computed_column(db, new_col)
    except ComputedExpressionError as e:
        raise HTTPException(status_code=400, detail=f"Expression error: {e}")

    log_action(
        db,
        action="computed_column_created",
        entity_type="dataset_column",
        entity_id=new_col.id,
        user_id=user.id,
        project_id=project_id,
        details={
            "dataset_id": dataset_id,
            "column_text": req.column_text,
            "expression": req.expression,
        },
    )
    db.commit()
    return _column_to_response(new_col)


@router.patch(
    "/{dataset_id}/columns/{column_id}/computed",
    response_model=DatasetColumnResponse,
)
async def update_computed_column(
    project_id: int,
    dataset_id: int,
    column_id: int,
    req: ComputedColumnUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Update a computed column's formula."""
    _get_project_or_404(db, project_id, user.id)
    _get_dataset_or_404(db, project_id, dataset_id, user.id)

    column = (
        db.query(DatasetColumn)
        .filter(DatasetColumn.id == column_id, DatasetColumn.dataset_id == dataset_id)
        .first()
    )
    if not column:
        raise HTTPException(status_code=404, detail="Column not found")
    if column.source != "computed":
        raise HTTPException(status_code=403, detail="Only computed columns can be updated via this endpoint")

    # Parse and validate new expression
    try:
        ast = parse_expression(req.expression)
    except ComputedExpressionError as e:
        raise HTTPException(status_code=400, detail=f"Expression error: {e}")

    sibling_cols = (
        db.query(DatasetColumn)
        .filter(DatasetColumn.dataset_id == dataset_id, DatasetColumn.id != column_id)
        .all()
    )
    col_infos = [
        ColumnInfo(
            id=c.id, code=c.column_code, text=c.column_text,
            column_type=c.column_type.value if hasattr(c.column_type, 'value') else str(c.column_type),
        )
        for c in sibling_cols
    ]
    try:
        result = validate_expression(ast, col_infos, self_column_id=column_id)
    except ComputedExpressionError as e:
        raise HTTPException(status_code=400, detail=f"Expression error: {e}")

    old_expression = column.expression
    column.expression = req.expression
    column.depends_on_column_ids = json.dumps(result.dependency_ids)
    if req.column_type:
        column.column_type = req.column_type
    column.stale = False

    try:
        evaluate_computed_column(db, column)  # 400 not 500 on bad-for-data formula (#360)
    except ComputedExpressionError as e:
        raise HTTPException(status_code=400, detail=f"Expression error: {e}")
    mark_metrics_stale(db, project_id, column_ids=[column_id])

    log_action(
        db,
        action="computed_column_updated",
        entity_type="dataset_column",
        entity_id=column_id,
        user_id=user.id,
        project_id=project_id,
        details={
            "old_expression": old_expression,
            "new_expression": req.expression,
        },
    )
    db.commit()
    return _column_to_response(column)


@router.post(
    "/{dataset_id}/columns/{column_id}/recompute",
)
async def recompute_column(
    project_id: int,
    dataset_id: int,
    column_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Recompute a stale computed column."""
    _get_project_or_404(db, project_id, user.id)
    _get_dataset_or_404(db, project_id, dataset_id, user.id)

    column = (
        db.query(DatasetColumn)
        .filter(DatasetColumn.id == column_id, DatasetColumn.dataset_id == dataset_id)
        .first()
    )
    if not column:
        raise HTTPException(status_code=404, detail="Column not found")
    if column.source != "computed":
        raise HTTPException(status_code=403, detail="Only computed columns can be recomputed")

    try:
        count = evaluate_computed_column(db, column)  # 400 not 500 (#360)
    except ComputedExpressionError as e:
        raise HTTPException(status_code=400, detail=f"Expression error: {e}")
    column.stale = False
    db.commit()
    return {"status": "ok", "rows_evaluated": count}


@router.delete(
    "/{dataset_id}/columns/{column_id}/computed",
    status_code=204,
)
async def delete_computed_column(
    project_id: int,
    dataset_id: int,
    column_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Delete a computed column and all its values."""
    _get_project_or_404(db, project_id, user.id)
    _get_dataset_or_404(db, project_id, dataset_id, user.id)

    column = (
        db.query(DatasetColumn)
        .filter(DatasetColumn.id == column_id, DatasetColumn.dataset_id == dataset_id)
        .first()
    )
    if not column:
        raise HTTPException(status_code=404, detail="Column not found")
    if column.source != "computed":
        raise HTTPException(status_code=403, detail="Only computed columns can be deleted via this endpoint")

    # Block deletion if another computed column depends on this one (#361).
    # Mirrors delete_manual_column's guard — without it, deleting e.g.
    # Annualized_Base silently orphans FTE_Adjusted_Annual, whose expression
    # then references a column that no longer exists. Exclude self so a column's
    # own (validator-rejected, but defensively) self-reference can't block it.
    computed_deps = (
        db.query(DatasetColumn)
        .filter(
            DatasetColumn.dataset_id == dataset_id,
            DatasetColumn.id != column_id,
            DatasetColumn.expression.isnot(None),
        )
        .all()
    )
    dep_names = []
    for cc in computed_deps:
        if cc.depends_on_column_ids:
            try:
                dep_ids = json.loads(cc.depends_on_column_ids)
                if column_id in dep_ids:
                    dep_names.append(cc.column_text)
            except (json.JSONDecodeError, TypeError):
                pass
    if dep_names:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot delete: computed column(s) depend on this column: {', '.join(dep_names)}",
        )

    _cascade_delete_column_refs(db, project_id, column_id)

    log_action(
        db,
        action="computed_column_deleted",
        entity_type="dataset_column",
        entity_id=column_id,
        user_id=user.id,
        project_id=project_id,
        details={"column_text": column.column_text, "expression": column.expression},
    )
    db.delete(column)
    db.commit()


@router.patch(
    "/{dataset_id}/values/{value_id}",
    response_model=ValueCellResponse,
)
async def update_value(
    project_id: int,
    dataset_id: int,
    value_id: int,
    req: ValueUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Update a single value cell (manual columns only)."""
    _get_project_or_404(db, project_id, user.id)
    _get_dataset_or_404(db, project_id, dataset_id, user.id)

    value = (
        db.query(DatasetValue)
        .options(joinedload(DatasetValue.column))
        .filter(DatasetValue.id == value_id)
        .first()
    )
    if not value:
        raise HTTPException(status_code=404, detail="Value not found")
    if value.column.dataset_id != dataset_id:
        raise HTTPException(status_code=404, detail="Value not found in this dataset")
    if value.column.source != "manual":
        raise HTTPException(status_code=403, detail="Only manual column values can be edited")

    old_value = value.value_text
    new_value = req.value_text.strip() if req.value_text and req.value_text.strip() else None
    value.value_text = new_value

    # Update word_count for open-ended columns
    if value.column.column_type == ColumnType.OPEN_TEXT:
        value.word_count = len(new_value.split()) if new_value and new_value.strip() else 0

    # Compute value_numeric if there's a primary recode definition
    value.value_numeric = None
    if new_value:
        primary_def = (
            db.query(RecodeDefinition)
            .filter(
                RecodeDefinition.column_id == value.column_id,
                RecodeDefinition.is_primary == True,
            )
            .first()
        )
        if primary_def:
            computed = compute_value(new_value, primary_def)
            if computed is not None:
                try:
                    value.value_numeric = float(computed)
                except (ValueError, TypeError):
                    pass

    mark_metrics_stale(db, project_id, column_ids=[value.column_id])

    log_action(
        db,
        action="value_updated",
        entity_type="dataset_value",
        entity_id=value_id,
        user_id=user.id,
        project_id=project_id,
        details={
            "dataset_id": dataset_id,
            "column_id": value.column_id,
            "old_value": old_value,
            "new_value": new_value,
        },
    )
    db.commit()

    return ValueCellResponse(
        id=value.id,
        row_id=value.row_id,
        column_id=value.column_id,
        value_text=value.value_text,
        value_numeric=value.value_numeric,
    )


# ── Append import endpoints ─────────────────────────────────────────────────


async def _upload_to_csv_text(
    file: UploadFile, encoding: str, sheet_name: str | None = None,
) -> tuple[str, list[str] | None, dict[str, SavColumnMeta] | None]:
    """Read a dataset upload (CSV, .xlsx, or SPSS .sav) as CSV text (#523/#28).

    The single format seam for ALL dataset upload endpoints (preview / import /
    append preview / append import): .xlsx converts through the openpyxl adapter
    and .sav through the pyreadstat adapter (both in a threadpool — untrusted
    binary parse); everything else takes the existing text-decode path.

    Returns ``(csv_text, sheet_names, sav_meta)``. ``sheet_names`` is xlsx-only;
    ``sav_meta`` is .sav-only and carries what CSV cannot express (SPSS's measure
    and code-ordered scale points). Only the preview endpoint can act on the
    metadata — everything downstream consumes plain CSV, unchanged.
    """
    content = await read_upload_with_limit(file)
    if is_xlsx_upload(file.filename, content):
        try:
            text, sheet_names = await run_in_threadpool(xlsx_to_csv_text, content, sheet_name)
            return text, sheet_names, None
        except XlsxImportError as e:
            logger.warning("xlsx parse failed: %s", e)
            raise HTTPException(status_code=400, detail=str(e))
    if is_sav_upload(file.filename, content):
        try:
            text, sav_meta = await run_in_threadpool(sav_to_csv_text, content)
            return text, None, sav_meta
        except SavImportError as e:
            logger.warning("sav parse failed: %s", e)
            raise HTTPException(status_code=400, detail=str(e))
    return _decode_csv(content, encoding), None, None


def _decode_csv(content: bytes, encoding: str) -> str:
    """Decode CSV bytes with encoding and strip BOM."""
    try:
        text = content.decode(encoding)
    except (UnicodeDecodeError, LookupError) as e:
        logger.warning("File decode failed: %s", e)
        raise HTTPException(status_code=400, detail="Unable to decode file. Ensure it uses UTF-8 or the specified encoding.")
    return _strip_bom(text)


def _parse_row_id(rid: str) -> tuple[int, int] | None:
    """Parse 'R0001' format into (number, pad_width) or None."""
    m = re.match(r"^R(\d+)$", rid or "")
    if m:
        return int(m.group(1)), len(m.group(1))
    return None


@router.post(
    "/{dataset_id}/append-preview",
    response_model=DatasetAppendPreviewResponse,
)
async def append_preview(
    project_id: int,
    dataset_id: int,
    file: UploadFile = File(...),
    encoding: str = Form("utf-8"),
    sheet_name: str | None = Form(None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Preview a file (CSV or .xlsx, #523) for appending rows to an existing dataset."""
    _get_project_or_404(db, project_id, user.id)
    ds = _get_dataset_or_404(db, project_id, dataset_id, user.id)
    validate_encoding(encoding)

    text, sheet_names, _sav_meta = await _upload_to_csv_text(file, encoding, sheet_name)

    try:
        reader = csv.reader(io.StringIO(text))
        csv_headers = next(reader)
        csv_rows = list(reader)
    except (csv.Error, StopIteration, ValueError) as e:
        logger.warning("CSV parse failed: %s", e)
        raise HTTPException(status_code=400, detail="Unable to parse CSV file. Check the file format and try again.")

    if not csv_rows:
        raise HTTPException(status_code=400, detail="CSV file has no data rows")

    # Load existing columns (imported only -- manual columns excluded from matching)
    columns = (
        db.query(DatasetColumn)
        .filter(
            DatasetColumn.dataset_id == dataset_id,
            DatasetColumn.source == "imported",
        )
        .order_by(DatasetColumn.sequence_order)
        .all()
    )

    if not columns:
        raise HTTPException(status_code=400, detail="Dataset has no imported columns to match against")

    # Build lookup maps for matching
    code_map: dict[str, DatasetColumn] = {}  # lowercase column_code -> column
    text_map: dict[str, DatasetColumn] = {}  # lowercase column_text -> column

    for q in columns:
        if q.column_code:
            code_map[q.column_code.strip().lower()] = q
        text_map[q.column_text.strip().lower()] = q

    # Match CSV columns to existing dataset columns
    matched: list[AppendMatchedColumn] = []
    unmatched_csv: list[AppendUnmatchedCsvColumn] = []
    matched_column_ids: set[int] = set()
    col_to_column: dict[int, DatasetColumn] = {}  # csv col_index -> column

    for col_idx, header in enumerate(csv_headers):
        parsed = parse_header(header.strip())
        csv_code = parsed["column_code"]

        # Pass 1: match by column_code
        q = None
        match_method = ""
        if csv_code:
            q = code_map.get(csv_code.strip().lower())
            if q:
                match_method = "code"

        # Pass 2: match by column_text (exact, trimmed, case-insensitive)
        if not q:
            q = text_map.get(parsed["column_text"].strip().lower())
            if q:
                match_method = "text"

        if q and q.id not in matched_column_ids:
            matched_column_ids.add(q.id)
            col_to_column[col_idx] = q
            qtype = q.column_type.value
            matched.append(AppendMatchedColumn(
                csv_column_name=header,
                csv_column_index=col_idx,
                column_id=q.id,
                column_code=q.column_code,
                column_text=q.column_text,
                column_type=qtype,
                match_method=match_method,
            ))
        else:
            unmatched_csv.append(AppendUnmatchedCsvColumn(
                csv_column_name=header,
                csv_column_index=col_idx,
            ))

    if not matched:
        raise HTTPException(
            status_code=400,
            detail="No CSV columns matched any existing columns. Check column headers.",
        )

    # Unmatched columns (existing columns not matched by any CSV column)
    unmatched_cols = [
        AppendUnmatchedColumn(
            column_id=q.id,
            column_code=q.column_code,
            column_text=q.column_text,
        )
        for q in columns
        if q.id not in matched_column_ids
    ]

    # Duplicate detection: build fingerprints from existing rows
    existing_rows = (
        db.query(DatasetRow)
        .options(joinedload(DatasetRow.values))
        .filter(DatasetRow.dataset_id == dataset_id)
        .all()
    )

    existing_fingerprints: set[tuple] = set()
    for row in existing_rows:
        # Fingerprint = sorted tuple of (column_id, value_text) for matched columns
        val_map = {v.column_id: (v.value_text or "").strip().lower() for v in row.values}
        fp = tuple(sorted(
            (cid, val_map.get(cid, ""))
            for cid in matched_column_ids
        ))
        existing_fingerprints.add(fp)

    # Build preview rows + detect duplicates
    preview_rows: list[AppendPreviewRow] = []
    duplicate_count = 0

    for row_idx, row in enumerate(csv_rows):
        values: dict[str, str] = {}
        fp_parts: list[tuple[int, str]] = []

        for col_idx, q in col_to_column.items():
            cell = row[col_idx].strip() if col_idx < len(row) else ""
            values[str(q.id)] = cell
            fp_parts.append((q.id, cell.lower()))

        fp = tuple(sorted(fp_parts))
        is_dup = fp in existing_fingerprints

        if is_dup:
            duplicate_count += 1

        preview_rows.append(AppendPreviewRow(
            csv_row_index=row_idx,
            values=values,
            is_duplicate=is_dup,
        ))

    # Determine next record ID
    existing_rids = (
        db.query(DatasetRow.row_identifier)
        .filter(DatasetRow.dataset_id == dataset_id)
        .all()
    )

    max_num = 0
    pad_width = 4  # default
    for (rid,) in existing_rids:
        parsed_rid = _parse_row_id(rid)
        if parsed_rid:
            num, pw = parsed_rid
            if num > max_num:
                max_num = num
                pad_width = pw

    next_rid = f"R{str(max_num + 1).zfill(pad_width)}"

    # #414 (DEC-7): offer append-linking when the dataset has exactly ONE
    # identifier column AND the file matched it (otherwise new rows would
    # carry no identifier values and every row would report skipped_missing).
    identifier_cols = [c for c in columns if c.column_type == ColumnType.IDENTIFIER]
    participant_link_column = None
    if len(identifier_cols) == 1 and identifier_cols[0].id in matched_column_ids:
        participant_link_column = AppendLinkColumnOffer(
            column_id=identifier_cols[0].id,
            column_text=identifier_cols[0].column_text,
        )

    return DatasetAppendPreviewResponse(
        matched_columns=matched,
        unmatched_csv_columns=unmatched_csv,
        unmatched_columns=unmatched_cols,
        total_rows=len(csv_rows),
        duplicate_count=duplicate_count,
        preview_rows=preview_rows[:10],  # preview first 10 rows only
        next_row_id=next_rid,
        row_pad_width=pad_width,
        sheet_names=sheet_names,
        participant_link_column=participant_link_column,
    )


@router.post(
    "/{dataset_id}/append-import",
    response_model=DatasetAppendResponse,
)
async def append_import(
    project_id: int,
    dataset_id: int,
    file: UploadFile = File(...),
    import_config: str = Form(...),
    encoding: str = Form("utf-8"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Append CSV rows to an existing dataset."""
    _get_project_or_404(db, project_id, user.id)
    ds = _get_dataset_or_404(db, project_id, dataset_id, user.id)
    validate_encoding(encoding)

    # Parse config
    try:
        config = DatasetAppendRequest.model_validate(json.loads(import_config))
    except (json.JSONDecodeError, ValueError) as e:
        logger.warning("Invalid import config: %s", e)
        raise HTTPException(status_code=400, detail="Invalid import configuration.")

    text, _sheet_names, _sav_meta = await _upload_to_csv_text(file, encoding, config.sheet_name)

    try:
        reader = csv.reader(io.StringIO(text))
        csv_headers = next(reader)
        csv_rows = list(reader)
    except (csv.Error, StopIteration, ValueError) as e:
        logger.warning("CSV parse failed: %s", e)
        raise HTTPException(status_code=400, detail="Unable to parse CSV file. Check the file format and try again.")

    if not csv_rows:
        raise HTTPException(status_code=400, detail="CSV file has no data rows")

    # Build column mapping: csv_col_index -> column
    col_mapping: dict[int, DatasetColumn] = {}
    column_ids_in_mapping: set[int] = set()

    for item in config.column_mapping:
        col_idx = item["csv_column_index"]
        cid = item["column_id"]

        q = (
            db.query(DatasetColumn)
            .filter(
                DatasetColumn.id == cid,
                DatasetColumn.dataset_id == dataset_id,
            )
            .first()
        )
        if q:
            col_mapping[col_idx] = q
            column_ids_in_mapping.add(q.id)

    if not col_mapping:
        raise HTTPException(status_code=400, detail="No valid column mappings provided")

    # Duplicate detection (re-compute fingerprints)
    existing_rows = (
        db.query(DatasetRow)
        .options(joinedload(DatasetRow.values))
        .filter(DatasetRow.dataset_id == dataset_id)
        .all()
    )

    existing_fingerprints: set[tuple] = set()
    for row in existing_rows:
        val_map = {v.column_id: (v.value_text or "").strip().lower() for v in row.values}
        fp = tuple(sorted(
            (cid, val_map.get(cid, ""))
            for cid in column_ids_in_mapping
        ))
        existing_fingerprints.add(fp)

    # Determine record start ID
    existing_rids = (
        db.query(DatasetRow.row_identifier)
        .filter(DatasetRow.dataset_id == dataset_id)
        .all()
    )

    max_num = 0
    pad_width = 4
    for (rid,) in existing_rids:
        parsed_rid = _parse_row_id(rid)
        if parsed_rid:
            num, pw = parsed_rid
            if num > max_num:
                max_num = num
                pad_width = pw

    # Use provided start ID or auto-compute
    next_num = max_num + 1
    if config.row_start_id:
        parsed_start = _parse_row_id(config.row_start_id)
        if parsed_start:
            req_num, req_pad = parsed_start
            # Auto-adjust if conflict (requested start <= existing max)
            next_num = max(req_num, max_num + 1)
            pad_width = req_pad

    # Build column metadata for value_numeric computation. `scale_values` carries
    # the codes the column was imported with (#28) — an SPSS scale may be 0-based
    # or gapped, and an append must encode identically to the original import or
    # the same label would mean two different numbers within one column.
    col_meta: dict[int, dict] = {}
    for q in col_mapping.values():
        qtype = q.column_type.value
        scale_labels = None
        scale_values = None
        if q.scale_labels:
            try:
                scale_labels = json.loads(q.scale_labels)
            except (json.JSONDecodeError, TypeError) as e:
                logger.warning("Failed to parse scale_labels JSON for column %s during append: %s", q.id, e)
        if q.scale_values:
            try:
                scale_values = json.loads(q.scale_values)
            except (json.JSONDecodeError, TypeError) as e:
                logger.warning("Failed to parse scale_values JSON for column %s during append: %s", q.id, e)
        col_meta[q.id] = {
            "column_type": qtype,
            "scale_labels": scale_labels,
            "scale_values": scale_values,
        }

    # Generate batch ID
    file_name = file.filename or "unknown"
    batch_id = f"append_{datetime.now(timezone.utc).isoformat()}_{file_name}"
    if len(batch_id) > 255:
        batch_id = batch_id[:255]

    # Process rows
    rows_created = 0
    values_created = 0
    duplicates_skipped = 0
    new_row_ids: list[int] = []

    for row_idx, row in enumerate(csv_rows):
        # Build fingerprint
        fp_parts: list[tuple[int, str]] = []
        for col_idx, q in col_mapping.items():
            cell = row[col_idx].strip() if col_idx < len(row) else ""
            fp_parts.append((q.id, cell.lower()))
        fp = tuple(sorted(fp_parts))

        if config.skip_duplicates and fp in existing_fingerprints:
            duplicates_skipped += 1
            continue

        # Create row
        rid = f"R{str(next_num).zfill(pad_width)}"
        next_num += 1

        new_row = DatasetRow(
            dataset_id=dataset_id,
            participant_id=None,
            row_identifier=rid,
            import_batch=batch_id,
            submitted_at=None,
        )
        db.add(new_row)
        db.flush()
        new_row_ids.append(new_row.id)
        rows_created += 1

        # Add to fingerprint set to detect dupes within this batch
        existing_fingerprints.add(fp)

        # Create values
        for col_idx, q in col_mapping.items():
            cell = row[col_idx].strip() if col_idx < len(row) else ""
            if not cell:
                continue

            meta = col_meta[q.id]
            value_numeric = _compute_value_numeric(
                cell, meta["column_type"], meta["scale_labels"], meta["scale_values"],
            )

            wc = len(cell.split()) if meta["column_type"] == "open_text" and cell.strip() else None

            db.add(DatasetValue(
                row_id=new_row.id,
                column_id=q.id,
                value_text=cell,
                value_numeric=value_numeric,
                word_count=wc,
            ))
            values_created += 1

    db.flush()

    # Re-apply each column's PRIMARY recode scoped to the new rows, mirroring
    # routers/recode.py::_recompute_primary_value_numeric's apply-vs-clear
    # decision (the #359 seam). #538: filtering to SCALE_MAP here left a
    # REVERSE-primary column's appended rows FORWARD-coded while every existing
    # row was reversed — same label, two numbers in one column; and a
    # category_group primary means the column carries NO numeric encoding, so
    # new rows must be cleared, not stamped with the raw scale codes.
    if new_row_ids:
        primary_defs = (
            db.query(RecodeDefinition)
            .filter(
                RecodeDefinition.column_id.in_(column_ids_in_mapping),
                RecodeDefinition.is_primary == True,
            )
            .all()
        )
        for defn in primary_defs:
            if defn.recode_type in (RecodeType.SCALE_MAP, RecodeType.REVERSE):
                apply_definition_to_column(db, defn, row_ids=new_row_ids)
            else:  # category_group → categorical output only
                clear_value_numeric(db, defn.column_id, row_ids=new_row_ids)

    # Evaluate computed columns for new rows
    if new_row_ids:
        computed_cols = (
            db.query(DatasetColumn)
            .filter(
                DatasetColumn.dataset_id == dataset_id,
                DatasetColumn.expression.isnot(None),
            )
            .all()
        )
        for cc in computed_cols:
            try:
                evaluate_computed_column(db, cc, row_ids=new_row_ids)
            except Exception:
                logger.warning("Failed to evaluate computed column %s during append", cc.id)

    # #414 (DEC-7): link the NEW rows by the identifier column. `is not None`
    # is load-bearing (falsy-zero); runs even when new_row_ids is empty so the
    # response shape is consistent (an all-duplicates append reports zeros).
    participant_link_report = None
    if config.participant_link_column_id is not None:
        try:
            participant_link_report = link_rows_by_identifier_column(
                db,
                project_id=project_id,
                dataset_id=dataset_id,
                column_id=config.participant_link_column_id,
                row_ids=new_row_ids,
            )
        except ValueError as e:
            db.rollback()
            raise HTTPException(status_code=400, detail=str(e))

    # Compute next record ID for response
    final_next_rid = f"R{str(next_num).zfill(pad_width)}"

    # Mark affected metrics stale
    all_col_ids = [
        c[0] for c in db.query(DatasetColumn.id)
        .filter(DatasetColumn.dataset_id == dataset_id)
        .all()
    ]
    if all_col_ids:
        mark_metrics_stale(db, project_id, column_ids=all_col_ids)

    log_action(
        db,
        action="dataset_append_imported",
        entity_type="dataset",
        entity_id=dataset_id,
        user_id=user.id,
        project_id=project_id,
        details={
            "batch_id": batch_id,
            "rows_created": rows_created,
            "values_created": values_created,
            "duplicates_skipped": duplicates_skipped,
            "file_name": file_name,
            # #414: record what linking did when it ran
            **(
                {
                    "participants_linked": participant_link_report["linked"],
                    "participants_created": participant_link_report["created"],
                }
                if participant_link_report
                else {}
            ),
        },
    )
    db.commit()

    return DatasetAppendResponse(
        rows_created=rows_created,
        values_created=values_created,
        duplicates_skipped=duplicates_skipped,
        batch_id=batch_id,
        next_row_id=final_next_rid,
        participant_link_report=participant_link_report,
    )
