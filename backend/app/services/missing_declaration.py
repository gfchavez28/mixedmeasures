"""Declare / un-declare a column's missing values (#592 slab 3, plan §J.4).

The predicate module (``missing_values.py``) owns the DECISION; this module
owns the MUTATION — it sits above ``missing_values`` / ``recode`` /
``dataset_import`` in the import graph because it needs all three (the
predicate module itself is imported by the other two, so the orchestrator
cannot live there).

Order of operations is load-bearing (§I.3):

1. **Recovery FIRST, through the OLD rules**: cells missing under the old
   rules but substantive under the new recover their ``value_numeric`` via
   the column's standard compute (primary recode / ``_compute_value_numeric``
   — both column-aware since slab 3's writer pass, so a recovered text that
   is STILL missing under the new rules correctly recomputes to NULL).
   J-D3 (locked): a LABELLED missing pair un-declares by reverting cells to
   the raw code text ("Refused" → "99") — the label channel of the OLD rules
   is the only thing that can still reach those cells; no scale-metadata
   surgery (re-labelling as a regular pair is the value-labels dialog's job).
2. **Persist** the new rules.
3. **C4**: strip newly-missing codes out of the scale metadata — a missing code
   is never a scale point, and ``compute_frequency_distribution`` zero-fills
   every ``scale_labels`` entry, so one left behind renders a phantom bar in
   every frequency chart, forever.
4. **NULL pass**: cells matching the new rules get ``value_numeric = NULL``, and
   a rule carrying a LABEL also substitutes it into ``value_text`` ("99" →
   "Refused") — the mirror of J-D3, and what makes declaring and labelling
   COMMUTE (slab 3b), so the dialog cannot get the order wrong.
   Distinct-values + one bulk UPDATE per target — the #590-approved shape,
   never whole-table ORM materialization.
5. **Re-apply a numeric primary (#603)**: a declaration changes
   ``effective_reverse_offset``'s input set, so on a REVERSE primary every
   ALREADY-STORED cell is reflected about the wrong endpoint until the
   definition re-applies — the NULL pass fixes only the declared cells' own
   rows ("Never" stayed 99.0 while a fresh compute said 5.0). Deliberately
   ``apply_definition_to_column``, NOT ``recompute_primary_value_numeric``:
   the latter also runs ``write_back_scale_metadata``, which on UN-declare
   would re-add a numeric sentinel to ``scale_labels`` (the defaults don't
   call "99" missing) — violating J-D3's "un-declare does not re-add the
   pair". category_group needs nothing (all-NULL under clear semantics).
   ⚠️ The ``db.flush()`` before it is load-bearing: the session runs
   ``autoflush=False`` and ``apply_definition_to_column`` re-reads
   ``column.missing_values`` FROM THE DB, so without the flush it re-applies
   under the OLD declaration and this step silently no-ops (the #439 class).
6. Staleness: the caller marks (``mark_metrics_stale`` cascades to dependent
   computed columns and statistical tests).

**The label-collision guard (#606)** runs before any write: a labelled rule
whose label collides with text that means something else on this column —
another rule's label or value, an existing scale label for a DIFFERENT code,
or an observed substantive response — is refused. Without it, declaring
``{99 = "Agree"}`` on a column whose real code 2 is labelled "Agree" NULLed
every real "Agree" cell (the predicate's label arm matched them) and
un-declare rewrote their text to "99" — participant answers destroyed,
silently and non-idempotently (the #585 shape one seam over). The commute is
preserved by the allow-list: a label already paired with the SAME code in the
scale metadata (label→declare order), or an identical ``{value, label}`` pair
in the OLD rules (idempotent re-declare), passes. Safe to RAISE: this
service's only caller is the endpoint — no boot or import path (verified).

There is deliberately **no reverse-def guard** here. One existed (J-D2) and was
removed with #600: the reflection offset is now computed over non-null-set
values (``recode.effective_reverse_offset``), so the state it refused can no
longer be written, and refusing the declaration only blocked the researcher's
correct action. It could not simply be narrowed either — it and the apply-side
guard were a matched pair, and keeping the apply-side one while allowing the
declaration would raise inside startup's ``repair_reverse_recode_mappings``,
i.e. break boot on existing data.

``new_rules=None`` un-declares — the recognized-N/A DEFAULTS apply again
(NOT "nothing is missing"; that is the explicit ``[]`` declaration).
"""
import json
import logging

from sqlalchemy.orm import Session

