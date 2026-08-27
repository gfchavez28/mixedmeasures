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
import math

from sqlalchemy.orm import Session

from ..models.dataset import (
    DatasetColumn,
    DatasetValue,
    ColumnType,
    VALUE_LABEL_INELIGIBLE_TYPES,
)
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
from ..services.recode_dependents import (
    dead_definitions_for_column,
    newly_dead,
)

logger = logging.getLogger(__name__)


class ValueLabelsBlockedError(ValueError):
    """Refused: this column cannot take a declared code→label dictionary.

    Two reasons today, both raised from ``apply_value_labels`` so they hold for
    EVERY caller rather than only the ones that pass a router:

    * its ``value_numeric`` is a DERIVED score, not the code — a REVERSE primary
      (#585, see ``blocking_reverse_primary``);
    * its TYPE is in ``VALUE_LABEL_INELIGIBLE_TYPES`` — open text or an
      identifier (#589).

    One class rather than two because the outcome is identical (400 with the
    message shown verbatim); the message is what distinguishes them. A
    ``ValueError`` subclass so the router can catch it ahead of the generic
    ``ValueError`` arm (same shape as ``project_portability.MergeDivergenceError``).
    """


# ── The ceiling on a declared dictionary (#588) ──────────────────────────────
# Four write paths reach `scale_labels`, and every one of them was unbounded:
# this endpoint's payload, the import wizard's `DatasetColumnConfig`, and both
# manual-column schemas. 10,000 pairs were accepted and zero-filled into a
# 10,000-bar frequency chart (`metrics.compute_frequency_distribution` fills
# from `scale_labels`, which is what makes #577 work).
#
# ⚠️ **The bound must admit real codebooks.** `VALUE_LABEL_SEED_MAX_CODES` (30)
# is a PREVIEW SEED heuristic — how many distinct codes the wizard offers to
# pre-fill — and capping here at that number would reject ordinary SPSS data:
# a nominal variable for occupation (ISCO-08 has ~430 unit groups) or country
# (~250) legitimately carries hundreds, and `.sav` import feeds the same
# `DatasetColumnConfig`. 500 matches the house bound for "a large but real
# collection" (`MAX_XLSX_COLS`, `MAX_SAV_COLS`, `MAX_PDF_PAGES`).
MAX_VALUE_LABELS = 500


def validate_value_label_count(values: list | None, *, field: str = "labels"):
    """Cap a declared label/code list, shared by all four write schemas.

    Single-sourced for the reason `normalize_missing_rules_payload` is
    (#612/#614): a bound added to one schema leaves the other three doors open,
    and the import config is precisely the door that bypassed the endpoint.
    Returns the value so it can be used directly as a Pydantic validator.
    """
    if values is not None and len(values) > MAX_VALUE_LABELS:
        raise ValueError(
            f"Too many {field} ({len(values)}); the maximum is {MAX_VALUE_LABELS}. "
            "A dictionary this large is usually a column that should be imported "
            "as plain text or numbers rather than a labelled scale."
        )
    return values


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

    🔴 **THIS FUNCTION IS NOT THE WHOLE GUARD, AND MUST NOT BE DELETED AS
    REDUNDANT — see ``code_identity_violation`` (#793).** The premise once
    recorded here was "a scale_map leaves ``value_numeric`` == the code". That
    holds only for an IDENTITY code map: a `scale_map` writes *its mapping's
    value*, so a **flipping** or **collapsing** map on a bare-code column puts
    its output there instead, and this function returns None for it. The
    property being protected is **"the primary's output equals the code"**, and
    that is checked against the DATA in ``code_identity_violation``, which
    catches the flip, the collapse and a hand-flip keyed on LABELS alike.

    ⚠️ **Both guards are load-bearing and they rest on DIFFERENT evidence.**
    The data check recognises a REVERSE only because
    ``recode.py::write_back_scale_metadata`` leaves a labelled reverse column
    its FORWARD codes to compare against — and that write-back runs for
    ``ORDINAL`` columns ONLY. A reverse primary on a nominal column whose cells
    are labels with no scale metadata offers the data check nothing to resolve,
    and would pass it. This one keys on the definition and needs no data at all.
    It also produces the better-targeted message: it can say "reverse-scores",
    where the data check can only say "re-maps".

    CATEGORY_GROUP needs neither guard: it CLEARS ``value_numeric``
    (``recode.py::recompute_primary_value_numeric``), so the identity rule falls
    through to parsing ``value_text`` — the raw code — which is correct.

    Deliberately scoped to the PRIMARY: a non-primary reverse doesn't drive
    ``value_numeric``, so cells relabel correctly. Its own mapping keys DO go
    stale against the new labels — that was #584, CLOSED 2026-08-23 (the
    re-key arm, ``services/recode_rekey.py``).
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


