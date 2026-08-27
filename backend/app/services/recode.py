"""Recode service for computing derived values from dataset values."""

import json
import logging
from dataclasses import dataclass

from sqlalchemy import func, case
from sqlalchemy.orm import Session

from ..models.dataset import DatasetValue, DatasetColumn, ColumnType
from ..models.recode import RecodeDefinition, RecodeType
from ..services.dataset_import import _coerce_scale_codes
from ..services.missing_values import is_missing, parse_missing_rules

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

    #592: this collection is the RAW one — it does not know the null set.
    Callers reflecting a REVERSE recode must go through
    ``effective_reverse_offset``, never this + ``reverse_offset`` directly
    (#600). Kept raw because it is also the honest "what numbers does this
    mapping contain" answer for non-reflection callers.
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


def _effective_null_set_hit(
    value_text: str,
    lower_excludes: set[str],
    missing_rules: list | None,
) -> bool:
    """J-D1 (#592): does this value belong to the recode-apply NULL set?

    Declaration present → it ALONE decides (the per-def ``exclude_values``
    channel is ignored — REPLACE semantics extend to it; honoring both would
    recreate the #595 text-vs-numeric split on a declared column).
    No declaration → the ``_is_na`` defaults ∪ ``exclude_values``. Adding the
    defaults is what closes Bug B/#594: mapping "N/A" → 99 no longer writes
    99.0 into every mean — and a researcher who really means "it's data"
    declares ``[]`` (or a set without it), the escape hatch that didn't exist
    when Bug B was filed.

    Shared verbatim by ``compute_value`` and ``apply_definition_to_column``
    (the #542b parity rule: the per-value and bulk paths must agree).
    """
    if missing_rules is not None:
        return is_missing(value_text, missing_rules)
    if is_missing(value_text, None):
        return True
    return value_text.strip().lower() in lower_excludes


def effective_reverse_offset(
    mapping: dict,
    lower_excludes: set[str],
    missing_rules: list | None,
) -> float | None:
    """THE reflection offset for a REVERSE recode (#600).

    A mapping key in the NULL SET is not a scale point — its cell NULLs — so
    it must not set the reflection endpoint. Including it stretches min+max
    and shifts EVERY reversed cell, not just its own: a mapping of
    {"Never": 1, "Always": 5, "Prefer not to say": 99} on an undeclared
    column reflects about 1+99=100 instead of 1+5=6, so "Never" scores 99
    and "Always" scores 95. The dramatic sentinel case is the SPSS
    convention; the common case is quieter and worse — any recognized-N/A
    response occupying a scale slot stretches the scale by one and shifts
    every reversed cell by one, silently.

    The null set is the SAME one the cells use (``_effective_null_set_hit``),
    so a value can never be excluded from the output while still defining the
    scale. Keys are ``value_text``, matching the predicate's space (#592
    §I.4).

    ⚠️ The offset this returns is the AUTHORITY and rides the wire
    (``RecodeDefinitionSummary.reverse_offset``). The client must not re-derive
    it: the null set needs ``_is_na`` (an English prefix list #592 is retiring)
    and the column's declaration, neither of which the client has — a client
    mirror would be the #578 display-vs-storage drift class.

    Returns **None** when no real numeric scale points remain (a mapping of only
    null-set or non-numeric keys) — NEVER 0.0 for that case. ``0.0`` is a
    LEGITIMATE offset: a symmetric scale (-5..+5, or a -3..+3 Likert) reflects
    about min+max = 0. Collapsing the two lets a falsy check skip the reversal
    on exactly those scales, which is a #542b parity break against the bulk
    path — the falsy-zero trap, and the reason callers must test
    ``is not None``.
    """
    real = {
        k: v for k, v in mapping.items()
        if not _effective_null_set_hit(str(k), lower_excludes, missing_rules)
    }
    nums = mapping_numeric_values(real)
    return reverse_offset(nums) if nums else None


def definition_reflection_offset(
    definition: RecodeDefinition, missing_values_json,
) -> float | None:
    """The reflection offset THIS definition's mapping implies on its column.

    The wire-facing wrapper around ``effective_reverse_offset``: parse the def's
    own ``exclude_values``, parse the column's declaration, ask the one function
    that owns the rule. Shared by BOTH payloads that carry a `reverse_offset`
    (`/data`'s `RecodeDefinitionSummary` and the definition endpoints'
    `RecodeDefinitionResponse`) so the same field name cannot acquire two
    population rules.

    ⚠️ **Populated for EVERY definition type, not only `reverse` (#602).** The
    Recode Workbench's reverse editor previews a DRAFT whose mapping is a
    verbatim copy of its `scale_map` source, and the number that draft must show
    is the one the save will produce — which is this offset computed over the
    SOURCE's mapping. Restricting the field to reverse defs leaves the draft with
    nothing authoritative to display, which is how the preview came to say
    "Never → 99" while saving produced 5. Non-numeric mappings (a
    `category_group`) yield ``None`` naturally.

    ``None`` is meaningful and is NOT "unknown": it says the mapping has no real
    scale points, so the apply path performs no reflection at all.
    """
    return effective_reverse_offset(
        _parse_mapping(definition),
        {v.lower() for v in _parse_exclude_values(definition)},
        parse_missing_rules(missing_values_json),
    )


def compute_value(
    value_text: str,
    definition: RecodeDefinition,
    missing_rules: list | None = None,
) -> float | str | None:
    """
    Apply a recode definition's mapping to a single value_text.

    Returns the mapped value (float for scale_map/reverse, str for category_group),
    or None if the value is excluded, missing, or unmapped.

    ``missing_rules`` is the COLUMN's parsed declaration (None = undeclared —
    the defaults apply; see ``_effective_null_set_hit``). Callers with the
    column in hand should pass ``parse_missing_rules(column.missing_values)``.
    """
    if not value_text or not value_text.strip():
        return None

    exclude_values = _parse_exclude_values(definition)
    lower_excludes = {v.lower() for v in exclude_values}
    if _effective_null_set_hit(value_text, lower_excludes, missing_rules):
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
        # #600: reflect about the REAL scale points only — the same null set
        # that decided this cell above. The bulk path computes the identical
        # offset (#542b: one cell, one number, whichever path computes it).
        # `is not None`, never a falsy check: 0.0 is a real offset (a symmetric
        # -5..+5 scale reflects about it), and `if offset:` would silently skip
        # the reversal there while the bulk path reversed.
        offset = effective_reverse_offset(mapping, lower_excludes, missing_rules)
        if offset is not None:
            result = offset - numeric_val

    return result


#: How ONE distinct source ``value_text`` is treated by a definition.
#: ``kind`` is ``'mapped'`` | ``'null_set'`` | ``'unmapped'``; ``output`` is the
#: computed value for a mapped entry (already reflected for a REVERSE) and
#: ``None`` otherwise.
@dataclass(frozen=True)
class RecodeCellDisposition:
    value_text: str
    lower_key: str
    kind: str
    output: float | str | None
    missing_overridden: bool = False


def plan_definition_over_column(
    db: Session,
    definition: RecodeDefinition,
) -> list[RecodeCellDisposition]:
    """Classify every DISTINCT ``value_text`` on a definition's column.

    **THE match rule, extracted so it has exactly one implementation.** Two
    operations need it — applying a definition IN PLACE
    (``apply_definition_to_column``) and deriving a NEW column from it
    (``services/derive_column.py``) — and #542b is the standing record of what a
    second copy costs: the per-value and bulk paths once disagreed about a
    stray non-numeric mapping value, so one cell got two different numbers
    depending on which path computed it. A derived column whose values disagreed
    with the in-place recode's would be the same defect wearing a new hat.

    Order is the DISTINCT query's order and is preserved, so a caller building a
    ``CASE`` from this produces the clauses the pre-extraction code produced.
    (Order does not affect the result — the conditions are mutually exclusive
    equality tests on one expression — but keeping it makes the two readable
    against each other.)

    ⚠️ Read-only. It runs one DISTINCT query and one scalar; it writes nothing,
    which is what lets the derive path show a researcher the plan BEFORE
    committing to it.
    """
    mapping = _parse_mapping(definition)
    exclude_values = _parse_exclude_values(definition)
    lower_excludes = {v.lower() for v in exclude_values}

    # Build case-insensitive mapping
    lower_map = {k.lower(): v for k, v in mapping.items()}

    # #592: the column's missing declaration (None = undeclared → defaults +
    # the per-def exclude channel; see _effective_null_set_hit).
    missing_rules = parse_missing_rules(
        db.query(DatasetColumn.missing_values)
        .filter(DatasetColumn.id == definition.column_id)
        .scalar()
    )

    # For REVERSE type, precompute the reflection offset over the mapping's
    # REAL scale points. Same helper as `compute_value` (#542b) — the two paths
    # must reverse identically or one cell gets two different numbers.
    is_reverse = (definition.recode_type == RecodeType.REVERSE)
    rev_offset = None
    if is_reverse:
        rev_offset = effective_reverse_offset(mapping, lower_excludes, missing_rules)

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

    plan: list[RecodeCellDisposition] = []
    for (val,) in distinct_values:
        lower_val = val.strip().lower()
        if _effective_null_set_hit(val, lower_excludes, missing_rules):
            # Missing/excluded values get NULL — checked BEFORE the mapping,
            # so a mapped missing value NULLs anyway (J-D1; Bug B/#594).
            plan.append(RecodeCellDisposition(
                value_text=val, lower_key=lower_val, kind="null_set", output=None,
                missing_overridden=lower_val in lower_map,
            ))
        elif lower_val in lower_map:
            raw = lower_map[lower_val]
            if definition.recode_type == RecodeType.CATEGORY_GROUP:
                # Categorical output is a STRING group name; it is never
                # floated and never reflected.
                plan.append(RecodeCellDisposition(
                    value_text=val, lower_key=lower_val, kind="mapped", output=raw,
                ))
                continue
            try:
                numeric_val = float(raw)
                # `is not None`: 0.0 is a real offset (a symmetric -5..+5 scale
                # reflects about it) — see effective_reverse_offset. None means
                # there are no real scale points to reflect about at all.
                if is_reverse and rev_offset is not None:
                    numeric_val = rev_offset - numeric_val
                plan.append(RecodeCellDisposition(
                    value_text=val, lower_key=lower_val, kind="mapped", output=numeric_val,
                ))
            except (ValueError, TypeError):
                logger.warning("Non-numeric recode mapping value for '%s': %s", lower_val, raw)
                plan.append(RecodeCellDisposition(
                    value_text=val, lower_key=lower_val, kind="unmapped", output=None,
                ))
        else:
            plan.append(RecodeCellDisposition(
                value_text=val, lower_key=lower_val, kind="unmapped", output=None,
            ))
    return plan


def apply_definition_to_column(
    db: Session,
    definition: RecodeDefinition,
    row_ids: list[int] | None = None,
) -> dict:
    """
    For a primary scale_map definition: bulk UPDATE value_numeric on DatasetValue
    using CASE WHEN with case-insensitive matching.

    Returns {"updated": N, "unmapped": [...], "excluded": N,
    "missing_overridden": [...]} — the last being mapped values the column's
    missing rule NULLed anyway (J-D1: the declaration wins over the mapping;
    surfaced so callers can tell the researcher).
    """
    plan = plan_definition_over_column(db, definition)

    # ⚠️ ONE ordered pass, deliberately — not three comprehensions. A
    # CATEGORY_GROUP's output is a STRING, which this path has never been able to
    # write to `value_numeric` (`recompute_primary_value_numeric` routes that type
    # to `clear_value_numeric` instead), so before the extraction it reached
    # `float("Positive")`, raised, and landed in `unmapped`. Re-adding those in a
    # second pass would preserve the MEMBERSHIP of `unmapped` but not its ORDER,
    # and the order is what a researcher reads in "Unmapped values: …".
    unmapped: list[str] = []
    excluded_lower_vals: list[str] = []
    missing_overridden: list[str] = []
    whens = []
    for d in plan:
        if d.missing_overridden:
            missing_overridden.append(d.value_text)
        if d.kind == "null_set":
            excluded_lower_vals.append(d.lower_key)
            whens.append((func.lower(func.trim(DatasetValue.value_text)) == d.lower_key, None))
        elif d.kind == "unmapped" or isinstance(d.output, str):
            unmapped.append(d.value_text)
        else:
            whens.append((func.lower(func.trim(DatasetValue.value_text)) == d.lower_key, d.output))

    if not whens:
        # 🔴 #794: NOTHING matched. The old guard was `not whens and not
        # unmapped`, so a definition whose keys match no cell — every key stale
        # against the column's text — fell through to `case()` with zero WHEN
        # clauses and emitted `SET value_numeric=CASE END WHERE …`, which is not
        # valid SQL: an unhandled 500 on a routine "make this primary" click.
        #
        # ⚠️ **This returns rather than RAISES, and that is load-bearing.** This
        # function is on the startup path — `repair_reverse_recode_mappings`
        # reaches it through `recompute_primary_value_numeric` — and the J-D2
        # pair was DROPPED in #592 slab 4 precisely because an apply-side raise
        # fires during boot on existing data. The refusal belongs at the
        # user-initiated door (`routers/recode.py::set_primary`), which can see
        # `updated == 0` in this result and answer 4xx before committing.
        #
        # Returning a no-op is also the honest arithmetic: nothing matched, so
        # nothing should be written. The pre-#794 behaviour NULLed nothing here
        # only because it crashed first.
        return {"updated": 0, "unmapped": unmapped, "excluded": 0,
                "missing_overridden": missing_overridden}

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

    return {"updated": updated, "unmapped": unmapped, "excluded": excluded_count,
            "missing_overridden": missing_overridden}


def get_value_frequencies(
    db: Session,
    column_id: int,
) -> list[dict]:
    """
    Get value frequency distribution for a column.

    Returns list of {"value_text": str, "count": int, "is_na": bool},
    sorted by count descending.

    #592: ``is_na`` is column-aware — a declared ``missing_values`` rule list
    wins over the recognized-N/A defaults, so the workbench's per-label
    exclude seeding agrees with what analysis treats as missing.
    """
    missing_rules = parse_missing_rules(
        db.query(DatasetColumn.missing_values)
        .filter(DatasetColumn.id == column_id)
        .scalar()
    )
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
            "is_na": is_missing(val, missing_rules),
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


# ── Primary recode application ───────────────────────────────────────────────
# Moved from routers/recode.py (2026-07-14) so the service layer owns the
# apply-vs-clear decision AND the startup reverse-mapping repair can reuse it
# without importing from the router layer. The router re-exports both for its
# existing callsites — behavior is unchanged.


def write_back_scale_metadata(
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
    # #592 (C4): a missing value is never a scale point — skip such pairs so
    # they can't enter scale_labels through the workbench path (a scale_labels
    # entry the counts exclude would render a phantom zero bar, and the R
    # export would emit it as a factor level). Column-aware: the declaration
    # when present, the recognized-N/A defaults otherwise.
    missing_rules = parse_missing_rules(column.missing_values)
    pairs: list[tuple[str, float]] = []
    for label, code in mapping.items():
        if is_missing(str(label), missing_rules):
            continue
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


def recompute_primary_value_numeric(
    db: Session, definition: RecodeDefinition, column_id: int,
) -> dict | None:
    """Recompute (or clear) ``value_numeric`` for a column from its primary recode.

    SCALE_MAP and REVERSE both produce numeric output and must be *applied* to the
    column's stored values — REVERSE carries its own ``{label: numeric}`` mapping and
    performs the reversal internally (``apply_definition_to_column``).
    CATEGORY_GROUP produces categorical output, so ``value_numeric`` is cleared.

    Centralized so every primary-changing callsite (create, update, set-primary,
    delete-then-promote, copy-to, and the #578 startup repair) shares one
    apply-vs-clear decision. The #359 bug was exactly these callsites drifting apart
    — REVERSE was applied in none of them, silently leaving reverse-scored subscales
    un-reversed (Cronbach's α collapsing because negatively-worded items were never
    flipped). #542a: applying a numeric primary also writes the mapping back to the
    column's scale metadata (see ``write_back_scale_metadata``).

    Keys on ``recode_type``, never ``output_type`` — the schema does not constrain
    the two to agree (#581), so a category_group with output_type=numeric must still
    clear, not apply.
    """
    rtype = definition.recode_type
    if hasattr(rtype, "value"):
        rtype = rtype.value
    if rtype in ("scale_map", "reverse"):
        result = apply_definition_to_column(db, definition)
        write_back_scale_metadata(db, definition, column_id)
        # Handed back (#794) so a CALLER can judge the outcome — `set_primary`
        # refuses a promotion that matched nothing, and discloses the values a
        # partial match left unmapped. Every existing caller ignores it, which
        # is why this is a return value and not a raise.
        return result
    # category_group → no numeric output
    clear_value_numeric(db, column_id)
    return None


# ── #578 one-time reverse-mapping repair ─────────────────────────────────────


def _ultimate_scale_map_mapping(
    definition: RecodeDefinition, resolve,
) -> dict | None:
    """Follow a reverse def's ``source_definition_id`` chain to the ultimate
    SCALE_MAP source and return its forward ``{label: code}`` mapping.

    ``copy_to`` builds reverse→reverse chains (a copied reverse's source is
    another reverse, #578 scope), so the direct source is not always the scale
    map — walk until a non-reverse def is reached. Returns None for orphans
    (deleted / source-less reverses from ``CopyRecodeDialog``) and for chains
    that don't terminate at a scale map: those can't be repaired safely because
    a forward and a flipped mapping are indistinguishable without the reference.

    ⚠️ This is the CHAIN walker only. An orphan may still have a reference — a
    ``scale_map`` sibling on its own column — which ``_sibling_scale_map_mapping``
    finds; ``_forward_reference_mapping`` is the one that tries both. Keep this
    function pure over the chain so the two references stay distinguishable.
    """
    seen: set[int] = set()
    cur = definition
    while cur.source_definition_id and cur.source_definition_id not in seen:
        seen.add(cur.source_definition_id)
        src = resolve(cur.source_definition_id)
        if src is None:
            return None
        if src.recode_type != RecodeType.REVERSE:
            if src.recode_type == RecodeType.SCALE_MAP:
                return _parse_mapping(src)
            return None
        cur = src
    return None


def _maybe_float(v) -> float | None:
    try:
        return float(v)
    except (ValueError, TypeError):
        return None


def _comparable_keys(
    definition: RecodeDefinition, forward: dict,
) -> tuple[list[str], dict, dict]:
    """The keys a flip test can actually compare, lower-cased on both sides.

    A key qualifies when it is not in the def's own ``exclude_values`` (the
    frontend flip preserved excluded values un-flipped, so they are not evidence)
    and carries a numeric value on BOTH sides. Returns ``(shared, current,
    forward)`` with both maps already lower-cased and numeric-parsed.

    Single-sourced because ``_forward_reference_mapping`` has to ask the same
    question the repair loop asks: an empty result means the two mappings have
    nothing in common, so the "reference" is not one.
    """
    excludes = {e.lower() for e in _parse_exclude_values(definition)}
    cur_lower = {str(k).lower(): _maybe_float(v)
                 for k, v in _parse_mapping(definition).items()}
    fwd_lower = {str(k).lower(): _maybe_float(v) for k, v in forward.items()}
    shared = [
        k for k in cur_lower
        if k not in excludes
        and cur_lower[k] is not None
        and fwd_lower.get(k) is not None
    ]
    return shared, cur_lower, fwd_lower


def _sibling_scale_map_mapping(
    db: Session, definition: RecodeDefinition,
) -> tuple[dict, RecodeDefinition] | None:
    """The forward reference an ORPHANED reverse def still has: a ``scale_map``
    on its OWN column (#587).

    ``CopyRecodeDialog`` / ``CopyToEquivalentsDialog`` (the crosswalk copy paths)
    call ``recodeApi.create`` without ``source_definition_id``, so the #578
    repair's chain walk returns None and skips them forever — leaving them
    stored FLIPPED, i.e. silently un-reversed, while their repaired originals are
    correct. One battery, inconsistently coded, with no visual cue (display and
    storage agree; both wrong).

    ``_ultimate_scale_map_mapping``'s docstring calls those "indistinguishable
    without the reference", and that is OVERSTATED: the target column carries its
    own ``scale_map`` with the forward mapping, in the TARGET's label spelling.
    That spelling is what makes this the arm that matters — a positional copy is
    ``remapMapping``'d to the target's labels, so walking to the SOURCE def (even
    once provenance is recorded) yields labels this def does not share, and the
    flip test finds nothing to compare. Provenance fixes the same-labels case;
    this fixes the remapped one.

    Two preconditions, because a sibling is weaker evidence than an explicit link:

    * **exactly one** ``scale_map`` on the column. Two that disagree cannot both
      be the reference, and picking one by a heuristic is how a repair corrupts
      data it was meant to fix. Ambiguity → skip (logged).
    * the sibling must cover **every** non-excluded numeric key of this def.
      The chain path is content with one shared key; here, partial overlap is
      indistinguishable from "these are different scales that happen to share a
      label".

    The flip test itself is unchanged and is the real safety: it demands
    ``offset - current[k] == forward[k]`` for every shared key, and the
    already-forward case short-circuits before it.
    """
    scale_maps = (
        db.query(RecodeDefinition)
        .filter(
            RecodeDefinition.column_id == definition.column_id,
            RecodeDefinition.recode_type == RecodeType.SCALE_MAP,
        )
        .all()
    )
    if len(scale_maps) != 1:
        if scale_maps:
            logger.info(
                "Reverse def %s has %d scale_map siblings — ambiguous reference, "
                "not repaired (#587)", definition.id, len(scale_maps),
            )
        return None

    sibling = scale_maps[0]
    forward = _parse_mapping(sibling)
    if not forward:
        return None

    excludes = {e.lower() for e in _parse_exclude_values(definition)}
    fwd_lower = {str(k).lower() for k in forward}
    for key, value in _parse_mapping(definition).items():
        if str(key).lower() in excludes:
            continue
        try:
            float(value)
        except (ValueError, TypeError):
            continue
        if str(key).lower() not in fwd_lower:
            return None  # partial overlap — not a reference for THIS def
    return forward, sibling


def _forward_reference_mapping(
    db: Session, definition: RecodeDefinition, resolve,
) -> tuple[dict, RecodeDefinition | None] | None:
    """THE forward ``{label: code}`` a reverse def should carry, or None.

    Tries the explicit provenance chain first (``source_definition_id``), then
    the same-column ``scale_map`` sibling. One function so "what is this def's
    forward reference?" has a single answer, and so a caller cannot accidentally
    consult only the weaker one.

    Returns ``(mapping, adopted_source)`` — ``adopted_source`` is the sibling
    when the fallback supplied the answer, so the repair can record the link it
    should have had.

    ⚠️ **A chain that RESOLVES is not automatically a usable reference, and this
    distinction is the whole fix.** The crosswalk's `positional` copy is
    remapped to the TARGET column's labels, so once provenance is recorded the
    chain returns the SOURCE column's mapping in the SOURCE's spelling — a
    perfectly valid mapping that shares NOT ONE KEY with this def. Returning it
    would shadow the sibling and leave exactly the rows #587 is about
    unrepaired, which is what an early version of this function did until
    `test_a_LABEL_REMAPPED_copy_is_reachable_ONLY_through_the_sibling` failed.
    So the chain must be comparable, not merely present.
    """
    chained = _ultimate_scale_map_mapping(definition, resolve)
    if chained and _comparable_keys(definition, chained)[0]:
        return chained, None
    return _sibling_scale_map_mapping(db, definition)


def repair_reverse_recode_mappings(db: Session) -> int:
    """One-time idempotent repair of the #578 double-flip.

    A reverse def created through the Recode Workbench stored FLIPPED codes; the
    backend then reflects again at apply time (``reverse_offset``), cancelling the
    reversal — so ``value_numeric`` silently kept its FORWARD value and every
    reverse-scored analysis (Cronbach's α, scale scores, correlations, group tests,
    the R export) was computed on un-reversed data. Approach A: a reverse def's
    mapping must carry the source scale map's FORWARD codes; reflection happens only
    at apply time. This rewrites any reverse def whose stored mapping is the flipped
    form of its ultimate scale-map source back to forward codes and re-applies the
    primaries.

    Detect-and-flip (NOT a blind overwrite): compares the def's non-excluded values
    to the source's forward mapping. Already-forward defs are skipped (idempotent —
    a second run is a no-op). Orphans with no resolvable scale-map source are
    indistinguishable from correct-forward and are left untouched. Excluded labels
    keep their raw value on both sides, so the comparison uses non-excluded labels
    only (the frontend flip preserved excluded values un-flipped).
    """
    reverse_defs = (
        db.query(RecodeDefinition)
        .filter(RecodeDefinition.recode_type == RecodeType.REVERSE)
        .all()
    )
    if not reverse_defs:
        return 0

    _cache: dict[int, RecodeDefinition | None] = {}

    def resolve(def_id: int):
        if def_id not in _cache:
            _cache[def_id] = db.get(RecodeDefinition, def_id)
        return _cache[def_id]

    repaired = 0
    for defn in reverse_defs:
        reference = _forward_reference_mapping(db, defn, resolve)
        if not reference:
            continue
        forward, adopted_source = reference
        current = _parse_mapping(defn)
        # Same helper `_forward_reference_mapping` used to judge the reference,
        # so "is this comparable?" cannot be answered two ways.
        shared, cur_lower, fwd_lower = _comparable_keys(defn, forward)
        if not shared:
            continue
        # Already forward → nothing to do (idempotent).
        if all(cur_lower[k] == fwd_lower[k] for k in shared):
            continue
        # Flipped iff reflecting the current values reproduces the forward ones.
        fwd_vals = [fwd_lower[k] for k in shared]
        offset = min(fwd_vals) + max(fwd_vals)  # the flip preserves min+max
        if not all(offset - cur_lower[k] == fwd_lower[k] for k in shared):
            continue  # hand-edited / ambiguous — leave it
        # Rewrite to the forward codes, preserving the def's own label spelling.
        fwd_raw = {k.lower(): v for k, v in forward.items()}
        defn.mapping = json.dumps(
            {label: fwd_raw.get(label.lower(), current[label]) for label in current}
        )
        if adopted_source is not None and defn.source_definition_id is None:
            # Record the link the copy path never set (#587). Not fabricated
            # provenance: "reversed from a scale_map on this column" is exactly
            # what `source_definition_id` means when the Recode Workbench sets
            # it, and adopting it makes the NEXT repair reach this def through
            # the chain — plus the workbench's ReverseEditor stops rendering
            # "Source definition not found or deleted." over a live def.
            defn.source_definition_id = adopted_source.id
        if defn.is_primary:
            recompute_primary_value_numeric(db, defn, defn.column_id)
        repaired += 1

    if repaired:
        db.commit()
        logger.info(
            "Repaired %d reverse recode mapping(s) — #578 double-flip", repaired
        )
    return repaired