from ..models.dataset import DatasetColumn, DatasetValue
from ..models.recode import RecodeDefinition, RecodeType
from .missing_values import (
    _as_float,
    _fmt_code,
    is_missing,
    matched_missing_label,
    parse_missing_rules,
)
from .recode import apply_definition_to_column, compute_value
from .dataset_import import _compute_value_numeric

logger = logging.getLogger(__name__)


class MissingRuleCollisionError(ValueError):
    """Refused: a rule's LABEL collides with text that means something else.

    A ``ValueError`` subclass so the router maps it to a 400 (the
    ``ValueLabelsBlockedError`` shape). See the module docstring for why this
    is a hard refusal and which two cases are deliberately allowed.
    """


def _assert_no_label_collisions(
    new_rules: list[dict],
    old_rules: list[dict] | None,
    distinct_texts: list[str],
    scale_labels: list | None,
    scale_values: list | None,
) -> None:
    """#606: refuse a labelled rule whose label is AMBIGUOUS on this column.

    The predicate's label arm matches cells by TEXT, so a rule label equal to
    text that denotes a different value makes those cells missing (NULL) at
    declare time and rewrites them to this rule's code at un-declare — silent
    destruction. Checks, in order:

    1. In-payload coherence: duplicate labels; a label equal to a DIFFERENT
       rule's value (exact or numeric-equal).
    2. Scale metadata: a label already paired with a DIFFERENT code. The SAME
       code is the label→declare commute and is allowed.
    3. Observed texts: a label equal to a distinct observed ``value_text``,
       unless the OLD rules already bind this exact ``{value, label}`` pair
       (idempotent re-declare) — which also refuses reusing a label under a
       CHANGED code (identity would silently reassign; un-declare first).

    A label equal to the rule's OWN value is exempt from (3) — substitution is
    a no-op and recovery unambiguous. Range labels are display-only (never
    matched against cells) and not checked.
    """
    labelled = [r for r in new_rules if "value" in r and r.get("label")]
    if not labelled:
        return

    seen_labels: set[str] = set()
    values = [(r["value"], _as_float(r["value"])) for r in new_rules if "value" in r]
    for rule in labelled:
        label = rule["label"]
        if label in seen_labels:
            raise MissingRuleCollisionError(
                f'Two rules share the label "{label}" — every missing value '
                "needs its own label."
            )
        seen_labels.add(label)
        label_num = _as_float(label)
        for other_text, other_num in values:
            if other_text == rule["value"]:
                continue
            if label == other_text or (
                label_num is not None and other_num is not None
                and label_num == other_num
            ):
                raise MissingRuleCollisionError(
                    f'"{label}" is itself declared as a missing value by '
                    f'another rule — give code {rule["value"]} a distinct label.'
                )

    code_by_label: dict[str, float] = {}
    if scale_labels and scale_values and len(scale_labels) == len(scale_values):
        for lab, code in zip(scale_labels, scale_values):
            num = _as_float(code)
            if num is not None:
                code_by_label[str(lab)] = num

    observed = {t.strip() for t in distinct_texts}
    old_pairs = {
        (r["value"], r["label"]) for r in (old_rules or [])
        if "value" in r and r.get("label")
    }
    for rule in labelled:
        label, value = rule["label"], rule["value"]
        rule_num = _as_float(value)
        paired = code_by_label.get(label)
        if paired is not None:
            if rule_num is not None and rule_num == paired:
                continue  # the commute: this label already belongs to THIS code
            raise MissingRuleCollisionError(
                f'"{label}" is already the label for code {_fmt_code(paired)} '
                f"on this column. A missing rule for {value} cannot reuse it — "
                f"pick a distinct label, or declare code {_fmt_code(paired)} "
                "missing instead."
            )
        label_num = _as_float(label)
        if label == value or (
            label_num is not None and rule_num is not None
            and label_num == rule_num
        ):
            continue  # self-labelled code — substitution is a no-op
        if label in observed and (value, label) not in old_pairs:
            raise MissingRuleCollisionError(
                f'"{label}" already appears in this column’s data as a '
                f"response. Substituting it for {value} would make those "
                "responses indistinguishable — pick a distinct label."
            )