def column_label_to_code(column: DatasetColumn) -> dict[str, float]:
    """The column's own ``{label: code}`` dictionary, from its scale metadata.

    The inverse of ``build_code_to_label``, reading the column's JSON columns
    rather than parsed lists. Returns ``{}`` when the metadata is absent or
    malformed — the same fail-safe, so a broken column resolves nothing rather
    than resolving wrongly.

    A duplicated label makes the inversion ambiguous; ``setdefault`` keeps the
    lowest code. The `.sav` adapter dedupes labels at import (#541a), so this is
    defensive rather than expected.
    """
    try:
        labels = json.loads(column.scale_labels) if column.scale_labels else None
        values = json.loads(column.scale_values) if column.scale_values else None
    except (json.JSONDecodeError, TypeError):
        return {}
    if not isinstance(labels, list) or not isinstance(values, list):
        return {}
    out: dict[str, float] = {}
    for code, label in build_code_to_label(labels, values).items():
        out.setdefault(str(label), code)
    return out


def code_identity_violation(
    column: DatasetColumn,
    distinct_pairs: list,
    missing_rules: list | None,
) -> dict | None:
    """The first cell whose stored code its own TEXT does not imply, or None.

    🔴 **The #793 guard.** ``apply_value_labels`` keys every cell on
    ``value_numeric`` and rewrites ``value_text`` to that code's declared label.
    That is only sound while the stored number IS the response's own code. A
    primary recode whose OUTPUT is something else puts a different number there,
    so relabelling records each participant as having given a DIFFERENT answer —
    and the result is self-consistent afterwards (text and code agree with each
    other and with nothing else), which is why nothing downstream looks wrong.

    ⚠️ **This tests the DATA, not the mapping's shape, and that is the whole
    point.** #793's filed entry proposed "unsafe iff any NUMERIC key maps to a
    value other than itself". That inspects the definition, and it is
    incomplete twice over: a hand-flip keyed on LABELS (``{"Never": 5, …}``) has
    no numeric keys and passes it **vacuously**, and a mapping gone stale
    against the column's cell texts (#794) is judged on keys that decide
    nothing. Scoping the guard by KEY SHAPE repeats the TYPE-scoping error that
    made #585's guard miss #793.

    Two sources for "the code this text represents", in the order the identity
    rule itself reaches for them:

      1. the column's declared scale metadata (label → code) — the labelled
         column's answer, and what recognises a REVERSE (its metadata stays in
         FORWARD codes while its cells hold reflected scores);
      2. the text parsed as a bare number — the coded column's answer, and what
         catches #793's flagship case (`("1", 5.0)` under a flipping primary).

    A cell that resolves to neither makes no claim about a code: relabelling
    would not touch it, so it is not evidence either way and is skipped. Cells
    the column treats as MISSING are skipped for the same reason
    ``apply_value_labels`` skips them (#592 §I.3).

    ⚠️ **Membership is tested with ``in``, never a falsy check on the result** —
    code ``0`` is real (SPSS 0-based scales, #28/D2), and ``label_to_code.get(t)
    or …`` would send every zero-coded cell down the parse branch. The
    falsy-zero trap, the same one ``effective_reverse_offset`` documents.

    Returns the first violation as ``{"value_text", "stored_code",
    "text_implies"}`` — the first, not all of them, because the caller refuses
    the whole operation and one concrete example is what makes the refusal
    legible to a researcher.
    """
    label_to_code = column_label_to_code(column)
    for value_text, value_numeric in distinct_pairs:
        if value_numeric is None or not value_text or not value_text.strip():
            continue
        if is_missing(value_text, missing_rules):
            continue
        implied = None
        for key in (value_text, value_text.strip()):
            if key in label_to_code:
                implied = label_to_code[key]
                break
        if implied is None:
            implied = _strip_numeric(value_text)
        if implied is None:
            continue
        # Codes are exact in practice; the tolerance guards a float round-trip
        # and is far too tight to absorb a real off-by-one.
        if not math.isclose(implied, float(value_numeric), rel_tol=0.0, abs_tol=1e-9):
            return {
                "value_text": value_text,
                "stored_code": float(value_numeric),
                "text_implies": implied,
            }
    return None


