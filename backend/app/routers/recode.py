"""Recode definition endpoints for dataset column variable transformations."""

import json
import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func as sa_func
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..database import get_db
from ..models.user import User
from ..models.dataset import Dataset, DatasetColumn, DatasetValue, ColumnType
from ..models.code_application import CodeApplication
from ..models.recode import RecodeDefinition, RecodeType, OutputType
from ..schemas.recode import (
    RecodeDefinitionCreate,
    RecodeDefinitionUpdate,
    RecodeDefinitionResponse,
    CopyToRequest,
    CopyToResponse,
    BulkTypeUpdateRequest,
    ValueFrequency,
    ColumnFrequenciesResponse,
)
from ..services.dataset_import import _coerce_scale_codes
from ..services.recode import (
    apply_definition_to_column,
    get_value_frequencies,
    get_unmapped_values,
    clear_value_numeric,
)
from ..services.audit import log_action

from ..services.staleness import mark_metrics_stale
from .helpers import _get_project_or_404

logger = logging.getLogger(__name__)

router = APIRouter(tags=["recode"])


# ── Helpers ──────────────────────────────────────────────────────────────────


def _get_column_or_404(
    db: Session, project_id: int, dataset_id: int, column_id: int,
) -> DatasetColumn:
    col = (
        db.query(DatasetColumn)
        .join(Dataset)
        .filter(
            DatasetColumn.id == column_id,
            DatasetColumn.dataset_id == dataset_id,
            Dataset.project_id == project_id,
        )
        .first()
    )
    if not col:
        raise HTTPException(status_code=404, detail="Column not found")
    return col


def _get_definition_or_404(
    db: Session, column_id: int, definition_id: int,
) -> RecodeDefinition:
    definition = (
        db.query(RecodeDefinition)
        .filter(
            RecodeDefinition.id == definition_id,
            RecodeDefinition.column_id == column_id,
        )
        .first()
    )
    if not definition:
        raise HTTPException(status_code=404, detail="Recode definition not found")
    return definition


def _definition_to_response(
    definition: RecodeDefinition,
    db: Session,
) -> RecodeDefinitionResponse:
    """Convert a RecodeDefinition ORM object to response schema."""
    mapping = {}
    try:
        mapping = json.loads(definition.mapping) if definition.mapping else {}
    except (json.JSONDecodeError, TypeError) as e:
        logger.warning("Corrupted mapping JSON in RecodeDefinition %d: %s", definition.id, e)

    exclude_values = None
    try:
        if definition.exclude_values:
            exclude_values = json.loads(definition.exclude_values)
    except (json.JSONDecodeError, TypeError) as e:
        logger.warning("Corrupted exclude_values JSON in RecodeDefinition %d: %s", definition.id, e)

    unmapped = get_unmapped_values(db, definition.column_id, definition)

    return RecodeDefinitionResponse(
        id=definition.id,
        column_id=definition.column_id,
        name=definition.name,
        recode_type=definition.recode_type.value if hasattr(definition.recode_type, "value") else str(definition.recode_type),
        output_type=definition.output_type.value if hasattr(definition.output_type, "value") else str(definition.output_type),
        mapping=mapping,
        exclude_values=exclude_values,
        is_primary=bool(definition.is_primary),
        is_auto_detected=bool(definition.is_auto_detected),
        source_definition_id=definition.source_definition_id,
        sequence_order=definition.sequence_order,
        created_at=definition.created_at,
        updated_at=definition.updated_at,
        unmapped_values=unmapped,
    )


