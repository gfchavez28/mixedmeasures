"""Derive a NEW variable from an existing one through a recode rule — Decision B.

## Why this exists

MM's recode rewrites the variable in place. The developer — the target user,
fluent in SPSS and R — reported bouncing off exactly that: *"I'm familiar with
creating a different variable derived from a previous variable. My concern is
that MM is trying to do the latter without creating a separate variable."* This
module is the latter.

## The shape, and the two shapes it is NOT

A derived column is a **snapshot**: its cells are computed once from the source's
cells and never recompute. That is SPSS's `RECODE … INTO` and R's
`mutate(x_r = 6 - x)`, and it is why provenance is a NAME rather than a live FK
(see `models/dataset.py`).

⚠️ **It is `source="manual"`, never `"computed"`.** A computed column is refused
value labels, missing-value declarations AND recode definitions by three separate
endpoints whatever its type (#806) — a derived variable you cannot label is
useless. It also has no `expression`, which is what keeps it out of every
computed-column recompute and topological sort (all three readers of
`depends_on_column_ids` gate on `expression IS NOT NULL`).

⚠️ **The output is stored as BARE CODES, and nothing is inherited by default.**
Two rejected alternatives, both of which look obvious:

- *Copy the source's labels verbatim.* A reverse-derived cell would then hold
  ``value_text="Never"`` with ``value_numeric=5`` — text and code in different
  spaces, which is precisely the state `code_identity_violation` exists to
  refuse (#585/#793). The column would be un-labellable forever.
- *Reverse the text too.* A respondent who said "Never" did not say "Always".

So the cells land as ``("5", 5.0)`` — the identity holds, every existing guard
passes — and the dictionary is offered SEPARATELY as a re-paired suggestion
applied through `apply_value_labels`, which owns the cell rule, the C4 missing
strip, the #606 collision guard and the #793 pair. This module writes no labels
itself.

## Two things that must travel together, or the result is worse than either

`apply_definition_to_column` NULLs cells in the null set (declared missing, or
the recognized-N/A defaults). For a derived column that leaves a choice, and both
naive answers are wrong:

1. **Blank them** → "Refused" and "never answered" become indistinguishable.
   That is #596's lesson verbatim, and it cost a release note.
2. **Carry the text through but not the DECLARATION** → the derived column falls
   back to the `_is_na` defaults, which are an English prefix list. GSS's five
   `.x:` sentinels match none of them, so ~42% of its cells would silently
   become data feeding the means.

So the text is carried through **and** ``missing_values`` is copied. Neither half
is optional and neither works alone.

## Unmapped values are disclosed, never prevented

A source value the mapping does not cover produces no code. It is carried through
as text with a NULL number — visible, not deleted — and named in the plan the UI
shows BEFORE the create, so it is a decision rather than a discovery (#794).
"""

import json
from dataclasses import dataclass, field

from sqlalchemy import func, case, insert, select
from sqlalchemy.orm import Session

from ..models.dataset import DatasetColumn, DatasetValue
from ..models.recode import RecodeDefinition, RecodeType, OutputType
from .missing_values import _fmt_code
from .recode import plan_definition_over_column


class DeriveColumnError(Exception):
    """The derivation cannot be performed, with a researcher-facing reason."""


#: Codes/labels a derived column could inherit, re-paired through the mapping.
@dataclass(frozen=True)
class LabelCarryPlan:
    available: bool
    reason: str | None = None
    pairs: list[tuple[float, str]] = field(default_factory=list)


@dataclass(frozen=True)
class DerivePlan:
    """What deriving WOULD do — computed read-only so the UI can show it first."""
    output_type: str            # 'numeric' | 'categorical'
    column_type: str            # the type the new column will carry
    mapped: list[tuple[str, str]]      # (source text, output as displayed)
    unmapped: list[str]
    null_set: list[str]
    labels: LabelCarryPlan
    suggested_name: str


def _output_text(value) -> str:
    """Render a mapped output for ``value_text``.

    ``_fmt_code`` is the project's one integer-aware code-to-text formatter and
    its docstring already names this exact job ("every place a rule's value is
    written INTO cells"): a naive ``str(5.0)`` would land ``"5.0"`` in a column
    whose codes read ``5``, and the three-owner agreement (#28) would break at
    the first append.
    """
    return value if isinstance(value, str) else _fmt_code(value)


def _squash(text: str) -> str:
    """Lowercase alphanumerics only — for comparing names people typed.

    `Math_Anxiety` and `Math Anxiety` are the same name to a researcher and
    different strings to `in`. Separators are exactly what varies between a
    machine short name and a human rule name, so they are what to drop.
    """
    return "".join(ch for ch in text.lower() if ch.isalnum())


