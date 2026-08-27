"""Re-derive a dependent recode from its source — #584's step 2, the acting half.

`recode_dependents.py` answers *what depends on this?* This module answers *what
would re-deriving actually do, and may it be done at all?*

## Why this is PLAN-then-APPLY rather than a button

Re-deriving rewrites `value_numeric` for every cell of a dependent's column —
numbers a researcher may already have reported. This project treats that as
release-note-worthy when done deliberately (#710), so it gets a plan the caller
can show, an explicit confirm, and an audit entry. There is no silent propagation
path and there must not be one.

## 🔴 The hazard that makes a naive re-derive WRONG

"Copy the source's new mapping into the dependent" is the obvious implementation
and it is unsafe. The crosswalk's copy is **label-remapped to the TARGET column's
spelling**, so the source's mapping can share *not one key* with it — the internal design notes
records this for `copy_to`, which "would write the source's label keys onto a
target whose cells never match them". Writing it would not raise: the dependent
would keep mapping, against keys no cell carries, and every cell would silently
NULL on the next apply.

So comparability is a PRECONDITION, judged with the same `_comparable_keys` the
#587 reference resolution and the #578 repair already use — one question, one
answer. A dependent whose keys do not overlap the source's is **blocked**, never
guessed at, and the plan says so in words.

## What is deliberately NOT here

⛔ The **re-key** operation (a column relabel kills mappings outright — the
`dead_definitions_for_column` half of #584). It is a different operation with a
different safety story: drift preserves a total mapping and only its values move,
while a re-key must invent a key correspondence that may not exist. Sharing a
button between them was the mistake this module's split exists to avoid.
"""

import json
from dataclasses import dataclass, asdict

from sqlalchemy.orm import Session

from ..models.recode import RecodeDefinition
from .recode import (
    _comparable_keys,
    _parse_mapping,
    recompute_primary_value_numeric,
)
from .recode_dependents import dependents_of_definition


#: A plan row's `status`. `blocked` is the only one `apply` refuses.
STATUS_READY = "ready"
STATUS_NO_CHANGE = "no_change"
STATUS_BLOCKED = "blocked"


class RederiveBlockedError(Exception):
    """A requested dependent cannot be re-derived from this source.

    Raised INSTEAD of part-applying. A batch that silently skipped its blocked
    members would report success while leaving exactly the definitions the
    researcher was trying to fix untouched.
    """


@dataclass(frozen=True)
class RederivePlanItem:
    definition_id: int
    name: str
    column_id: int
    is_primary: bool
    status: str
    #: Mapping keys whose value would change, lower-cased. The plan's evidence:
    #: a confirm dialog that cannot say WHAT changes is not informed consent.
    changed_keys: list[str]
    detail: str

    def to_dict(self) -> dict:
        return asdict(self)


def _int_if_whole(value: float):
    """Keep an integral code an int.

    ⚠️ A naive float write turns `5` into `5.0` in the stored JSON, and mapping
    values are compared and rendered as text downstream — the same integer-aware
    formatting trap `_fmt_code` exists for on the missing-values side.
    """
    if value is None:
        return None
    return int(value) if float(value).is_integer() else value


def plan_rederive(
    db: Session, source: RecodeDefinition,
) -> list[RederivePlanItem]:
    """What re-deriving from `source` would do to each of its dependents.

    Read-only. Computed fresh here AND again inside `apply_rederive`, so a stale
    plan held by a client can never authorise a write the current state forbids.
    """
    forward = _parse_mapping(source)
    out: list[RederivePlanItem] = []

    for dep in dependents_of_definition(db, source.id):
        defn = db.get(RecodeDefinition, dep.id)
        if defn is None:  # deleted between the query and here
            continue
        shared, cur_lower, fwd_lower = _comparable_keys(defn, forward)

        if not shared:
            out.append(RederivePlanItem(
                definition_id=defn.id, name=defn.name, column_id=defn.column_id,
                is_primary=bool(defn.is_primary), status=STATUS_BLOCKED,
                changed_keys=[],
                detail=(
                    "Its mapping shares no values with the source, so there is "
                    "nothing to copy across. This is normal for a copy made on "
                    "another dataset, where the labels were remapped to that "
                    "column's own wording."
                ),
            ))
            continue

        changed = [k for k in shared if cur_lower[k] != fwd_lower[k]]
        if not changed:
            out.append(RederivePlanItem(
                definition_id=defn.id, name=defn.name, column_id=defn.column_id,
                is_primary=bool(defn.is_primary), status=STATUS_NO_CHANGE,
                changed_keys=[],
                detail="Already matches the source — re-deriving would change nothing.",
            ))
            continue

        out.append(RederivePlanItem(
            definition_id=defn.id, name=defn.name, column_id=defn.column_id,
            is_primary=bool(defn.is_primary), status=STATUS_READY,
            changed_keys=sorted(changed),
            detail=(
                f"{len(changed)} value{'' if len(changed) == 1 else 's'} would be "
                "updated to match the source"
                + (", and the column's scores recomputed." if defn.is_primary
                   else ". This definition is not primary, so no stored scores change.")
            ),
        ))

    return out


