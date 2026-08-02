"""Declared value labels for numbers-only dataset columns (#576/#577).

A CSV whose cells are bare codes ("1".."5") carries no labels — the codebook
lives in a separate file. This lets a researcher DECLARE a code→label dictionary
and applies it the way the SPSS `.sav` importer already does: the label is
substituted INTO ``value_text`` and the code is kept in ``value_numeric`` (via a
primary ``scale_map`` recode + the column's scale metadata). Because every
analysis surface reads ``value_text`` (grouping, frequency, charts, cross-tabs)
and every numeric surface reads ``value_numeric``, the labelled column becomes
byte-identical to a ``.sav`` import of the same data — so NO analysis consumer
changes. Declaring a level nobody chose (#577) is free: it lands in
``scale_labels``, which the frequency computer already zero-fills.

Key on ``value_numeric`` (the code), falling back to parsing ``value_text`` — so
re-applying (or editing a label) is robust: the code is stable, only the label
text moves. Observed codes the user did NOT declare are left numeric+unlabelled
and RETURNED, never destroyed (the researcher decides whether to add them).
"""

import json
import logging

from sqlalchemy.orm import Session

from ..models.dataset import DatasetColumn, DatasetValue, ColumnType
from ..models.recode import RecodeDefinition, RecodeType, OutputType
from ..services.dataset_import import (
    _strip_numeric,
    _coerce_scale_codes,
    _compute_value_numeric,
)
from ..services.missing_values import (
    is_missing,
    matched_missing_label,
    parse_missing_rules,
)

logger = logging.getLogger(__name__)


class ValueLabelsBlockedError(ValueError):
    """Refused: this column's ``value_numeric`` is a DERIVED score, not the code.

    A ``ValueError`` subclass so the router can catch it ahead of the generic
    ``ValueError`` arm and map it to a 400 (same shape as
    ``project_portability.MergeDivergenceError``).
    """


def blocking_reverse_primary(db: Session, column: DatasetColumn):
    """The REVERSE primary that makes relabelling this column unsafe, or None.

    Every path here keys a cell on its CODE via the code-identity rule in
    ``apply_value_labels``, which reads
    ``value_numeric``. That is the raw code after import, and after a SCALE_MAP
    primary (whose applied value IS the mapping's code) — but a REVERSE primary
    stores the REFLECTED score, ``(min+max) - code`` (``recode.py::reverse_offset``),
    while ``write_back_scale_metadata`` keeps ``scale_values`` in FORWARD codes.
    The two live in different spaces ON PURPOSE, so relabelling reads each cell's
    MIRROR code and rewrites ``value_text`` to the opposite response — destroying
    the participant's actual answer, self-consistently (the grid then shows a
    label and a code that agree with each other and with nothing else).

    CATEGORY_GROUP needs no guard: it CLEARS ``value_numeric``
    (``recode.py::recompute_primary_value_numeric``), so the identity rule
    falls through to parsing ``value_text`` — the raw code — which is correct.

    Deliberately scoped to the PRIMARY: a non-primary reverse doesn't drive
    ``value_numeric``, so cells relabel correctly. Its own mapping keys DO go
    stale against the new labels — that is #584 (no path re-syncs a dependent
    recode), pre-existing and not made worse here.
    """
    return (
        db.query(RecodeDefinition)
        .filter(
            RecodeDefinition.column_id == column.id,
            RecodeDefinition.is_primary == True,  # noqa: E712
            RecodeDefinition.recode_type == RecodeType.REVERSE,
        )
        .first()
    )


# ── Shared code↔label cell substitution (retro / import / append single-source) ──


def build_code_to_label(
    scale_labels: list[str] | None, scale_values: list[float] | None,
) -> dict[float, str]:
    """Invert a column's parallel scale metadata into ``{code: label}``.

    Returns ``{}`` (no substitution possible) when either side is missing or the
    two lengths disagree — the same fail-safe as ``_compute_value_numeric`` uses
    for the forward direction, so a malformed column never mis-substitutes.
    """
    if not scale_labels or not scale_values or len(scale_labels) != len(scale_values):
        return {}
    out: dict[float, str] = {}
    for code, label in zip(scale_values, scale_labels):
        try:
            out[float(code)] = label
        except (ValueError, TypeError):
            continue
    return out


def substitute_code(cell: str, code_to_label: dict[float, str]) -> tuple[str, float | None]:
    """Resolve a raw CODE cell against a declared ``{code: label}`` dictionary.

    The one rule shared with the retro path (``apply_value_labels``): a declared
    code becomes its label (code kept in ``value_numeric``); an *undeclared*
    numeric code keeps its raw text AND its numeric code (NEVER nulled — the
    #580/#582 silent-NULL class); a non-numeric / NA cell stays as-is with no code.
    """
    code = _strip_numeric(cell)
    if code is None:
        return cell, None
    label = code_to_label.get(code)
    if label is not None:
        return label, code
    return cell, code


