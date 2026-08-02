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
    ApplyValueLabelsRequest,
    ApplyValueLabelsResponse,
    MissingValuesUpdate,
    MissingValuesResponse,
)
from ..services.value_labels import apply_value_labels, ValueLabelsBlockedError
from ..services.missing_declaration import (
    MissingRuleCollisionError,
    apply_missing_declaration,
)
from ..services.missing_values import parse_missing_rules
from ..services.recode import (
    apply_definition_to_column,
    get_value_frequencies,
    get_unmapped_values,
    clear_value_numeric,
    recompute_primary_value_numeric as _recompute_primary_value_numeric,
    write_back_scale_metadata as _write_back_scale_metadata,
)
from ..services.audit import log_action

from ..services.staleness import mark_metrics_stale
from .helpers import _get_project_or_404

logger = logging.getLogger(__name__)

router = APIRouter(tags=["recode"])


# ── Helpers ──────────────────────────────────────────────────────────────────


def _get_column_or_404(
    db: Session, project_id: int, dataset_id: int, column_id: int, user_id: int,
) -> DatasetColumn:
    """Load a dataset column, gating on project ownership first (#553).

    Same shape as ``helpers._get_dataset_or_404``: every recode endpoint reaches
    its column through here (including ``copy_to``, which rewrites value_numeric
    across a whole column), so the gate lives in the helper, not the call sites.
    """
    _get_project_or_404(db, project_id, user_id)
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


# ``_recompute_primary_value_numeric`` / ``_write_back_scale_metadata`` moved to
# services/recode.py (2026-07-14, #578) so the service layer owns the apply-vs-clear
# decision and the startup reverse-mapping repair can reuse it. Imported (aliased to
# the old private names) at the top of this module — every callsite below is unchanged.


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
    _get_column_or_404(db, project_id, dataset_id, column_id, user.id)

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
    col = _get_column_or_404(db, project_id, dataset_id, column_id, user.id)

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
    _get_column_or_404(db, project_id, dataset_id, column_id, user.id)
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
    _get_column_or_404(db, project_id, dataset_id, column_id, user.id)
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
    _get_column_or_404(db, project_id, dataset_id, column_id, user.id)
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
    _get_column_or_404(db, project_id, dataset_id, column_id, user.id)
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

        # A copy that lands as the target's primary must go through the
        # central apply-vs-clear decision (#548 — this was the one
        # primary-changing callsite left on the pre-#542 SCALE_MAP-only
        # shape): REVERSE applies with its own reflection, CATEGORY_GROUP
        # clears stale numerics, and numeric primaries write the mapping
        # back to the target's scale metadata (#542a). Non-primary copies
        # never touch value_numeric.
        if new_def.is_primary:
            _recompute_primary_value_numeric(db, new_def, target_col_id)

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
    _get_column_or_404(db, project_id, dataset_id, column_id, user.id)

    freqs = get_value_frequencies(db, column_id)

    return ColumnFrequenciesResponse(
        column_id=column_id,
        frequencies=[ValueFrequency(**f) for f in freqs],
        total=sum(f["count"] for f in freqs),
    )


# ── Value labels (#576/#577) ─────────────────────────────────────────────────


@router.post(
    "/api/projects/{project_id}/datasets/{dataset_id}/columns/{column_id}/value-labels",
    response_model=ApplyValueLabelsResponse,
)
async def apply_value_labels_endpoint(
    project_id: int,
    dataset_id: int,
    column_id: int,
    data: ApplyValueLabelsRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Declare a code→label dictionary for a numbers-only column (#576/#577).

    Substitutes the label into ``value_text`` (keeping the code in
    ``value_numeric``), sets the column's scale metadata + a primary scale_map,
    and optionally the column type — making the column byte-identical to a
    labelled SPSS import, so every analysis surface shows labels with no other
    change. Returns any observed codes the researcher did not label.
    """
    col = _get_column_or_404(db, project_id, dataset_id, column_id, user.id)

    if col.source == "computed":
        raise HTTPException(
            status_code=403, detail="Value labels cannot be applied to computed columns",
        )
    if col.column_type in (ColumnType.OPEN_TEXT, ColumnType.IDENTIFIER):
        raise HTTPException(
            status_code=400,
            detail=f"Value labels cannot be applied to {col.column_type.value} columns",
        )

    pairs = [(p.value, p.label.strip()) for p in data.labels]
    target_type = ColumnType(data.column_type) if data.column_type else None

    try:
        result = apply_value_labels(db, col, pairs, target_type)
    except ValueLabelsBlockedError as e:
        # A REVERSE primary means value_numeric is a reflected score, not the
        # code — relabelling would rewrite every response to its opposite.
        raise HTTPException(status_code=400, detail=str(e))

    mark_metrics_stale(db, project_id, column_ids=[column_id])
    log_action(
        db,
        action="applied_value_labels",
        entity_type="dataset_column",
        entity_id=column_id,
        user_id=user.id,
        project_id=project_id,
        details={"count": len(pairs), "updated": result["updated"]},
    )
    db.commit()

    return ApplyValueLabelsResponse(column_id=column_id, **result)


@router.put(
    "/api/projects/{project_id}/datasets/{dataset_id}/columns/{column_id}/missing-values",
    response_model=MissingValuesResponse,
)
async def set_missing_values(
    project_id: int,
    dataset_id: int,
    column_id: int,
    data: MissingValuesUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Declare (or clear) which values are MISSING for this column (#592).

    The labels-optional path (§I.6b): a missing-only declaration on a numeric
    column touches NO scale metadata, NO primary recode, and never the column
    type. ``rules: null`` un-declares (the recognized-N/A defaults apply
    again); ``rules: []`` declares that NOTHING is missing. Cells re-align in
    the same transaction: newly-missing values NULL their ``value_numeric``,
    newly-substantive values recover theirs (a labelled-missing pair reverts
    to its raw code text — J-D3), and a numeric primary re-applies so a
    reverse recode's stored scores track the new offset (#603). A rule whose
    LABEL collides with text that means something else on the column — another
    rule, a different code's scale label, an observed response — is refused
    (400) before any write (#606). (The old reverse-mapping-intersection
    refusal is GONE — dropped with #600/#601; the offset filter made that
    state unwritable.)
    """
    col = _get_column_or_404(db, project_id, dataset_id, column_id, user.id)

    if col.source == "computed":
        raise HTTPException(
            status_code=403,
            detail="Missing values cannot be declared on computed columns",
        )
    if col.column_type in (ColumnType.OPEN_TEXT, ColumnType.IDENTIFIER):
        raise HTTPException(
            status_code=400,
            detail=f"Missing values cannot be declared on {col.column_type.value} columns",
        )

    try:
        result = apply_missing_declaration(db, col, data.rules)
    except MissingRuleCollisionError as e:
        raise HTTPException(status_code=400, detail=str(e))

    mark_metrics_stale(db, project_id, column_ids=[column_id])
    log_action(
        db,
        action="set_missing_values",
        entity_type="dataset_column",
        entity_id=column_id,
        user_id=user.id,
        project_id=project_id,
        details={
            "rules": len(data.rules) if data.rules is not None else None,
            "nulled_rows": result["nulled_rows"],
            "recovered_rows": result["recovered_rows"],
        },
    )
    db.commit()

    return MissingValuesResponse(
        column_id=column_id,
        missing_values=parse_missing_rules(col.missing_values),
        **result,
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
