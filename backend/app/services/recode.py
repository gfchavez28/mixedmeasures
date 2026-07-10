"""Recode service for computing derived values from dataset values."""

import json
import logging

from sqlalchemy import func, case
from sqlalchemy.orm import Session

from ..models.dataset import DatasetValue
from ..models.recode import RecodeDefinition, RecodeType
from ..services.dataset_import import _is_na

logger = logging.getLogger(__name__)


def _parse_mapping(definition: RecodeDefinition) -> dict:
    """Parse JSON mapping from a RecodeDefinition."""
    try:
        return json.loads(definition.mapping) if definition.mapping else {}
    except (json.JSONDecodeError, TypeError):
        return {}


def _parse_exclude_values(definition: RecodeDefinition) -> list[str]:
    """Parse JSON exclude_values from a RecodeDefinition."""
    try:
        return json.loads(definition.exclude_values) if definition.exclude_values else []
    except (json.JSONDecodeError, TypeError):
        return []


def mapping_numeric_values(mapping: dict) -> list[float]:
    """The numeric SUBSET of a mapping's values — what reverse scoring reflects
    about.

    Single-sourced (#542b): non-floatable values in a mixed mapping are skipped
    PER VALUE, never allowed to abort the collection. `compute_value` previously
    built this in one list comprehension inside a try, so one stray non-numeric
    mapping value silently returned every other value un-reversed — while
    `apply_definition_to_column` filtered per value and reversed the numeric
    subset. Same input, two results, depending on which path computed the cell.
    """
    out: list[float] = []
    for v in mapping.values():
        try:
            out.append(float(v))
        except (ValueError, TypeError):
            continue
    return out


def reverse_offset(scale_values: list[float]) -> float:
    """The reflection offset for reverse scoring: ``min + max``.

    Reverse-scoring reflects a value about the scale's midpoint, so the reversed
    value is ``(min + max) - v``. For any 1..N scale min is 1, making this exactly
    the historical ``(max + 1) - v`` — every existing dataset is unaffected. It is
    the general form that also stays inside the scale for a 0-based or offset
    scale, which SPSS imports can produce (#28); ``(max + 1) - v`` would map 0..3
    onto 1..4 and shift every mean.

    Single-sourced: both the per-value path (`compute_value`) and the bulk UPDATE
    path (`apply_definition_to_column`) must reverse identically.
    """
    return min(scale_values) + max(scale_values)


def compute_value(
    value_text: str,
    definition: RecodeDefinition,
) -> float | str | None:
    """
    Apply a recode definition's mapping to a single value_text.

    Returns the mapped value (float for scale_map/reverse, str for category_group),
    or None if the value is excluded or unmapped.
    """
    if not value_text or not value_text.strip():
        return None

    exclude_values = _parse_exclude_values(definition)
    lower_excludes = {v.lower() for v in exclude_values}
    if value_text.strip().lower() in lower_excludes:
        return None

    mapping = _parse_mapping(definition)
    # Case-insensitive lookup
    lower_map = {k.lower(): v for k, v in mapping.items()}
    result = lower_map.get(value_text.strip().lower())

    # Reverse recode: map to numeric first, then reflect about the scale midpoint.
    if result is not None and definition.recode_type == RecodeType.REVERSE:
        try:
            numeric_val = float(result)
        except (ValueError, TypeError):
            # The bulk path treats a non-numeric mapping value as unmapped
            # (NULL + a warning) — mirror it, never return the raw value (#542b).
            return None
        all_numeric = mapping_numeric_values(mapping)
        if all_numeric:
            result = reverse_offset(all_numeric) - numeric_val

    return result