def _strip_missing_scale_points(column: DatasetColumn, new_rules: list[dict] | None) -> int:
    """C4, write-side: a declared-missing code is never a scale point (#592).

    ``compute_frequency_distribution`` zero-fills every ``scale_labels`` entry,
    so a "Refused" left in the metadata renders a phantom zero-count bar in
    every frequency chart — permanently, because nothing else revisits it. That
    is exactly what the label→declare order produced before this existed: the
    cell was correctly excluded while the scale still advertised the level.

    Keyed on the CODE (``scale_values``), never the label: a rule may carry no
    label, and a range never matches label text. That also makes un-declaring a
    no-op here — codes like "3" are not missing under the recognized-N/A
    defaults — which is the J-D3 symmetry: un-declare does NOT re-add the pair;
    the researcher re-adds it as a regular label if that is what they meant.

    Skipped when the metadata carries no codes to key on (labels-only columns
    are not produced by ``apply_value_labels``, which always writes both).
    """
    if not new_rules:
        return 0
    try:
        labels = json.loads(column.scale_labels) if column.scale_labels else None
        codes = json.loads(column.scale_values) if column.scale_values else None
    except (json.JSONDecodeError, TypeError):
        return 0
    if not labels or not codes or len(labels) != len(codes):
        return 0

    keep = [i for i, code in enumerate(codes) if not is_missing(str(code), new_rules)]
    if len(keep) == len(labels):
        return 0
    stripped = len(labels) - len(keep)
    # Never destroy the metadata outright — a declaration covering every scale
    # point is a mis-declaration, not an instruction to erase the scale.
    if not keep:
        return 0
    column.scale_labels = json.dumps([labels[i] for i in keep])
    column.scale_values = json.dumps([codes[i] for i in keep])
    if getattr(column, "scale_points", None) is not None:
        column.scale_points = len(keep)
    return stripped