def resolve_labelled_cell(
    cell: str,
    column_type: str,
    scale_labels: list[str] | None,
    scale_values: list[float] | None,
    code_to_label: dict[float, str],
    missing_rules: list | None = None,
) -> tuple[str, float | None]:
    """Resolve an APPEND cell for a (possibly value-labelled) column, handling
    BOTH label-format and code-format files (#575 append parity).

    Try the label→code direction first (unchanged behavior for a label-format
    append and for every non-scale column); only when that misses AND the column
    carries a code→label dictionary do we treat the cell as a numeric code and
    substitute. Returns ``(value_text, value_numeric)``.

    ``missing_rules`` (#592 §I.2b): the column's declared missing rules run
    BEFORE label/code resolution — a declared-missing cell never gets a
    numeric, and when its discrete rule carries a label the cell lands as
    that label (the text existing labelled-missing rows carry, so the dedup
    fingerprint can match them). Threaded into the numeric compute too, so a
    declared-[] column's "N/A" resolves as data (REPLACE).
    """
    if not cell:
        return "", None
    if missing_rules is not None and is_missing(cell, missing_rules):
        label = matched_missing_label(cell, missing_rules)
        return (label if label is not None else cell), None
    vn = _compute_value_numeric(cell, column_type, scale_labels, scale_values,
                                missing_rules=missing_rules)
    if vn is not None:
        return cell, vn
    if code_to_label:
        return substitute_code(cell, code_to_label)
    return cell, None