def _write_back_scale_metadata(
    db: Session, definition: RecodeDefinition, column_id: int,
) -> None:
    """Keep ``column.scale_labels``/``scale_values`` in step with the primary
    mapping on ordinal columns (#542a — owner-2 of the #28 three-owner
    invariant).

    Every consumer prefers the primary mapping while it exists (append re-apply,
    R export priority 1), so a stale copy is invisible — until the definition is
    DELETED and consumers fall back to the column metadata, which then carries
    the pre-edit codes while ``value_numeric`` carries the post-edit ones.

    The mapping is ``{label: code}``; for REVERSE those are the FORWARD codes
    (reversal happens at apply time), which is exactly what the append stamp and
    R export expect. Non-numeric values are skipped per value (#542b semantics);
    if no numeric pairs remain the existing metadata is left alone rather than
    destroyed. Codes store as ints when integral (the #28 int/float parity rule
    — ``_coerce_scale_codes``).
    """
    column = db.query(DatasetColumn).filter(DatasetColumn.id == column_id).first()
    if column is None or column.column_type != ColumnType.ORDINAL:
        return
    try:
        mapping = json.loads(definition.mapping) if definition.mapping else {}
    except (json.JSONDecodeError, TypeError):
        return
    pairs: list[tuple[str, float]] = []
    for label, code in mapping.items():
        try:
            pairs.append((str(label), float(code)))
        except (ValueError, TypeError):
            continue
    if not pairs:
        return
    pairs.sort(key=lambda p: p[1])
    column.scale_labels = json.dumps([label for label, _ in pairs])
    column.scale_values = json.dumps(_coerce_scale_codes([code for _, code in pairs]))
    column.scale_points = len(pairs)


def _recompute_primary_value_numeric(
    db: Session, definition: RecodeDefinition, column_id: int,
) -> None:
    """Recompute (or clear) ``value_numeric`` for a column from its primary recode.

    SCALE_MAP and REVERSE both produce numeric output and must be *applied* to the
    column's stored values — REVERSE carries its own ``{label: numeric}`` mapping and
    performs the reversal internally (``services/recode.py::apply_definition_to_column``).
    CATEGORY_GROUP produces categorical output, so ``value_numeric`` is cleared.

    Centralized here so every primary-changing callsite (create, update, set-primary,
    delete-then-promote) shares one apply-vs-clear decision. The #359 bug was exactly
    these callsites drifting apart — REVERSE was applied in none of them, silently
    leaving reverse-scored subscales un-reversed (e.g. Cronbach's α collapsing because
    negatively-worded items were never flipped). #542a: applying a numeric primary
    also writes the mapping back to the column's scale metadata (see
    ``_write_back_scale_metadata``).
    """
    rtype = definition.recode_type
    if hasattr(rtype, "value"):
        rtype = rtype.value
    if rtype in ("scale_map", "reverse"):
        apply_definition_to_column(db, definition)
        _write_back_scale_metadata(db, definition, column_id)
    else:  # category_group → no numeric output
        clear_value_numeric(db, column_id)


# ── CRUD endpoints ───────────────────────────────────────────────────────────