def _code_for_message(code: float) -> str:
    """A code as a researcher would write it: 5, not 5.0.

    Deliberately NOT named ``_fmt_code``: ``missing_values.py`` owns a helper by
    that name whose integer-awareness is load-bearing for CELL text (#612), and
    this one only ever formats prose.
    """
    return f"{code:g}"


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
    ``blocking_reverse_primary``) or when the column's TYPE cannot carry labels
    (#589). Checked HERE rather than only at the router because the router's
    guards are bypassable — the import path calls this service directly via
    ``cells_are_codes`` and never sees them.
    """
    # #589: the type gate lives on the OPERATION, not only at the router that
    # happens to be the human entry point. `import_dataset_csv`'s post-pass
    # calls this directly, so a config declaring `column_type: "open_text",
    # cells_are_codes: true` used to substitute labels into free-form responses
    # and mint a primary scale_map — the exact state the retro endpoint answers
    # 400 for. Both the CURRENT type and the requested TARGET type are checked:
    # neither may be an ineligible one, so this cannot be sidestepped by
    # arriving as open_text and asking to become ordinal in the same call.
    for candidate in (column.column_type, target_type):
        if candidate is not None and candidate in VALUE_LABEL_INELIGIBLE_TYPES:
            kind = getattr(candidate, "value", candidate)
            raise ValueLabelsBlockedError(
                f"Value labels cannot be applied to {kind} columns. "
                "Open-text responses are what the participant wrote, and an "
                "identifier's value IS the identity — substituting a label "
                "would overwrite both. Change the column's type first if the "
                "cells really are numeric codes."
            )

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
    # #584: which definitions were ALREADY unmapped before this call. Taken
    # before a single cell moves, because this operation must be blamed only
    # for what it actually breaks — a mapping that matched nothing when we
    # arrived is not this relabel's doing.
    dead_before = dead_definitions_for_column(db, column)

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
                "missing_skipped": sorted(missing_skipped),
                # Nothing was touched, so nothing can have been staled.
                "staled_definitions": []}

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

    # #793: the code-identity guard, over the pairs just fetched — no extra
    # query, and BEFORE a single UPDATE is issued. `blocking_reverse_primary`
    # above keys on the DEFINITION; this keys on the DATA, and the two cover
    # different holes (see that function's docstring — neither is redundant).
    violation = code_identity_violation(column, distinct_pairs, missing_rules)
    if violation is not None:
        culprit = (
            db.query(RecodeDefinition)
            .filter(
                RecodeDefinition.column_id == column.id,
                RecodeDefinition.is_primary == True,  # noqa: E712
            )
            .first()
        )
        stored = _code_for_message(violation["stored_code"])
        implied = _code_for_message(violation["text_implies"])
        # Name the recode when there is one. A violation with no primary means
        # the stored numbers disagree with the responses for some other reason
        # (a hand-edited column, a half-finished import) — still unsafe, and the
        # message must not invent a culprit it did not find.
        owner = (
            f'"{culprit.name}" re-maps this column'
            if culprit is not None
            else "This column's stored numbers were re-mapped"
        )
        raise ValueLabelsBlockedError(
            f"{owner}, so the number stored against each response is that "
            "recode's output rather than the response's own code — the response "
            f"{violation['value_text']!r} is stored as {stored}, not {implied}. "
            f"Labelling here would record it as whatever label you give code "
            f"{stored}, which is a different answer. "
            "Remove that recode in the Recode Workbench (or make another "
            "definition primary), apply the labels, then re-apply it."
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

    # #584 trigger 2: substituting labels into `value_text` RE-KEYS the column,
    # so every definition still keyed on the old cell text stops matching —
    # measured, FOUR of five on a realistic column, not just the linked reverse
    # the filed entry describes. Reported, never repaired: re-deriving one
    # changes stored numbers a researcher may already have reported.
    staled = newly_dead(dead_before, dead_definitions_for_column(db, column))

    return {
        "updated": updated,
        "unlabeled_codes": sorted(unlabeled),
        "missing_skipped": sorted(missing_skipped),
        "staled_definitions": [d.to_dict() for d in staled],
    }