def apply_value_labels(
    db: Session,
    column: DatasetColumn,
    pairs: list[tuple[float, str]],
    target_type: ColumnType | None = None,
) -> dict:
    """Attach a declared code→label dictionary to a numbers-only column.

    ``pairs`` is a list of ``(code, label)`` — assumed validated by the caller
    (unique numeric codes, unique non-empty labels). Substitutes the label into
    ``value_text`` for every cell whose code is declared, sets the column's scale
    metadata + a primary ``scale_map`` recode, and (optionally) the column type.

    Returns ``{"updated": N, "unlabeled_codes": [...]}`` — the codes observed in
    the data but NOT declared (surfaced so the UI can prompt the researcher; the
    cells keep their raw value + numeric code, nothing is nulled).

    Raises ``ValueLabelsBlockedError`` when a REVERSE primary owns the column (see
    ``blocking_reverse_primary``). Checked HERE rather than only at the router
    because the router's guards are bypassable — the import path calls this
    service directly via ``cells_are_codes`` and never sees them.
    """
    blocked = blocking_reverse_primary(db, column)
    if blocked is not None:
        raise ValueLabelsBlockedError(
            f'"{blocked.name}" reverse-scores this column, so its stored numbers are '
            "reflected scores rather than the response codes. Applying value labels "
            "would relabel every response with its opposite. Remove the reverse recode "
            "in the Recode Workbench (or make another definition primary), apply the "
            "labels, then reverse-score it again."
        )

    # #592 (C4): a pair whose code (or label) the column treats as MISSING never
    # enters the label dictionary — labelled-missing pairs live in the RULES
    # (§I.2), so such a pair must not become a scale point, a mapping entry, or
    # a cell substitution. Filtered here and REPORTED (missing_skipped), never
    # silently absorbed. #605: column-aware like every other surface — the
    # declaration when present, the recognized-N/A DEFAULTS otherwise (gating
    # this on `is not None` let an UNDECLARED column label a code
    # "Not applicable": text every read surface calls missing, numeric feeding
    # every mean — the #595 split reintroduced at a write path). The defaults'
    # live arm is the LABEL — the defaults never call a bare number missing,
    # by design (§A4); a declared `[]` keeps every pair (REPLACE).
    missing_rules = parse_missing_rules(column.missing_values)
    missing_skipped: list[float] = []
    code_to_label: dict[float, str] = {}
    for code, label in pairs:
        # str(float) is fine here — the predicate's numeric-equality arm
        # bridges "99.0" vs a declared "99".
        if is_missing(str(code), missing_rules) or is_missing(label, missing_rules):
            missing_skipped.append(float(code))
            continue
        code_to_label[float(code)] = label

    if not code_to_label:
        # Every pair filtered as missing: applying would write EMPTY scale
        # metadata and an empty-mapping primary over whatever the column has —
        # destroying a real dictionary to record nothing. Report and refuse to
        # touch cells, metadata, or the primary.
        return {"updated": 0, "unlabeled_codes": [],
                "missing_skipped": sorted(missing_skipped)}

    # #590: iterate DISTINCT (value_text, value_numeric) pairs — bounded by
    # scale cardinality — and issue one bulk UPDATE per pair, instead of
    # materializing every cell as an ORM object (the import post-pass calls
    # this in a loop over columns, so the old whole-table load accumulated
    # rows × labelled_columns instances in one identity map, against the
    # <256MB backend target). na_texts and unlabeled are computed from the
    # same distinct pairs; `updated` semantics unchanged (SQLite's rowcount
    # counts every row an UPDATE touches, like the per-object loop did).
    distinct_pairs = (
        db.query(DatasetValue.value_text, DatasetValue.value_numeric)
        .filter(DatasetValue.column_id == column.id)
        .distinct()
        .all()
    )

    def _pair_update(vt, vn, target: dict) -> int:
        q = db.query(DatasetValue).filter(
            DatasetValue.column_id == column.id,
            (DatasetValue.value_text.is_(None) if vt is None
             else DatasetValue.value_text == vt),
            (DatasetValue.value_numeric.is_(None) if vn is None
             else DatasetValue.value_numeric == vn),
        )
        return q.update(target, synchronize_session="fetch")

    updated = 0
    unlabeled: set[float] = set()
    na_texts: set[str] = set()
    for vt, vn in distinct_pairs:
        if vt and is_missing(vt, missing_rules):
            # #592 §I.3 — the resurrection fix: a missing cell (declared, or
            # the defaults when undeclared) is never re-stamped with a numeric
            # and never relabelled. Pre-fix, a declared-missing bare-code cell
            # ("99", vn NULL after the declare pass) had its code recovered
            # from value_text and written back — a label re-apply silently
            # undid the declaration.
            na_texts.add(vt.strip())
            continue
        # The code-identity rule (was `_code_key`): the code a cell represents
        # is value_numeric when set (already the code after import/#580, and
        # unchanged by a prior relabel), else the parsed text; blank /
        # non-numeric → no identity, skip. ⚠️ Assumes value_numeric IS the raw
        # code — a REVERSE primary breaks that (it stores the reflected
        # score); `blocking_reverse_primary` refuses such a column before this
        # runs. Do not relax that guard without giving this rule a way to
        # recover the forward code (#585).
        code = vn if vn is not None else (_strip_numeric(vt) if vt else None)
        if code is None:
            continue
        code = float(code)
        label = code_to_label.get(code)
        if label is not None:
            # The code is authoritative; keep it in value_numeric.
            updated += _pair_update(
                vt, vn,
                {DatasetValue.value_text: label,
                 DatasetValue.value_numeric: code},
            )
        else:
            unlabeled.add(code)
            if vn != code:
                # Re-stamp the parsed code on unlabelled numeric-text cells
                # (the per-object loop always wrote it; skip the no-op case).
                _pair_update(vt, vn, {DatasetValue.value_numeric: code})

    # Scale metadata = the DECLARED dictionary, ordered by code (the numeric-aware
    # order every consumer expects). Codes store as ints when integral (#28 parity).
    ordered = sorted(code_to_label.items(), key=lambda p: p[0])
    column.scale_labels = json.dumps([label for _, label in ordered])
    column.scale_values = json.dumps(_coerce_scale_codes([code for code, _ in ordered]))
    column.scale_points = len(ordered)
    if target_type is not None:
        column.column_type = target_type

    # Primary scale_map {label: code} — the second owner of value_numeric that the
    # append re-apply and R export read. Coerce codes to int when integral so the
    # three owners (this mapping, scale_values, _compute_value_numeric) agree (#28).
    coerced = _coerce_scale_codes([code for code, _ in ordered])
    mapping = {label: coerced[i] for i, (_, label) in enumerate(ordered)}
    exclude_values = json.dumps(sorted(na_texts)) if na_texts else None

    existing_primary = (
        db.query(RecodeDefinition)
        .filter(
            RecodeDefinition.column_id == column.id,
            RecodeDefinition.is_primary == True,  # noqa: E712
        )
        .first()
    )
    if (
        existing_primary is not None
        and existing_primary.is_auto_detected
        and existing_primary.recode_type == RecodeType.SCALE_MAP
    ):
        # Re-apply / edit: reuse the auto recode so defs don't accumulate.
        existing_primary.mapping = json.dumps(mapping)
        existing_primary.exclude_values = exclude_values
    else:
        # Demote any user/other primary (kept, not deleted) and own the primary.
        db.query(RecodeDefinition).filter(
            RecodeDefinition.column_id == column.id,
            RecodeDefinition.is_primary == True,  # noqa: E712
        ).update({RecodeDefinition.is_primary: False}, synchronize_session="fetch")
        max_seq = (
            db.query(RecodeDefinition.sequence_order)
            .filter(RecodeDefinition.column_id == column.id)
            .order_by(RecodeDefinition.sequence_order.desc())
            .first()
        )
        next_seq = (max_seq[0] + 1) if max_seq else 0
        db.add(RecodeDefinition(
            column_id=column.id,
            name=f"{len(ordered)}-point scale",
            recode_type=RecodeType.SCALE_MAP,
            output_type=OutputType.NUMERIC,
            mapping=json.dumps(mapping),
            exclude_values=exclude_values,
            is_primary=True,
            is_auto_detected=True,
            sequence_order=next_seq,
        ))

    db.flush()
    return {
        "updated": updated,
        "unlabeled_codes": sorted(unlabeled),
        "missing_skipped": sorted(missing_skipped),
    }
