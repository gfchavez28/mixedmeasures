"""Who depends on a recode definition, and what a re-key would kill — #584.

## Why this exists

`RecodeDefinition.source_definition_id` was, before this module, only ever
*written* or walked *upward* (child → parent, by `_ultimate_scale_map_mapping`).
**No path queried it as a filter**, so nothing in the application could answer
"what depends on this scale map?" — which every remedy for #584 needs first.

## Two questions, not one — and the filed entry assumed they were the same

#584 records *"the dependents lookup serves both [triggers], which is why it is
step 1."* **Measured, that is false, and the difference decides the design.**
The two triggers stale different populations through different relationships:

| Trigger | Population | Failure mode |
|---|---|---|
| A source `scale_map`'s mapping is edited or the def deleted | definitions naming it via `source_definition_id` — possibly on **another column** (a crosswalk copy) | **drift**: the dependent still maps every cell, but its numbers no longer express what the source now says. Invisible; only provenance can find it. |
| A column is **relabelled** (`apply_value_labels` rewrites `value_text`) | definitions **on that column** whose mapping keys are the old cell text | **death**: the mapping matches nothing at all. Directly measurable, and provenance cannot see it. |

Reproduced on a five-definition column: relabelling killed **four** of them
(a linked reverse, an *unlinked* reverse, a second scale map and a category
group), while the `source_definition_id` lookup finds exactly **one**. Wiring
the provenance query to the relabel trigger would therefore have reported
"1 definition affected" where the true answer is 4 — a count that quietly
shrinks, which reads as a complete answer.

So: `dependents_of_definition` answers the first, `dead_definitions_for_column`
answers the second, and neither is a substitute for the other.

## What this module deliberately does NOT do

⛔ **It never propagates.** Re-deriving a dependent changes stored numbers a
researcher may already have reported — something this project treats as
release-note-worthy when done deliberately (#710), so doing it invisibly under
a label edit is worse than leaving it stale. These functions report; a human
decides.
"""

from dataclasses import dataclass, asdict

from sqlalchemy.orm import Session

from ..models.dataset import DatasetColumn, DatasetValue
from ..models.recode import RecodeDefinition
from .recode import _parse_mapping


@dataclass(frozen=True)
class DependentDefinition:
    """One definition affected by a change, and why."""

    id: int
    name: str
    recode_type: str
    column_id: int
    is_primary: bool
    reason: str  # "provenance" | "unmapped"

    def to_dict(self) -> dict:
        return asdict(self)


def _describe(defn: RecodeDefinition, reason: str) -> DependentDefinition:
    return DependentDefinition(
        id=defn.id,
        name=defn.name,
        recode_type=getattr(defn.recode_type, "value", defn.recode_type),
        column_id=defn.column_id,
        is_primary=bool(defn.is_primary),
        reason=reason,
    )


def dependents_of_definition(
    db: Session, definition_id: int,
) -> list[DependentDefinition]:
    """Definitions that name `definition_id` as their source.

    The provenance question — used when a source is about to be edited or
    deleted. A dependent may live on a DIFFERENT column (the crosswalk's
    label-remapped copy records the source it was derived from), which is why
    this is a query on `source_definition_id` and not on `column_id`.

    ⚠️ These are NOT necessarily broken: a dependent carries its own frozen copy
    of the forward mapping, so it keeps mapping every cell. What it loses is
    agreement with the source. Report it; do not "repair" it.
    """
    rows = (
        db.query(RecodeDefinition)
        .filter(RecodeDefinition.source_definition_id == definition_id)
        .order_by(RecodeDefinition.column_id, RecodeDefinition.sequence_order)
        .all()
    )
    return [_describe(d, "provenance") for d in rows]


def _live_keys(db: Session, column_id: int) -> set[str]:
    """The column's distinct non-empty `value_text`, lowercased.

    Lowercased because `compute_value` looks its mapping up case-insensitively;
    a set that judged case-sensitively would call a working definition dead.

    ⚠️ Shared with `recode_rekey.py`, which asks the same question in the other
    direction ("would the re-keyed definition be alive?"). Deliberately ONE
    function: two answers to "what text does this column carry" would let a
    re-key report success on a definition this module still calls dead.
    """
    rows = (
        db.query(DatasetValue.value_text)
        .filter(
            DatasetValue.column_id == column_id,
            DatasetValue.value_text.isnot(None),
            DatasetValue.value_text != "",
        )
        .distinct()
        .all()
    )
    return {r[0].strip().lower() for r in rows if r[0] and r[0].strip()}


def dead_definitions_for_column(
    db: Session, column: DatasetColumn,
) -> list[DependentDefinition]:
    """Definitions on this column whose mapping matches NO stored cell.

    The re-key question. `apply_value_labels` rewrites `value_text` from codes
    to labels, so every mapping keyed on the old text stops matching — and
    `compute_value` then returns `None` for every cell. While such a definition
    is non-primary that is dormant; promoting it to primary NULLs
    `value_numeric` column-wide (the #580 class).

    ⚠️ **Empty-column guard.** A column with no stored values makes every
    definition look dead, because nothing can match. That is an artefact of
    having no data, not a finding, so the answer there is an empty list.

    ⚠️ **Call this BEFORE and AFTER a re-key and report the difference** — see
    `newly_dead`. Reporting the after-set alone blames a re-key for definitions
    that were already dead when it started.
    """
    live = _live_keys(db, column.id)
    if not live:
        return []

    out: list[DependentDefinition] = []
    for defn in (
        db.query(RecodeDefinition)
        .filter(RecodeDefinition.column_id == column.id)
        .order_by(RecodeDefinition.sequence_order)
        .all()
    ):
        keys = {str(k).strip().lower() for k in _parse_mapping(defn)}
        if keys and not (keys & live):
            out.append(_describe(defn, "unmapped"))
    return out


def newly_dead(
    before: list[DependentDefinition], after: list[DependentDefinition],
) -> list[DependentDefinition]:
    """The definitions an operation killed — those dead after but not before.

    Set difference on id, so an operation is blamed only for what it actually
    broke. A definition already unmapped before the call (a half-finished
    mapping, an earlier relabel nobody acted on) stays out of the report.
    """
    was = {d.id for d in before}
    return [d for d in after if d.id not in was]
