"""Recode definition endpoints for dataset column variable transformations."""

import json
import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func as sa_func
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..database import get_db
from ..models.user import User
from ..models.dataset import (
    Dataset,
    DatasetColumn,
    DatasetValue,
    ColumnType,
    VALUE_LABEL_INELIGIBLE_TYPES,
)
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
    BulkMissingValuesSkip,
    BulkMissingValuesResponse,
    BulkMissingValuesUpdate,
    RecodeDependentInfo,
    RederivePlanItem,
    RederiveRequest,
    RederiveResponse,
    RekeyPlanItem,
    RekeyRequest,
    RekeyResponse,
    DerivePlanResponse,
    DeriveLabelCarryPlan,
    DeriveColumnRequest,
    DeriveColumnResponse,
)
from ..services.recode_dependents import (
    dependents_of_definition,
    dead_definitions_for_column,
)
from ..services.recode_rederive import (
    plan_rederive,
    apply_rederive,
    RederiveBlockedError,
)
from ..services.recode_rekey import (
    plan_rekey,
    apply_rekey,
    RekeyBlockedError,
)
from ..services.value_labels import apply_value_labels, ValueLabelsBlockedError
from ..services.derive_column import (
    plan_derived_column,
    derive_column,
    DeriveColumnError,
)
from ..services.missing_declaration import (
    MissingRuleCollisionError,
    apply_missing_declaration,
)
from ..services.missing_values import parse_missing_rules
from ..services.recode import (
    definition_reflection_offset,
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


_UNSET = object()


def _definition_to_response(
    definition: RecodeDefinition,
    db: Session,
    column_missing_values=_UNSET,
) -> RecodeDefinitionResponse:
    """Convert a RecodeDefinition ORM object to response schema.

    ``column_missing_values`` is the column's raw ``missing_values`` JSON, needed
    for the #602 reflection offset. Pass it when the caller already has the
    column (``list_definitions`` builds N responses for ONE column); omit it and
    a single scalar lookup happens here. The sentinel distinguishes "not supplied"
    from a genuine ``None``, which means "undeclared" and is NOT the same thing.
    """
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

    if column_missing_values is _UNSET:
        column_missing_values = (
            db.query(DatasetColumn.missing_values)
            .filter(DatasetColumn.id == definition.column_id)
            .scalar()
        )

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
        reverse_offset=definition_reflection_offset(definition, column_missing_values),
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
    col = _get_column_or_404(db, project_id, dataset_id, column_id, user.id)

    definitions = (
        db.query(RecodeDefinition)
        .filter(RecodeDefinition.column_id == column_id)
        .order_by(RecodeDefinition.sequence_order)
        .all()
    )

    # One column, N definitions — read its declaration once rather than per def.
    return [_definition_to_response(d, db, col.missing_values) for d in definitions]


@router.get(
    "/api/projects/{project_id}/datasets/{dataset_id}/columns/{column_id}"
    "/recodes/{definition_id}/dependents",
    response_model=list[RecodeDependentInfo],
)
async def list_definition_dependents(
    project_id: int,
    dataset_id: int,
    column_id: int,
    definition_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Definitions that name this one as their source — #584.

    Read-only, and deliberately its own endpoint rather than a field on the
    PATCH/DELETE response: the point is to warn BEFORE the change, and a
    warning that arrives with the result of the thing it was warning about is
    not a warning.

    A dependent may sit on a DIFFERENT column (the crosswalk copies a
    definition and records the source it came from), so this is a query on
    `source_definition_id`, never on `column_id`. Ownership is still gated on
    the column the source belongs to.

    ⚠️ A dependent is NOT broken — it carries its own frozen copy of the
    forward mapping and keeps mapping every cell. What an edit costs it is
    AGREEMENT with the source. Re-deriving is the researcher's call: it changes
    stored numbers, which this project treats as release-note-worthy when done
    deliberately (#710).
    """
    _get_column_or_404(db, project_id, dataset_id, column_id, user.id)
    _get_definition_or_404(db, column_id, definition_id)
    return [d.to_dict() for d in dependents_of_definition(db, definition_id)]


@router.get(
    "/api/projects/{project_id}/datasets/{dataset_id}/columns/{column_id}"
    "/recodes/{definition_id}/re-derive/plan",
    response_model=list[RederivePlanItem],
)
async def plan_definition_rederive(
    project_id: int,
    dataset_id: int,
    column_id: int,
    definition_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """What re-deriving from this definition would do — #584 step 2, read-only.

    Separate from the POST on purpose: the researcher is being asked to change
    stored numbers, so they get to see WHICH values move on WHICH definitions
    first. A confirm dialog that cannot name what it is about to change is not
    informed consent.
    """
    _get_column_or_404(db, project_id, dataset_id, column_id, user.id)
    source = _get_definition_or_404(db, column_id, definition_id)
    return [p.to_dict() for p in plan_rederive(db, source)]


@router.post(
    "/api/projects/{project_id}/datasets/{dataset_id}/columns/{column_id}"
    "/recodes/{definition_id}/re-derive",
    response_model=RederiveResponse,
)
async def rederive_dependents(
    project_id: int,
    dataset_id: int,
    column_id: int,
    definition_id: int,
    body: RederiveRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Copy this definition's values onto the named dependents — ALL OR NOTHING.

    ⚠️ **This changes stored numbers a researcher may already have reported**,
    which is why it is an explicit POST with an explicit id list rather than a
    button on the warning toast, and why it writes an audit entry naming exactly
    what moved.

    ⚠️ **A blocked dependent 409s the whole batch instead of being skipped.**
    Skipping would report success while leaving untouched precisely the
    definitions the researcher was trying to repair — and the blocked case is
    the crosswalk copy, i.e. the one most likely to be selected by someone who
    does not know the copy was label-remapped.
    """
    _get_column_or_404(db, project_id, dataset_id, column_id, user.id)
    source = _get_definition_or_404(db, column_id, definition_id)

    try:
        result = apply_rederive(db, source, body.definition_ids)
    except RederiveBlockedError as exc:
        # 409, not 400: the request is well-formed, the STATE refuses it.
        raise HTTPException(status_code=409, detail=str(exc))

    if result["updated"]:
        log_action(
            db,
            action="rederived",
            entity_type="recode_definition",
            entity_id=source.id,
            user_id=user.id,
            project_id=project_id,
            details={
                "source_name": source.name,
                "column_id": column_id,
                "dependent_ids": result["updated"],
                "changed_values": result["changed_values"],
            },
        )
    db.commit()
    return result


@router.get(
    "/api/projects/{project_id}/datasets/{dataset_id}/columns/{column_id}"
    "/re-key/plan",
    response_model=list[RekeyPlanItem],
)
async def plan_column_rekey(
    project_id: int,
    dataset_id: int,
    column_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """What re-keying this column's relabel-killed definitions would do — #584.

    ⚠️ **Scoped to the COLUMN, not to a definition, and that is the whole
    difference from the re-derive endpoints above.** Drift is a provenance
    question (who names this definition as their source, possibly on another
    column); death is a column question (whose keys were the text this column no
    longer carries). Measured on a five-definition column, the provenance lookup
    finds one of the four the relabel actually killed — so answering this one
    through `source_definition_id` would report a count that quietly shrinks.

    Read-only, and an empty list is the ordinary answer: nothing on this column
    is dead.
    """
    column = _get_column_or_404(db, project_id, dataset_id, column_id, user.id)
    return [p.to_dict() for p in plan_rekey(db, column)]


@router.post(
    "/api/projects/{project_id}/datasets/{dataset_id}/columns/{column_id}/re-key",
    response_model=RekeyResponse,
)
async def rekey_column_definitions(
    project_id: int,
    dataset_id: int,
    column_id: int,
    body: RekeyRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Rename the named definitions' keys to this column's labels — ALL OR NOTHING.

    ⚠️ **A blocked definition 409s the whole batch**, the same rule the re-derive
    endpoint follows and for the same reason: skipping it would report success
    while leaving untouched precisely the definition the researcher opened this
    to repair.

    ⚠️ **This can change stored numbers** — only when a re-keyed definition is
    the column's PRIMARY, but that case is exactly the one #584 warns about (a
    dead definition promoted to primary NULLs `value_numeric` column-wide), so it
    gets the same explicit confirm and audit entry as the drift arm.
    """
    column = _get_column_or_404(db, project_id, dataset_id, column_id, user.id)

    try:
        result = apply_rekey(db, column, body.definition_ids)
    except RekeyBlockedError as exc:
        # 409, not 400: the request is well-formed, the STATE refuses it.
        raise HTTPException(status_code=409, detail=str(exc))

    if result["updated"]:
        log_action(
            db,
            action="rekeyed",
            entity_type="dataset_column",
            entity_id=column_id,
            user_id=user.id,
            project_id=project_id,
            details={
                "column_name": column.column_name or column.column_text,
                "definition_ids": result["updated"],
                "renamed_keys": result["renamed_keys"],
            },
        )
    db.commit()
    return result


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
    # 🔴 **CREATING A RULE NEVER APPLIES IT (2026-08-24, design-note §8).**
    #
    # This used to read `is_primary = existing_primary is None` and then call
    # `_recompute_primary_value_numeric`, so **saving your first rule on a
    # variable silently rewrote every stored number in it** — with no prompt and
    # no undo. That was the largest of the four doors into an in-place
    # transform, and it is exactly the behaviour the developer's original report
    # described: *"MM is trying to [derive a variable] without creating a
    # separate variable."*
    #
    # ⚠️ **The mechanism is untouched** — a rule still becomes the one in effect
    # through `set_primary`, and the MACHINE-made primaries that value labels
    # (`value_labels.py`) and import (`dataset_import.py`) create are unchanged.
    # What is gone is a *user* rule applying itself as a side effect of being
    # saved. Deriving a new variable (`services/derive_column.py`) works from a
    # rule that was never applied, so this costs nothing there.
    #
    # ⚠️ `existing_primary` is still read — `_definition_to_response` and the
    # card both need to know whether anything is in effect.
    definition = RecodeDefinition(
        column_id=column_id,
        name=data.name,
        recode_type=recode_type,
        output_type=output_type,
        mapping=json.dumps(data.mapping),
        exclude_values=json.dumps(data.exclude_values) if data.exclude_values else None,
        is_primary=False,
        is_auto_detected=False,
        source_definition_id=data.source_definition_id,
        sequence_order=next_seq,
    )
    db.add(definition)
    db.flush()

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

    # 🔴 **DELETING A RULE NO LONGER TOUCHES THE STORED NUMBERS (2026-08-24).**
    #
    # This branch used to do one of two things, and both were wrong:
    #
    # * **Promote the next definition and apply it** — a silent in-place
    #   transform triggered by a DELETE. The researcher deleted one rule and a
    #   different one they never chose rewrote the column.
    # * **`clear_value_numeric`** when no other rule existed — and that one was
    #   actively destructive. The rule `apply_value_labels` creates is an
    #   ordinary listed definition with a Delete button (only a wand icon marks
    #   it), so deleting it on a LABELLED column wiped every code while leaving
    #   the labels in `value_text`: means, correlations and scale scores gone,
    #   frequencies still fine, nothing on screen saying why.
    #
    # ⚠️ **Neither is replaced, because deletion CANNOT undo an application.**
    # The pre-transform codes are not stored anywhere — that is precisely what
    # Decision D exists to fix — so "revert" is not an option this code has.
    # Leaving the numbers is the only honest behaviour: they stay exactly as the
    # rule left them, and the client says so before the delete.
    #
    # ⚠️ Consumers survive this: `write_back_scale_metadata`'s docstring already
    # names deletion as the moment they fall back to `column.scale_labels`, and
    # keeping those in step with the primary mapping is why it exists.
    #
    # `mark_metrics_stale` still fires — no cell changed, but `primary_recode`
    # rides every column payload and the R export reads the primary's
    # `exclude_values`, so what a consumer would COMPUTE has changed.
    mark_metrics_stale(db, project_id, column_ids=[column_id])
    db.commit()

    return {"status": "ok", "deleted_id": definition_id, "was_in_effect": was_primary}


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
    result = _recompute_primary_value_numeric(db, definition, column_id)

    # 🔴 #794: a definition can go STALE against its own column — applying value
    # labels rewrites `value_text`, so every mapping keyed on the old text stops
    # matching (#584 measured four of five on one realistic column). Promoting
    # such a definition used to have two outcomes, neither of them acceptable:
    # a TOTALLY stale one emitted `CASE END` and 500'd, and a PARTIALLY stale one
    # silently NULLed the cells it could not map.
    #
    # ⚠️ The refusal lives HERE, not in the service. `apply_definition_to_column`
    # is on the startup path via `repair_reverse_recode_mappings`, and #592 slab
    # 4 dropped an apply-side raise precisely because it broke boot on existing
    # data. This is the user-initiated door, and raising before `commit` rolls
    # the promotion back.
    if result is not None and result["updated"] == 0 and result["unmapped"]:
        raise HTTPException(
            status_code=400,
            detail=(
                f'"{definition.name}" no longer matches anything in this column. '
                "Its mapping is keyed on values the column no longer holds — "
                "applying value labels rewrites the cells, which is usually how "
                "this happens. Re-map it to the column's current values before "
                "making it the rule in effect."
            ),
        )

    mark_metrics_stale(db, project_id, column_ids=[column_id])
    db.commit()
    db.refresh(definition)

    # A PARTIAL match is allowed and disclosed, never silent: the cells it could
    # not map are now NULL, which is defensible (an unmapped value has no code)
    # and is exactly what the append path already reports as `unmapped_values`.
    response = _definition_to_response(definition, db)
    response.unmapped_values = sorted(result["unmapped"]) if result else []
    return response


# ── Derive a new variable (Decision B) ───────────────────────────────────────


@router.get(
    "/api/projects/{project_id}/datasets/{dataset_id}/columns/{column_id}/recodes/{definition_id}/derive-plan",
    response_model=DerivePlanResponse,
)
async def derive_column_plan(
    project_id: int,
    dataset_id: int,
    column_id: int,
    definition_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """What deriving this rule into a new variable WOULD do. Read-only."""
    col = _get_column_or_404(db, project_id, dataset_id, column_id, user.id)
    definition = _get_definition_or_404(db, column_id, definition_id)
    plan = plan_derived_column(db, col, definition)
    return DerivePlanResponse(
        output_type=plan.output_type,
        column_type=plan.column_type,
        mapped=plan.mapped,
        unmapped_values=plan.unmapped,
        missing_values_carried=plan.null_set,
        labels=DeriveLabelCarryPlan(
            available=plan.labels.available,
            reason=plan.labels.reason,
            pairs=plan.labels.pairs,
        ),
        suggested_name=plan.suggested_name,
    )


@router.post(
    "/api/projects/{project_id}/datasets/{dataset_id}/columns/{column_id}/recodes/{definition_id}/derive-column",
    response_model=DeriveColumnResponse,
    status_code=201,
)
async def derive_column_endpoint(
    project_id: int,
    dataset_id: int,
    column_id: int,
    definition_id: int,
    data: DeriveColumnRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create a NEW variable holding this rule's output. The source is untouched.

    Decision B. ⚠️ **The refusal lives here rather than in the service**, the same
    boundary #794 established: `derive_column` reaches
    `plan_definition_over_column`, which shares its match rule with
    `apply_definition_to_column` — and that one is on the STARTUP path via
    `repair_reverse_recode_mappings`. Refusals belong at the user-initiated door.

    ⚠️ Not threadpooled, and that is a knowing choice rather than an oversight:
    it takes a `db` Session, and no router in this codebase threadpools one (the
    same reason #796 left `import_dataset_csv` alone). The work here is ONE
    `INSERT … SELECT` executed by SQLite rather than Python — 3.1M values in
    seconds on the dev corpus — so it is not #804's shape. That entry still owns
    the session-threading question for all four endpoints together.
    """
    col = _get_column_or_404(db, project_id, dataset_id, column_id, user.id)
    definition = _get_definition_or_404(db, column_id, definition_id)

    try:
        new_col, report = derive_column(
            db, col, definition, data.column_text.strip(), data.carry_labels,
        )
    except DeriveColumnError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except ValueLabelsBlockedError as exc:
        # Reachable only on the carry-labels arm. The dictionary is re-paired
        # onto a fresh column with no primary, so neither guard SHOULD fire —
        # but `apply_value_labels` is the authority on its own preconditions and
        # a router that swallowed its refusal would be asserting otherwise.
        raise HTTPException(status_code=400, detail=str(exc))

    log_action(
        db,
        action="dataset_column_derived",
        entity_type="dataset_column",
        entity_id=new_col.id,
        user_id=user.id,
        project_id=project_id,
        details={
            "dataset_id": dataset_id,
            "derived_from_column_id": column_id,
            "derived_via": definition.name,
            "values_written": report["values_written"],
            "labels_carried": report["labels_carried"],
            "unmapped_count": len(report["unmapped_values"]),
        },
    )
    db.commit()
    return DeriveColumnResponse(**report)


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
def apply_value_labels_endpoint(
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

    🔴 **DECLARED `def`, NOT `async def` — that is the #804 fix and it is one
    word.** This body contains no `await`: it is a purely synchronous function
    that was wearing `async def`, so every second of its work ran ON the event
    loop. FastAPI dispatches a SYNC endpoint to its threadpool automatically, so
    the loop stays free while this runs.

    MEASURED end-to-end (500 labels — the `MAX_VALUE_LABELS` ceiling — against
    the 75,699-row GSS dataset, `/health` polled every 200ms throughout):

    | | apply wall | worst concurrent `/health` |
    |---|---|---|
    | `async def` | 7.78 s | **7.70 s — the loop was frozen** |
    | `def` | 8.51 s | **0.012 s** |

    Response bodies were byte-identical. In the packaged desktop app that
    7.7 s is Electron's `/health` probe getting no answer.

    ⚠️ **`run_in_threadpool` was the filed suggestion and is the WRONG tool
    here.** `apply_value_labels` takes a `db` Session, and no router in this
    codebase threadpools a session-using function. Declaring the endpoint sync
    needs no such call: FastAPI resolves the sync `get_db` dependency and runs
    the whole body in one worker thread, which is what the Session wants.
    (`check_same_thread=False` is already set on the engine either way.)

    ⚠️ **The criterion is STRUCTURAL, not a judgement: does the body contain an
    `await`?** `import_dataset` and `append_import` — the other two endpoints
    #804 said to decide together with this one — each `await _upload_to_csv_text`,
    so they genuinely need `async` and keep it. Two of the four could change and
    two could not, decided by the code rather than by taste.

    ⚠️ **This is NOT the whole class**, and do not quote a number here — it
    rots (this line read "320 of 341" until #837's batch converted five more).
    The large majority of async endpoints contain no `await`; see #837, and
    re-measure rather than trusting prose. Only the endpoints with a MEASURED
    freeze were converted, there and here.
    """
    col = _get_column_or_404(db, project_id, dataset_id, column_id, user.id)

    if col.source == "computed":
        raise HTTPException(
            status_code=403, detail="Value labels cannot be applied to computed columns",
        )
    # #589: the same set the SERVICE now enforces — this arm only makes the
    # refusal early and cheap for the human entry point. Do not delete it as
    # redundant: it answers before any work is done, and the service's copy is
    # what protects the import path, which never passes through here.
    if col.column_type in VALUE_LABEL_INELIGIBLE_TYPES:
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


# ── Bulk missing-value declaration (#798) ────────────────────────────────────


@router.post(
    "/api/projects/{project_id}/datasets/{dataset_id}/columns/bulk-missing-values",
    response_model=BulkMissingValuesResponse,
)
def bulk_set_missing_values(
    project_id: int,
    dataset_id: int,
    data: BulkMissingValuesUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Apply ONE missing-value vocabulary to many columns (#798).

    Real survey data carries one sentinel set across every variable — GSS's five
    `.x:` codes span all 41 of its columns — while the #592 declaration path is
    column-at-a-time. Declaring them by hand is 41 dialogs x 5 rules.

    ⚠️ **Loops `apply_missing_declaration` per column; it does NOT reimplement
    the mutation.** That service carries the #606 label-collision guard, the C4
    scale-point strip, the J-D3 recovery pass and the #603 primary re-apply
    behind a load-bearing flush. Re-deriving any of them here would be a
    regression the tests could not see, because they exercise the service.

    ⚠️ **Per-column outcomes, deliberately not all-or-nothing.** #606 refuses a
    rule whose label collides with text meaning something else ON THAT COLUMN —
    a judgement about one column's own data. Aborting forty good columns for the
    forty-first would make the feature useless on exactly the data it is for.
    Applied columns commit; skipped ones come back named, with the reason.
    """
    # ⚠️ Ownership: the project gate ALONE does not check the dataset id
    # (#782/#783). The join to `Dataset.project_id` is what stops a caller
    # naming another project's dataset and declaring across its columns —
    # the same shape `_get_column_or_404` uses one entity down.
    _get_project_or_404(db, project_id, user.id)
    columns = (
        db.query(DatasetColumn)
        .join(Dataset)
        .filter(
            DatasetColumn.dataset_id == dataset_id,
            Dataset.project_id == project_id,
            DatasetColumn.id.in_(data.column_ids),
        )
        .all()
    )
    found = {c.id for c in columns}

    applied: list[MissingValuesResponse] = []
    skipped: list[BulkMissingValuesSkip] = []

    for missing_id in [cid for cid in data.column_ids if cid not in found]:
        skipped.append(BulkMissingValuesSkip(
            column_id=missing_id, column_label=f"Column {missing_id}",
            reason="Not a column of this dataset.",
        ))

    for col in columns:
        label = col.column_name or col.column_text or f"Column {col.id}"
        # The same eligibility the single endpoint enforces — but as a SKIP, not
        # a 400: a selection that happens to include an identifier column should
        # declare the other forty, not refuse them all.
        if col.source == "computed":
            skipped.append(BulkMissingValuesSkip(
                column_id=col.id, column_label=label,
                reason="Computed columns cannot carry a missing declaration.",
            ))
            continue
        if col.column_type in (ColumnType.OPEN_TEXT, ColumnType.IDENTIFIER):
            skipped.append(BulkMissingValuesSkip(
                column_id=col.id, column_label=label,
                reason=f"{col.column_type.value} columns cannot carry a missing declaration.",
            ))
            continue
        try:
            result = apply_missing_declaration(db, col, data.rules)
        except MissingRuleCollisionError as e:
            # #606, per column and legitimate — report it and keep going.
            skipped.append(BulkMissingValuesSkip(
                column_id=col.id, column_label=label, reason=str(e),
            ))
            continue
        applied.append(MissingValuesResponse(
            column_id=col.id,
            missing_values=parse_missing_rules(col.missing_values),
            **result,
        ))

    if applied:
        applied_ids = [r.column_id for r in applied]
        mark_metrics_stale(db, project_id, column_ids=applied_ids)
        log_action(
            db,
            action="bulk_set_missing_values",
            entity_type="dataset",
            entity_id=dataset_id,
            user_id=user.id,
            project_id=project_id,
            details={
                "columns": len(applied_ids),
                "skipped": len(skipped),
                "rules": len(data.rules) if data.rules is not None else None,
            },
        )
    db.commit()

    # Unmatched on EVERY applied column — see the schema for why it is the
    # intersection. Order follows the first column's report so the phrases come
    # back in the order the researcher typed them.
    unmatched_everywhere: list[str] = []
    if applied:
        others = [set(r.unmatched_rules) for r in applied[1:]]
        unmatched_everywhere = [
            phrase for phrase in applied[0].unmatched_rules
            if all(phrase in o for o in others)
        ]

    return BulkMissingValuesResponse(
        applied=applied,
        skipped=skipped,
        nulled_rows_total=sum(r.nulled_rows for r in applied),
        unmatched_everywhere=unmatched_everywhere,
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