def apply_missing_declaration(
    db: Session,
    column: DatasetColumn,
    new_rules: list[dict] | None,
) -> dict:
    """Set (or clear) the column's missing declaration and re-align every
    cell's ``value_numeric`` with it. Flushes, never commits.

    ``new_rules`` must be normalized (the endpoint validates through
    ``missing_values._validate_rule``); ``None`` = un-declare (defaults).

    Returns ``{"nulled_rows", "labelled_rows", "stripped_scale_points",
    "recovered_rows", "recovered_values", "recovered_unmapped"}`` —
    ``recovered_unmapped`` lists recovered texts whose code the column's
    compute could not produce (e.g. a code absent from a scale_map primary's
    mapping): their cells stay text-only, exactly like any other unmapped
    value, for the researcher to map or label.
    """
    old_rules = parse_missing_rules(column.missing_values)

    distinct = [
        v for (v,) in db.query(DatasetValue.value_text)
        .filter(
            DatasetValue.column_id == column.id,
            DatasetValue.value_text.isnot(None),
            DatasetValue.value_text != "",
        )
        .distinct()
        .all()
    ]

    try:
        scale_labels = json.loads(column.scale_labels) if column.scale_labels else None
        scale_values = json.loads(column.scale_values) if column.scale_values else None
    except (json.JSONDecodeError, TypeError):
        scale_labels = scale_values = None

    # ── Guard (#606): refuse ambiguous labels BEFORE any write ──
    if new_rules:
        _assert_no_label_collisions(
            new_rules, old_rules, distinct, scale_labels, scale_values,
        )

    to_recover = [
        v for v in distinct
        if is_missing(v, old_rules) and not is_missing(v, new_rules)
    ]
    # #612: recover CODE texts before LABEL texts. A label-arm recovery
    # rewrites value_text INTO its raw code text ("Refused" → "99"), so a
    # LATER update targeting that code text would re-match the rows the label
    # pass just rewrote and double-count recovered_rows (data unaffected —
    # both arms write the same target — but the reported count and the audit
    # log inflate). Code-first can never re-match: a code-arm recovery is
    # identity on value_text. The distinct query is unordered, so without
    # this sort the count was nondeterministically wrong.
    old_label_texts = {
        r["label"] for r in (old_rules or []) if "value" in r and r.get("label")
    }
    to_recover.sort(key=lambda t: t in old_label_texts)
    to_null = [v for v in distinct if is_missing(v, new_rules)]

    # ── Recovery (before persisting; needs the OLD rules' label channel) ──
    primary = (
        db.query(RecodeDefinition)
        .filter(
            RecodeDefinition.column_id == column.id,
            RecodeDefinition.is_primary == True,  # noqa: E712
        )
        .first()
    )
    primary_rtype = None
    if primary is not None:
        primary_rtype = (
            primary.recode_type.value
            if hasattr(primary.recode_type, "value") else str(primary.recode_type)
        )
    col_type = (
        column.column_type.value
        if hasattr(column.column_type, "value") else str(column.column_type)
    )

    recovered_rows = 0
    recovered_values: list[str] = []
    recovered_unmapped: list[str] = []
    for text in to_recover:
        target_text = text
        if old_rules:
            # J-D3: a labelled-missing cell reverts to its raw code text.
            label_rule = next(
                (r for r in old_rules
                 if r.get("label") == text and "value" in r),
                None,
            )
            if label_rule is not None:
                target_text = label_rule["value"]

        # The standard vn compute, column-aware under the NEW rules — so a
        # reverted code that the new rules STILL mark missing lands NULL.
        if primary is not None and primary_rtype == "category_group":
            # The apply-vs-clear decision (#581/#578): a category_group primary
            # keeps value_numeric NULL column-wide. compute_value returns the
            # GROUP NAME here, and a float-parsable one ("1".."3" bands) would
            # smuggle a numeric onto an all-NULL column (#603 rider).
            vn = None
        elif primary is not None:
            computed = compute_value(target_text, primary, missing_rules=new_rules)
            try:
                vn = float(computed) if computed is not None else None
            except (ValueError, TypeError):
                vn = None
        else:
            vn = _compute_value_numeric(
                target_text, col_type, scale_labels, scale_values,
                missing_rules=new_rules,
            )
        if (
            vn is None
            and not is_missing(target_text, new_rules)
            and primary_rtype != "category_group"
        ):
            # Not reported under a category_group primary — text-only is that
            # column's designed state, not an unmapped value.
            recovered_unmapped.append(target_text)

        recovered_rows += (
            db.query(DatasetValue)
            .filter(
                DatasetValue.column_id == column.id,
                DatasetValue.value_text == text,
            )
            .update(
                {DatasetValue.value_text: target_text,
                 DatasetValue.value_numeric: vn},
                synchronize_session="fetch",
            )
        )
        recovered_values.append(text)

    # ── Persist ──
    column.missing_values = (
        json.dumps(new_rules) if new_rules is not None else None
    )

    # ── C4: strip newly-missing codes out of the scale metadata ──
    stripped_scale_points = _strip_missing_scale_points(column, new_rules)

    # ── NULL pass (distinct values + bulk UPDATE per target — the #590 shape) ──
    #
    # A rule carrying a LABEL also substitutes it into value_text, exactly as
    # the .sav adapter and the append channel already do (§I.2b). Without this
    # the two halves assume opposite states: declaring "99 = Refused" left every
    # existing cell reading "99" while an APPENDED "99" landed as "Refused" — the
    # same code rendering two ways in one column, and the dedup fingerprint
    # missing precisely the rows it exists to match. Symmetric with J-D3, which
    # reverts "Refused" -> "99" on un-declare.
    nulled_rows = 0
    labelled_rows = 0
    if to_null:
        by_target: dict[str | None, list[str]] = {}
        for text in to_null:
            by_target.setdefault(matched_missing_label(text, new_rules), []).append(text)
        for target, texts in by_target.items():
            payload = {DatasetValue.value_numeric: None}
            if target is not None:
                payload[DatasetValue.value_text] = target
            n = (
                db.query(DatasetValue)
                .filter(
                    DatasetValue.column_id == column.id,
                    DatasetValue.value_text.in_(texts),
                )
                .update(payload, synchronize_session="fetch")
            )
            nulled_rows += n
            if target is not None:
                labelled_rows += n

    # ── #603: re-align a numeric primary with the NEW rules ──
    # A declaration changes `effective_reverse_offset`'s input set, so on a
    # REVERSE primary every already-stored cell reflects about the wrong
    # endpoint until the definition re-applies (the passes above touch only
    # the recovered/declared cells' own rows). apply_definition_to_column,
    # never recompute_primary_value_numeric — the write-back would re-add a
    # numeric sentinel to scale_labels on UN-declare (J-D3 forbids re-adding).
    # scale_map re-apply is a cheap idempotent no-op; category_group columns
    # are all-NULL by clear semantics and need nothing.
    if primary is not None and primary_rtype in ("scale_map", "reverse"):
        # Load-bearing flush (#439 class): the session runs autoflush=False and
        # apply_definition_to_column re-reads column.missing_values FROM THE
        # DB — without this it re-applies under the OLD declaration.
        db.flush()
        apply_definition_to_column(db, primary)

    db.flush()
    return {
        "nulled_rows": nulled_rows,
        "labelled_rows": labelled_rows,
        "stripped_scale_points": stripped_scale_points,
        "recovered_rows": recovered_rows,
        "recovered_values": recovered_values,
        "recovered_unmapped": recovered_unmapped,
    }