def apply_definition_to_column(
    db: Session,
    definition: RecodeDefinition,
    row_ids: list[int] | None = None,
) -> dict:
    """
    For a primary scale_map definition: bulk UPDATE value_numeric on DatasetValue
    using CASE WHEN with case-insensitive matching.

    Returns {"updated": N, "unmapped": [...], "excluded": N}.
    """
    mapping = _parse_mapping(definition)
    exclude_values = _parse_exclude_values(definition)
    lower_excludes = {v.lower() for v in exclude_values}

    # Build case-insensitive mapping
    lower_map = {k.lower(): v for k, v in mapping.items()}

    # For REVERSE type, precompute the reflection offset from the mapping values.
    # Same collection as `compute_value` (#542b) — the two paths must reverse
    # identically or one cell gets two different numbers.
    is_reverse = (definition.recode_type == RecodeType.REVERSE)
    rev_offset = 0.0
    if is_reverse:
        all_numeric = mapping_numeric_values(mapping)
        rev_offset = reverse_offset(all_numeric) if all_numeric else 0.0

    # Get all distinct value_text for this column
    distinct_values = (
        db.query(DatasetValue.value_text)
        .filter(
            DatasetValue.column_id == definition.column_id,
            DatasetValue.value_text.isnot(None),
            DatasetValue.value_text != "",
        )
        .distinct()
        .all()
    )

    unmapped = []
    excluded_lower_vals = []

    # Build CASE WHEN expression for bulk update
    whens = []
    for (val,) in distinct_values:
        lower_val = val.strip().lower()
        if lower_val in lower_excludes:
            # Excluded values get NULL
            whens.append((func.lower(func.trim(DatasetValue.value_text)) == lower_val, None))
            excluded_lower_vals.append(lower_val)
        elif lower_val in lower_map:
            try:
                numeric_val = float(lower_map[lower_val])
                if is_reverse:
                    numeric_val = rev_offset - numeric_val
                whens.append((func.lower(func.trim(DatasetValue.value_text)) == lower_val, numeric_val))
            except (ValueError, TypeError):
                logger.warning("Non-numeric recode mapping value for '%s': %s", lower_val, lower_map[lower_val])
                unmapped.append(val)
        else:
            unmapped.append(val)

    if not whens and not unmapped:
        return {"updated": 0, "unmapped": unmapped, "excluded": 0}

    # Build the CASE expression
    case_expr = case(*whens, else_=None)

    # Bulk update
    query = (
        db.query(DatasetValue)
        .filter(
            DatasetValue.column_id == definition.column_id,
            DatasetValue.value_text.isnot(None),
            DatasetValue.value_text != "",
        )
    )
    if row_ids is not None:
        query = query.filter(DatasetValue.row_id.in_(row_ids))
    updated = query.update(
        {DatasetValue.value_numeric: case_expr},
        synchronize_session="fetch",
    )

    # Count actual rows affected by exclusion (not just distinct values)
    excluded_count = 0
    if excluded_lower_vals:
        base_q = db.query(func.count(DatasetValue.id)).filter(
            DatasetValue.column_id == definition.column_id,
            DatasetValue.value_text.isnot(None),
            DatasetValue.value_text != "",
            func.lower(func.trim(DatasetValue.value_text)).in_(excluded_lower_vals),
        )
        if row_ids is not None:
            base_q = base_q.filter(DatasetValue.row_id.in_(row_ids))
        excluded_count = base_q.scalar() or 0

    return {"updated": updated, "unmapped": unmapped, "excluded": excluded_count}


def get_value_frequencies(
    db: Session,
    column_id: int,
) -> list[dict]:
    """
    Get value frequency distribution for a column.

    Returns list of {"value_text": str, "count": int, "is_na": bool},
    sorted by count descending.
    """
    rows = (
        db.query(
            DatasetValue.value_text,
            func.count(DatasetValue.id).label("count"),
        )
        .filter(
            DatasetValue.column_id == column_id,
            DatasetValue.value_text.isnot(None),
            DatasetValue.value_text != "",
        )
        .group_by(DatasetValue.value_text)
        .order_by(func.count(DatasetValue.id).desc())
        .all()
    )

    return [
        {
            "value_text": val,
            "count": cnt,
            "is_na": _is_na(val),
        }
        for val, cnt in rows
    ]


def get_unmapped_values(
    db: Session,
    column_id: int,
    definition: RecodeDefinition,
) -> list[str]:
    """Get value_text values that are not in the definition's mapping or exclude_values."""
    mapping = _parse_mapping(definition)
    exclude_values = _parse_exclude_values(definition)

    known_lower = {k.lower() for k in mapping} | {v.lower() for v in exclude_values}

    distinct_values = (
        db.query(DatasetValue.value_text)
        .filter(
            DatasetValue.column_id == column_id,
            DatasetValue.value_text.isnot(None),
            DatasetValue.value_text != "",
        )
        .distinct()
        .all()
    )

    return [val for (val,) in distinct_values if val.strip().lower() not in known_lower]


def clear_value_numeric(
    db: Session, column_id: int, row_ids: list[int] | None = None
) -> int:
    """Bulk UPDATE SET value_numeric = NULL for a column's values.

    ``row_ids`` scopes the clear to specific rows — the append path (#538) uses
    this to keep NEW rows consistent with a category_group-primary column whose
    existing values were already cleared.
    """
    query = db.query(DatasetValue).filter(DatasetValue.column_id == column_id)
    if row_ids is not None:
        query = query.filter(DatasetValue.row_id.in_(row_ids))
    return query.update(
        {DatasetValue.value_numeric: None},
        synchronize_session="fetch",
    )