@router.get(
    "/api/projects/{project_id}/datasets/{dataset_id}/columns/{column_id}/recodes",
    response_model=list[RecodeDefinitionResponse],
)
async def list_definitions(
    project_id: int,
    dataset_id: int,
    column_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """List recode definitions for a column, ordered by sequence_order."""
    _get_column_or_404(db, project_id, dataset_id, column_id)

    definitions = (
        db.query(RecodeDefinition)
        .filter(RecodeDefinition.column_id == column_id)
        .order_by(RecodeDefinition.sequence_order)
        .all()
    )

    return [_definition_to_response(d, db) for d in definitions]


@router.post(
    "/api/projects/{project_id}/datasets/{dataset_id}/columns/{column_id}/recodes",
    response_model=RecodeDefinitionResponse,
)
async def create_definition(
    project_id: int,
    dataset_id: int,
    column_id: int,
    data: RecodeDefinitionCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create a new recode definition for a column."""
    col = _get_column_or_404(db, project_id, dataset_id, column_id)

    # Reject recode on computed columns
    if col.source == "computed":
        raise HTTPException(
            status_code=403,
            detail="Recode definitions cannot be created for computed columns",
        )

    # Reject recode on open-ended and identifier column types (#414)
    if col.column_type in (ColumnType.OPEN_TEXT, ColumnType.IDENTIFIER):
        raise HTTPException(
            status_code=400,
            detail=f"Recode definitions cannot be created for {col.column_type.value} columns",
        )

    # Validate recode_type and output_type
    try:
        recode_type = RecodeType(data.recode_type)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid recode_type: {data.recode_type}")
    try:
        output_type = OutputType(data.output_type)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid output_type: {data.output_type}")

    # Auto sequence_order: max + 1
    max_seq = (
        db.query(RecodeDefinition.sequence_order)
        .filter(RecodeDefinition.column_id == column_id)
        .order_by(RecodeDefinition.sequence_order.desc())
        .first()
    )
    next_seq = (max_seq[0] + 1) if max_seq else 0

    # Check if this should be primary (first definition or no existing primary)
    existing_primary = (
        db.query(RecodeDefinition)
        .filter(
            RecodeDefinition.column_id == column_id,
            RecodeDefinition.is_primary == True,
        )
        .first()
    )
    is_primary = existing_primary is None

    definition = RecodeDefinition(
        column_id=column_id,
        name=data.name,
        recode_type=recode_type,
        output_type=output_type,
        mapping=json.dumps(data.mapping),
        exclude_values=json.dumps(data.exclude_values) if data.exclude_values else None,
        is_primary=is_primary,
        is_auto_detected=False,
        source_definition_id=data.source_definition_id,
        sequence_order=next_seq,
    )
    db.add(definition)
    db.flush()

    # Route through the SHARED apply-vs-clear decision (#359/#542a): scale_map
    # and reverse apply (+ write scale metadata back); a category_group primary
    # clears value_numeric — previously create skipped the clear, so a
    # categorical primary created FIRST on a stamped column silently left the
    # numeric encoding behind (the exact callsite drift the helper exists for).
    if is_primary:
        _recompute_primary_value_numeric(db, definition, column_id)

    mark_metrics_stale(db, project_id, column_ids=[column_id])

    log_action(
        db,
        action="created",
        entity_type="recode_definition",
        entity_id=definition.id,
        user_id=user.id,
        project_id=project_id,
        details={"name": definition.name, "column_id": column_id},
    )
    db.commit()
    db.refresh(definition)

    return _definition_to_response(definition, db)


@router.patch(
    "/api/projects/{project_id}/datasets/{dataset_id}/columns/{column_id}/recodes/{definition_id}",
    response_model=RecodeDefinitionResponse,
)
async def update_definition(
    project_id: int,
    dataset_id: int,
    column_id: int,
    definition_id: int,
    data: RecodeDefinitionUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Update a recode definition."""
    _get_column_or_404(db, project_id, dataset_id, column_id)
    definition = _get_definition_or_404(db, column_id, definition_id)

    update_data = data.model_dump(exclude_unset=True)

    if "recode_type" in update_data:
        try:
            update_data["recode_type"] = RecodeType(update_data["recode_type"])
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid recode_type")

    if "output_type" in update_data:
        try:
            update_data["output_type"] = OutputType(update_data["output_type"])
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid output_type")

    if "mapping" in update_data:
        update_data["mapping"] = json.dumps(update_data["mapping"])

    if "exclude_values" in update_data:
        ev = update_data["exclude_values"]
        update_data["exclude_values"] = json.dumps(ev) if ev else None

    # Handle primary flag changes
    if "is_primary" in update_data and update_data["is_primary"]:
        # Clear other primaries for this column
        db.query(RecodeDefinition).filter(
            RecodeDefinition.column_id == column_id,
            RecodeDefinition.id != definition_id,
            RecodeDefinition.is_primary == True,
        ).update({RecodeDefinition.is_primary: False}, synchronize_session="fetch")

    # Mark as no longer auto-detected once manually edited
    definition.is_auto_detected = False

    for field, value in update_data.items():
        setattr(definition, field, value)

    db.flush()

    # Recompute value_numeric if this is the primary (#359: includes reverse)
    if definition.is_primary:
        _recompute_primary_value_numeric(db, definition, column_id)
    elif "is_primary" in update_data and not update_data["is_primary"]:
        # Was explicitly set to non-primary; check if any primary remains
        has_primary = (
            db.query(RecodeDefinition)
            .filter(
                RecodeDefinition.column_id == column_id,
                RecodeDefinition.is_primary == True,
            )
            .first()
        )
        if not has_primary:
            clear_value_numeric(db, column_id)

    mark_metrics_stale(db, project_id, column_ids=[column_id])

    log_action(
        db,
        action="updated",
        entity_type="recode_definition",
        entity_id=definition.id,
        user_id=user.id,
        project_id=project_id,
        details={"name": definition.name, "column_id": column_id},
    )
    db.commit()
    db.refresh(definition)

    return _definition_to_response(definition, db)


@router.delete(
    "/api/projects/{project_id}/datasets/{dataset_id}/columns/{column_id}/recodes/{definition_id}",
)
async def delete_definition(
    project_id: int,
    dataset_id: int,
    column_id: int,
    definition_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Delete a recode definition. Clears value_numeric if it was primary."""
    _get_column_or_404(db, project_id, dataset_id, column_id)
    definition = _get_definition_or_404(db, column_id, definition_id)

    was_primary = bool(definition.is_primary)
    def_name = definition.name

    log_action(
        db,
        action="deleted",
        entity_type="recode_definition",
        entity_id=definition.id,
        user_id=user.id,
        project_id=project_id,
        details={"name": def_name, "column_id": column_id},
    )

    db.delete(definition)
    db.flush()

    if was_primary:
        # Check if another definition exists to promote, else clear
        next_def = (
            db.query(RecodeDefinition)
            .filter(RecodeDefinition.column_id == column_id)
            .order_by(RecodeDefinition.sequence_order)
            .first()
        )
        if next_def:
            next_def.is_primary = True
            _recompute_primary_value_numeric(db, next_def, column_id)
        else:
            clear_value_numeric(db, column_id)

    mark_metrics_stale(db, project_id, column_ids=[column_id])
    db.commit()

    return {"status": "ok", "deleted_id": definition_id}


# ── Set primary ──────────────────────────────────────────────────────────────


@router.post(
    "/api/projects/{project_id}/datasets/{dataset_id}/columns/{column_id}/recodes/{definition_id}/set-primary",
    response_model=RecodeDefinitionResponse,
)
async def set_primary(
    project_id: int,
    dataset_id: int,
    column_id: int,
    definition_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Set a definition as the primary for its column. Recomputes value_numeric."""
    _get_column_or_404(db, project_id, dataset_id, column_id)
    definition = _get_definition_or_404(db, column_id, definition_id)

    # Clear other primaries
    db.query(RecodeDefinition).filter(
        RecodeDefinition.column_id == column_id,
        RecodeDefinition.id != definition_id,
    ).update({RecodeDefinition.is_primary: False}, synchronize_session="fetch")

    definition.is_primary = True
    db.flush()

    # Recompute value_numeric (#359: reverse applies like scale_map, not clear)
    _recompute_primary_value_numeric(db, definition, column_id)

    mark_metrics_stale(db, project_id, column_ids=[column_id])
    db.commit()
    db.refresh(definition)

    return _definition_to_response(definition, db)


# ── Copy-to ──────────────────────────────────────────────────────────────────


@router.post(
    "/api/projects/{project_id}/datasets/{dataset_id}/columns/{column_id}/recodes/{definition_id}/copy-to",
    response_model=CopyToResponse,
)
async def copy_to(
    project_id: int,
    dataset_id: int,
    column_id: int,
    definition_id: int,
    data: CopyToRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Clone a recode definition to target columns. Skips if same-name exists."""
    _get_column_or_404(db, project_id, dataset_id, column_id)
    source = _get_definition_or_404(db, column_id, definition_id)

    mapping = source.mapping
    exclude_values = source.exclude_values

    created = 0
    skipped = 0
    skipped_columns = []

    for target_col_id in data.target_column_ids:
        if target_col_id == column_id:
            skipped += 1
            skipped_columns.append(target_col_id)
            continue

        # Verify target column belongs to the same dataset
        target_col = (
            db.query(DatasetColumn)
            .filter(
                DatasetColumn.id == target_col_id,
                DatasetColumn.dataset_id == dataset_id,
            )
            .first()
        )
        if not target_col:
            skipped += 1
            skipped_columns.append(target_col_id)
            continue

        # Check for same-name definition
        existing = (
            db.query(RecodeDefinition)
            .filter(
                RecodeDefinition.column_id == target_col_id,
                RecodeDefinition.name == source.name,
            )
            .first()
        )
        if existing:
            skipped += 1
            skipped_columns.append(target_col_id)
            continue

        # Auto sequence_order
        max_seq = (
            db.query(RecodeDefinition.sequence_order)
            .filter(RecodeDefinition.column_id == target_col_id)
            .order_by(RecodeDefinition.sequence_order.desc())
            .first()
        )
        next_seq = (max_seq[0] + 1) if max_seq else 0

        # Check if target has a primary
        has_primary = (
            db.query(RecodeDefinition)
            .filter(
                RecodeDefinition.column_id == target_col_id,
                RecodeDefinition.is_primary == True,
            )
            .first()
        )

        new_def = RecodeDefinition(
            column_id=target_col_id,
            name=source.name,
            recode_type=source.recode_type,
            output_type=source.output_type,
            mapping=mapping,
            exclude_values=exclude_values,
            is_primary=has_primary is None,
            is_auto_detected=False,
            source_definition_id=source.id,
            sequence_order=next_seq,
        )
        db.add(new_def)
        db.flush()

        # If became primary scale_map, apply
        if new_def.is_primary:
            rtype = new_def.recode_type
            if hasattr(rtype, "value"):
                rtype = rtype.value
            if rtype == "scale_map":
                apply_definition_to_column(db, new_def)

        created += 1

    affected = [column_id] + [c for c in data.target_column_ids if c not in skipped_columns]
    mark_metrics_stale(db, project_id, column_ids=affected)
    db.commit()

    return CopyToResponse(
        created=created,
        skipped=skipped,
        skipped_columns=skipped_columns,
    )


# ── Frequencies ──────────────────────────────────────────────────────────────


@router.get(
    "/api/projects/{project_id}/datasets/{dataset_id}/columns/{column_id}/frequencies",
    response_model=ColumnFrequenciesResponse,
)
async def column_frequencies(
    project_id: int,
    dataset_id: int,
    column_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get value frequency distribution for a column."""
    _get_column_or_404(db, project_id, dataset_id, column_id)

    freqs = get_value_frequencies(db, column_id)

    return ColumnFrequenciesResponse(
        column_id=column_id,
        frequencies=[ValueFrequency(**f) for f in freqs],
        total=sum(f["count"] for f in freqs),
    )


# ── Bulk type update ─────────────────────────────────────────────────────────


@router.patch(
    "/api/projects/{project_id}/datasets/{dataset_id}/columns/bulk-type",
)
async def bulk_type_update(
    project_id: int,
    dataset_id: int,
    data: BulkTypeUpdateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Bulk update column_type for multiple columns."""
    _get_project_or_404(db, project_id, user.id)

    try:
        new_type = ColumnType(data.column_type)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid column_type: {data.column_type}")

    # Guard: prevent reclassifying coded comment columns away from open_text.
    # Intentionally any-layer (no non_consensus_filter): this is an existence
    # guard — a column with ANY coding, including consensus-derived, must not be
    # silently reclassified. Origin-filtering here would only weaken the guard.
    comment_types = {ColumnType.OPEN_TEXT}
    if new_type not in comment_types:
        coded_col_ids = (
            db.query(DatasetColumn.id)
            .join(Dataset)
            .join(DatasetValue, DatasetValue.column_id == DatasetColumn.id)
            .join(CodeApplication, CodeApplication.dataset_value_id == DatasetValue.id)
            .filter(
                DatasetColumn.id.in_(data.column_ids),
                DatasetColumn.dataset_id == dataset_id,
                Dataset.project_id == project_id,
                DatasetColumn.column_type.in_([qt.value for qt in comment_types]),
            )
            .distinct()
            .all()
        )
        if coded_col_ids:
            names = [str(r[0]) for r in coded_col_ids]
            raise HTTPException(
                status_code=409,
                detail=f"Cannot change type: columns {', '.join(names)} have coded comments. Remove comment codes first.",
            )

    # Tier 3 Session A Task 1.6 / GAP 3.9 — reject bulk type changes on columns
    # that have recode definitions. Mirrors the guard in `dataset.py:1506` for
    # `update_manual_column` but scaled to bulk input. Without this, researchers
    # can silently leave reverse recodes keyed to the old column type and hit
    # confusing metric-compute errors later. The router-scoped filter ensures
    # we only check columns in THIS dataset (bulk_type_update is dataset-scoped
    # per directive foot-gun — see GAP 3.7).
    recode_rows = (
        db.query(RecodeDefinition.column_id, sa_func.count(RecodeDefinition.id))
        .join(DatasetColumn, DatasetColumn.id == RecodeDefinition.column_id)
        .filter(
            RecodeDefinition.column_id.in_(data.column_ids),
            DatasetColumn.dataset_id == dataset_id,
        )
        .group_by(RecodeDefinition.column_id)
        .all()
    )
    if recode_rows:
        recode_counts = {str(cid): int(cnt) for cid, cnt in recode_rows}
        raise HTTPException(
            status_code=409,
            detail={
                "error": "recode_definitions_exist",
                "message": "Cannot change type: columns have recode definitions.",
                "column_ids": sorted([cid for cid, _ in recode_rows]),
                "recode_counts": recode_counts,
            },
        )

    updated = 0
    for col_id in data.column_ids:
        col = (
            db.query(DatasetColumn)
            .join(Dataset)
            .filter(
                DatasetColumn.id == col_id,
                DatasetColumn.dataset_id == dataset_id,
                Dataset.project_id == project_id,
            )
            .first()
        )
        if col:
            col.column_type = new_type
            if new_type != ColumnType.DEMOGRAPHIC:
                col.demographic_subtype = None
            updated += 1

    db.flush()
    mark_metrics_stale(db, project_id, column_ids=data.column_ids)

    log_action(
        db,
        action="bulk_type_update",
        entity_type="dataset_column",
        entity_id=dataset_id,
        user_id=user.id,
        project_id=project_id,
        details={
            "column_ids": data.column_ids,
            "new_type": data.column_type,
            "updated": updated,
        },
    )
    db.commit()

    return {"status": "ok", "updated": updated}


# ── Tier 3 crosswalk — reverse-scored column lookup (Task 1.7 / GAP 3.6) ────


@router.get("/api/projects/{project_id}/reverse-scored-columns")
async def list_reverse_scored_columns(
    project_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Return the set of column IDs in this project that have any recode
    definition with `recode_type='reverse'`.

    Consumed by the Tier 3 crosswalk's `['reverse-columns', projectId]` query
    to render the ⟲ badge on reverse-scored cells. Phase 6.2 wires the
    invalidation in `RecodeWorkbench.tsx` createMutation/updateMutation/
    deleteMutation/copyToMutation so the badge stays fresh after recode edits.
    """
    _get_project_or_404(db, project_id, user.id)

    column_ids = [
        row[0]
        for row in (
            db.query(RecodeDefinition.column_id)
            .join(DatasetColumn, DatasetColumn.id == RecodeDefinition.column_id)
            .join(Dataset, Dataset.id == DatasetColumn.dataset_id)
            .filter(
                Dataset.project_id == project_id,
                RecodeDefinition.recode_type == RecodeType.REVERSE,
            )
            .distinct()
            .all()
        )
    ]

    return {"column_ids": sorted(column_ids)}