def _suggested_name(column: DatasetColumn, definition: RecodeDefinition) -> str:
    """A name the researcher will usually keep, from the source and the rule.

    🔴 **Found by driving the real dev corpus, not by any test.** The first
    version was unconditionally ``f"{base} ({definition.name})"``, which on the
    column this feature exists for produced

        Math_Anxiety (Math Anxiety (inverted))

    — nested parentheses, with the variable's name in it twice. Every fixture in
    the test suite used a rule name that did NOT contain its column's name, so
    the suite was blind to it and would have stayed blind.

    The rule is: a researcher names a recode after the variable it acts on far
    more often than not, so when the rule's name already carries the variable's,
    the rule name alone IS the derived variable's name. Compared through
    ``_squash`` because the duplication is real while the strings differ —
    `Math_Anxiety` vs `Math Anxiety`, which a plain substring test misses.

    Truncated to the column's own ``String(255)`` ceiling rather than left for
    SQLite to accept silently — SQLite does not enforce VARCHAR length, so an
    over-long name would round-trip fine here and fail on a PostgreSQL migration
    (`.mmproject` is the designed bridge).
    """
    base = column.column_name or column.column_text or f"Column {column.id}"
    if _squash(base) and _squash(base) in _squash(definition.name):
        return definition.name[:255]
    return f"{base} ({definition.name})"[:255]


def plan_derived_column(
    db: Session,
    column: DatasetColumn,
    definition: RecodeDefinition,
) -> DerivePlan:
    """Compute — WITHOUT writing — what deriving this rule would produce.

    Read-only, so the same function answers the dialog's preview and the create
    endpoint's own work. That is deliberate: a preview computed by different code
    from the operation is a preview that can be wrong.
    """
    dispositions = plan_definition_over_column(db, definition)

    is_categorical = definition.output_type == OutputType.CATEGORICAL
    mapped = [
        (d.value_text, _output_text(d.output))
        for d in dispositions if d.kind == "mapped"
    ]
    unmapped = [d.value_text for d in dispositions if d.kind == "unmapped"]
    null_set = [d.value_text for d in dispositions if d.kind == "null_set"]

    return DerivePlan(
        output_type="categorical" if is_categorical else "numeric",
        # A category group outputs NAMES, so the result is nominal. Numeric
        # output starts as `numeric` and NOT `ordinal` on purpose:
        # `ManualColumnCreate` refuses an ordinal with fewer than two scale
        # labels, and bare codes have none. Applying the dictionary promotes it
        # — `apply_value_labels` takes a `target_type` for exactly that.
        column_type="nominal" if is_categorical else "numeric",
        mapped=mapped,
        unmapped=unmapped,
        null_set=null_set,
        labels=_plan_label_carry(column, definition, dispositions, is_categorical),
        suggested_name=_suggested_name(column, definition),
    )


def _plan_label_carry(
    column: DatasetColumn,
    definition: RecodeDefinition,
    dispositions: list,
    is_categorical: bool,
) -> LabelCarryPlan:
    """Can the source's dictionary come across, re-paired to the new codes?

    §8 of the design note blocks Decision B on this question, noting that a
    reverse score wants its labels REVERSED, which is not a copy. It is not a
    copy — it is a **re-pairing**, and the mapping already carries everything
    needed to compute it: each mapped cell's source text IS the source's label
    (that is the `.sav`-identical state), and its output IS the derived code.

    Four states, and each has to say WHY on screen rather than just being absent:
    """
    if is_categorical:
        return LabelCarryPlan(
            False,
            "A category group's output is already a name, so there are no codes "
            "to label.",
        )
    if not column.scale_labels:
        # The mapping's keys are code STRINGS on an unlabelled column, so the
        # "labels" would be "1", "2", "3" — pointless, and they would then be
        # substituted INTO the cells as though they meant something.
        return LabelCarryPlan(
            False,
            "This variable has no value labels to carry across.",
        )

    pairs = [(d.output, d.value_text) for d in dispositions if d.kind == "mapped"]
    if not pairs:
        return LabelCarryPlan(False, "This rule maps none of the stored responses.")

    codes = [c for c, _ in pairs]
    if len(set(codes)) != len(codes):
        # A COLLAPSING map: several responses land on one code, so the merged
        # code has several candidate names and no rule can pick. Refusing beats
        # guessing, and the researcher can label it afterwards in one step.
        return LabelCarryPlan(
            False,
            "This rule merges responses onto shared codes, so the merged "
            "categories need names you choose. Create the variable, then add "
            "value labels to it.",
        )
    labels = [ln for _, ln in pairs]
    if len(set(labels)) != len(labels):
        return LabelCarryPlan(
            False,
            "Two responses share a label, so the carried dictionary would be "
            "ambiguous.",
        )
    return LabelCarryPlan(True, None, sorted(pairs, key=lambda p: p[0]))