def apply_rederive(
    db: Session, source: RecodeDefinition, definition_ids: list[int],
) -> dict:
    """Copy the source's values onto the named dependents. All or nothing.

    ⚠️ **The plan is recomputed here and the caller's list is checked against it.**
    A blocked member raises `RederiveBlockedError` BEFORE any write — the
    preview-or-refuse rule. Part-applying a batch is the failure mode that would
    leave a researcher's column half-derived with no record of which half.

    ⚠️ **Atomic by construction.** The mapping edit and the re-apply of a primary
    must not be separable: a mapping updated without its column recomputed leaves
    `value_numeric` describing the OLD mapping, which is #767's shape (a stored
    result that no longer corresponds to what produced it). Everything happens in
    the caller's transaction and any exception propagates un-caught, so the
    request's rollback undoes the whole batch rather than clearing up after it.

    ⚠️ **The reflection offset is NEVER written here.** A reverse definition
    stores FORWARD codes and the offset is DERIVED at apply time by
    `effective_reverse_offset`, which excludes the null set (#600). Copying the
    mapping is the entire change; re-deriving an offset by hand would reproduce
    #600 across every dependent at once.
    """
    requested = list(dict.fromkeys(definition_ids))
    if not requested:
        return {"updated": [], "skipped": [], "changed_values": 0}

    plan = {p.definition_id: p for p in plan_rederive(db, source)}

    unknown = [i for i in requested if i not in plan]
    if unknown:
        raise RederiveBlockedError(
            f"Not a dependent of this definition: {unknown}. "
            "Re-run the preview — the definitions may have changed."
        )

    blocked = [plan[i] for i in requested if plan[i].status == STATUS_BLOCKED]
    if blocked:
        names = ", ".join(f"“{p.name}”" for p in blocked)
        raise RederiveBlockedError(
            f"Cannot re-derive {names}: no values in common with the source. "
            "Nothing was changed."
        )

    forward = _parse_mapping(source)
    updated: list[int] = []
    skipped: list[int] = []
    changed_values = 0

    for def_id in requested:
        item = plan[def_id]
        if item.status == STATUS_NO_CHANGE:
            # Idempotent: a second confirm, or a double click, is not an error.
            skipped.append(def_id)
            continue

        defn = db.get(RecodeDefinition, def_id)
        mapping = _parse_mapping(defn)
        _, _, fwd_lower = _comparable_keys(defn, forward)
        wanted = set(item.changed_keys)

        # Rewrite by the definition's OWN keys — `_comparable_keys` lower-cases for
        # comparison only, and writing the lowered form back would silently rename
        # every label to lowercase.
        new_mapping = dict(mapping)
        for key in mapping:
            low = str(key).lower()
            if low in wanted:
                new_mapping[key] = _int_if_whole(fwd_lower[low])
                changed_values += 1

        defn.mapping = json.dumps(new_mapping)
        db.flush()  # the apply below re-reads the definition from the session

        if defn.is_primary:
            recompute_primary_value_numeric(db, defn, defn.column_id)

        updated.append(def_id)

    return {
        "updated": updated,
        "skipped": skipped,
        "changed_values": changed_values,
    }