def derive_column(
    db: Session,
    column: DatasetColumn,
    definition: RecodeDefinition,
    name: str,
    carry_labels: bool = False,
) -> tuple[DatasetColumn, dict]:
    """Create a new column holding this rule's output. The source is untouched.

    Returns ``(new_column, report)``. The caller commits.
    """
    plan = plan_derived_column(db, column, definition)
    if not plan.mapped:
        # Every key stale against the column's text — #794's totally-dead case,
        # which promoting would 500 on. Here it would silently produce a column
        # of nothing, so it is refused at the door with the way out named.
        raise DeriveColumnError(
            f'"{definition.name}" does not match any response stored in this '
            "variable, so it would produce an empty column. Its mapping has "
            "probably gone stale against relabelled values — re-key it first."
        )
    if carry_labels and not plan.labels.available:
        raise DeriveColumnError(plan.labels.reason or "Value labels cannot be carried across.")

    dataset_id = column.dataset_id
    new_col = DatasetColumn(
        dataset_id=dataset_id,
        column_code=_next_derived_code(db, dataset_id),
        column_text=name,
        column_type=plan.column_type,
        sequence_order=_next_order(db, dataset_id, DatasetColumn.sequence_order),
        display_order=_next_order(db, dataset_id, DatasetColumn.display_order),
        # BOTH halves of the missing story, or neither works — see the module
        # docstring. The text is carried through by the INSERT's ELSE branch;
        # this is the declaration that makes it mean anything.
        missing_values=column.missing_values,
        source="manual",
        derived_from_column_id=column.id,
        derived_via=definition.name[:255],
        # Inherited because they describe the RESEARCH context rather than the
        # values: a derived variable belongs to the same block of the instrument.
        group_code=column.group_code,
        group_label=column.group_label,
    )
    db.add(new_col)
    db.flush()

    written = _insert_derived_values(db, column, new_col, plan)

    report = {
        "created_column_id": new_col.id,
        "values_written": written,
        "unmapped_values": plan.unmapped,
        "missing_values_carried": plan.null_set,
        "labels_carried": False,
    }

    if carry_labels:
        # Routed through the service that OWNS the cell rule rather than writing
        # labels here: it carries the type gate (#589), the reverse guard and the
        # code-identity pair (#585/#793), the C4 missing strip, and the primary
        # scale_map every downstream reader expects. A second implementation of
        # label substitution is the substrate debt this arc has been retiring.
        from .value_labels import apply_value_labels
        from ..models.dataset import ColumnType
        apply_value_labels(
            db, new_col, plan.labels.pairs,
            target_type=ColumnType.ORDINAL if column.column_type == ColumnType.ORDINAL else None,
        )
        report["labels_carried"] = True

    return new_col, report


def _next_derived_code(db: Session, dataset_id: int) -> str:
    """``D001``… — a namespace of its own, beside manual's ``M001``.

    Sharing ``M`` would make the two indistinguishable in an export header, and
    `create_manual_column`'s own max-scan filters on `LIKE 'M%'`, so a derived
    column carrying an M-code would silently enter its numbering.
    """
    existing = (
        db.query(DatasetColumn.column_code)
        .filter(
            DatasetColumn.dataset_id == dataset_id,
            DatasetColumn.column_code.like("D%"),
        )
        .all()
    )
    max_num = 0
    for (code,) in existing:
        try:
            max_num = max(max_num, int(code[1:]))
        except (ValueError, IndexError, TypeError):
            pass
    return f"D{max_num + 1:03d}"


def _next_order(db: Session, dataset_id: int, col) -> int:
    return (
        db.query(func.max(col)).filter(DatasetColumn.dataset_id == dataset_id).scalar() or 0
    ) + 1


def _insert_derived_values(
    db: Session,
    source: DatasetColumn,
    target: DatasetColumn,
    plan: DerivePlan,
) -> int:
    """One ``INSERT … SELECT``. No cell round-trips through Python.

    🔴 **Scale is the reason this is not a loop.** The dev corpus's GSS import is
    75,699 rows in one column; #799 measured what materialising that many Python
    objects costs (`list(csv.reader(...))` was +288 MB for 3.1M small strings)
    and #796b measured what per-row round trips cost (374.8s). This is one
    statement whose CASE is bounded by the column's DISTINCT values — typically
    a handful for anything worth recoding — not by its row count.

    Rows where the source has no value produce no row here, mirroring the source
    exactly. That differs from `create_manual_column`, which pre-creates an empty
    row per dataset row because a hand-entered column has no source to mirror.
    """
    text_whens = []
    num_whens = []
    for src_text, out_text in plan.mapped:
        key = src_text.strip().lower()
        cond = func.lower(func.trim(DatasetValue.value_text)) == key
        text_whens.append((cond, out_text))
        if plan.output_type == "numeric":
            num_whens.append((cond, float(out_text)))

    # ELSE carries the source's own text through — that is the null-set and
    # unmapped branch in one. `value_numeric` is NULL for everything the rule did
    # not produce a code for.
    text_expr = case(*text_whens, else_=DatasetValue.value_text)
    num_expr = case(*num_whens, else_=None) if num_whens else None

    src_select = select(
        DatasetValue.row_id,
        func.cast(target.id, DatasetValue.column_id.type),
        text_expr,
        num_expr if num_expr is not None else func.cast(None, DatasetValue.value_numeric.type),
    ).where(DatasetValue.column_id == source.id)

    result = db.execute(
        insert(DatasetValue).from_select(
            ["row_id", "column_id", "value_text", "value_numeric"], src_select
        )
    )
    return result.rowcount or 0
