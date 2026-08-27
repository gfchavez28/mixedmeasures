"""Re-key a definition a relabel killed — #584's death arm.

`recode_dependents.py` answers *what did this relabel break?*
`recode_rederive.py` answers the DRIFT question (a source's values moved).
This module answers the other one: *the column's cell text was rewritten, so
this definition's keys match nothing — can they be translated, and to what?*

## Why this is a separate module from the drift arm

They share a button's worth of vocabulary and nothing else. **Drift preserves a
total mapping and only its values move**, so it is idempotent and re-runnable.
**A re-key must invent a key correspondence that may not exist** — if a label was
renamed AND a code removed in one edit there is no total mapping, and a partial
re-key leaves a definition that maps some cells and silently drops others.
Sharing an implementation between them was the mistake the split exists to avoid.

## 🔴 The ONE correspondence that is recoverable, measured rather than assumed

`apply_value_labels` rewrites `value_text` from a cell's CODE to that code's
declared label, keying on `value_numeric`. So the translation a re-key needs is
``old key → code → new label``, and the only *reliable* first leg is a key that
**is itself a code**. Reproduced on a five-definition column: relabelling a
bare-code column killed four definitions, and every one of them was keyed on the
raw code text — which resolves.

⚠️ **Two other channels were considered and REFUSED, both by execution.**

1. **A previous label.** Relabelling an already-labelled column (dictionary A →
   dictionary B) kills definitions keyed on A's labels, and by then A exists
   nowhere: `apply_value_labels` overwrites `scale_labels`/`scale_values`, rewrites
   the auto primary's mapping in place, and overwrites the cells. There is no path
   from an A label to a code, so those are BLOCKED. (Measured bound on how much
   this costs: a PARTIAL rename kills nothing at all — `dead_definitions_for_column`
   requires ZERO overlap — so this case is reached only when every label on the
   column changed at once.)
2. **The definition's own mapping VALUES.** Tempting, because a `scale_map`'s
   values often ARE the column's codes. Measured counter-example, and it is not
   exotic: a hand-built flipped map `{Never: 5, Rarely: 4, … Always: 1}` has a
   value set exactly equal to the code set AND injective, yet `key → value` is not
   `key → its own code`. Re-keying through it maps "Never" to code 5's label —
   the researcher's scale, silently inverted. No test on the values can tell the
   two apart, so the channel is not used at all.

## What "blocked" means here

⛔ **Any key that does not resolve blocks the whole definition.** A non-numeric
key on a dead definition is either a former label (moved — leaving it is wrong)
or text that was never a code (never moved — leaving it is right), and **nothing
on disk distinguishes them**. The plan names the offending keys so the researcher
can fix that one entry in the editor and re-run, which is a better outcome than a
mapping we half understood.
"""

import json
from dataclasses import dataclass, asdict

from sqlalchemy.orm import Session

from ..models.dataset import DatasetColumn
from ..models.recode import RecodeDefinition
from .recode import (
    _parse_exclude_values,
    _parse_mapping,
    recompute_primary_value_numeric,
)
from .recode_dependents import _live_keys, dead_definitions_for_column
from .value_labels import build_code_to_label


#: A plan row's `status`. Only `ready` may be applied.
STATUS_READY = "ready"
STATUS_BLOCKED = "blocked"


class RekeyBlockedError(Exception):
    """A requested definition cannot be re-keyed against this column.

    Raised INSTEAD of part-applying, for the same reason the drift arm refuses a
    batch: skipping the blocked members would report success while leaving
    untouched precisely the definitions the researcher was trying to repair.
    """


@dataclass(frozen=True)
class KeyRename:
    old: str
    new: str

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class RekeyPlanItem:
    definition_id: int
    name: str
    recode_type: str
    is_primary: bool
    status: str
    #: Every key this would rewrite, old → new. The plan's evidence: a confirm
    #: that cannot say WHAT it is about to rename is not informed consent.
    renames: list[KeyRename]
    #: Keys with no code to resolve through — why a blocked row is blocked.
    unresolved_keys: list[str]
    detail: str

    def to_dict(self) -> dict:
        d = asdict(self)
        d["renames"] = [r.to_dict() if isinstance(r, KeyRename) else r
                        for r in self.renames]
        return d


def _column_dictionary(column: DatasetColumn) -> dict[float, str]:
    """The column's declared ``{code: label}``, via the ONE inverter (#576).

    `value_labels.build_code_to_label` already fails safe on a missing or
    length-mismatched pair of metadata lists, which is exactly the behaviour a
    re-key wants: no dictionary means nothing resolves, and every dead
    definition is blocked with a reason rather than re-keyed against a guess.
    """
    try:
        labels = json.loads(column.scale_labels) if column.scale_labels else None
        values = json.loads(column.scale_values) if column.scale_values else None
    except (json.JSONDecodeError, TypeError):
        return {}
    return build_code_to_label(labels, values)


def _resolve(key: str, code_to_label: dict[float, str]) -> str | None:
    """The new text for one old key, or None when it cannot be translated.

    The whole correspondence: the key must BE a code the column declares. A key
    that does not parse as a number never had a code, and a number the column
    does not declare was never relabelled — neither can be translated.
    """
    try:
        code = float(str(key).strip())
    except (TypeError, ValueError):
        return None
    return code_to_label.get(code)


def _plan_one(
    defn: RecodeDefinition,
    code_to_label: dict[float, str],
    live: set[str],
) -> RekeyPlanItem:
    mapping = _parse_mapping(defn)
    rtype = getattr(defn.recode_type, "value", defn.recode_type)

    def blocked(detail: str, unresolved: list[str] | None = None) -> RekeyPlanItem:
        return RekeyPlanItem(
            definition_id=defn.id, name=defn.name, recode_type=rtype,
            is_primary=bool(defn.is_primary), status=STATUS_BLOCKED,
            renames=[], unresolved_keys=unresolved or [], detail=detail,
        )

    if not code_to_label:
        return blocked(
            "This column has no value labels to re-key against, so there is "
            "nothing to translate its old values into."
        )

    renames: list[KeyRename] = []
    unresolved: list[str] = []
    for key in mapping:
        new = _resolve(key, code_to_label)
        if new is None:
            unresolved.append(str(key))
        else:
            renames.append(KeyRename(old=str(key), new=new))

    if unresolved:
        return blocked(
            "Some of its values cannot be matched to a code on this column, so "
            "re-keying would only translate part of the mapping: "
            + ", ".join(f"“{k}”" for k in unresolved)
            + ". Edit this definition directly instead.",
            unresolved,
        )

    # Two keys landing on one label would silently merge two mapping entries —
    # and the one that survives is whichever is written last.
    seen: dict[str, str] = {}
    for r in renames:
        low = r.new.lower()
        if low in seen:
            return blocked(
                f"Two of its values (“{seen[low]}” and “{r.old}”) both refer to "
                f"“{r.new}”, so re-keying would merge them into one entry. Edit "
                "this definition directly instead."
            )
        seen[low] = r.old

    # 🔴 The self-check: a re-key whose result STILL matches no cell is a no-op
    # that reports success. Reachable when the column's scale metadata has
    # drifted from the text its cells actually carry, which no other guard here
    # would notice. `live` is the same set `dead_definitions_for_column` judges
    # against, so "alive" means the same thing in both places.
    if not {r.new.strip().lower() for r in renames} & live:
        return blocked(
            "Re-keying would not match this column's values either — its value "
            "labels and its stored data disagree. Re-apply the value labels first."
        )

    plural = "" if len(renames) == 1 else "s"
    return RekeyPlanItem(
        definition_id=defn.id, name=defn.name, recode_type=rtype,
        is_primary=bool(defn.is_primary), status=STATUS_READY,
        renames=renames, unresolved_keys=[],
        detail=(
            f"{len(renames)} value{plural} would be renamed to the column's "
            "current labels"
            + (", and the column's scores recomputed." if defn.is_primary
               else ". This definition is not primary, so no stored scores change.")
        ),
    )


def plan_rekey(db: Session, column: DatasetColumn) -> list[RekeyPlanItem]:
    """What re-keying each of this column's dead definitions would do.

    Read-only. The population is `dead_definitions_for_column` — the ONE answer
    to "what did the relabel break" — never a second walk of the column's
    definitions: a re-key offered on a definition that still maps its cells would
    rename keys that are working.

    Computed fresh here AND again inside `apply_rekey`, so a stale plan held by a
    client can never authorise a write the current state forbids.
    """
    code_to_label = _column_dictionary(column)
    live = _live_keys(db, column.id)

    out: list[RekeyPlanItem] = []
    for dead in dead_definitions_for_column(db, column):
        defn = db.get(RecodeDefinition, dead.id)
        if defn is None:  # deleted between the query and here
            continue
        out.append(_plan_one(defn, code_to_label, live))
    return out


def apply_rekey(
    db: Session, column: DatasetColumn, definition_ids: list[int],
) -> dict:
    """Rename the named definitions' mapping keys to the column's current labels.

    ⚠️ **All or nothing.** The plan is recomputed here and the caller's list
    checked against it; a blocked member raises `RekeyBlockedError` BEFORE any
    write.

    ⚠️ **`exclude_values` is re-keyed with the mapping, and that is load-bearing
    rather than tidiness.** A code appearing in BOTH channels was excluded (its
    cell NULLed) before the relabel; renaming only the mapping would leave the
    exclusion matching nothing and start scoring a response the researcher had
    deliberately dropped. An exclude entry that does not resolve is left alone —
    it was never a code, so the relabel never moved it.

    ⚠️ **Atomic by construction**, same as the drift arm: the key rewrite and a
    primary's re-apply happen in the caller's transaction and any exception
    propagates un-caught, so the request's rollback undoes the whole batch. A
    mapping updated without its column recomputed leaves `value_numeric`
    describing keys that no longer exist (#767's shape).

    ⚠️ **Values are copied VERBATIM and no offset is ever written.** Only the
    keys move. A REVERSE definition's reflection offset is derived at apply time
    by `effective_reverse_offset`, which excludes the null set (#600); computing
    one here would reproduce that bug across every re-keyed definition at once.
    """
    requested = list(dict.fromkeys(definition_ids))
    if not requested:
        return {"updated": [], "renamed_keys": 0}

    plan = {p.definition_id: p for p in plan_rekey(db, column)}

    unknown = [i for i in requested if i not in plan]
    if unknown:
        raise RekeyBlockedError(
            f"Not a definition awaiting a re-key on this column: {unknown}. "
            "Re-run the preview — the definitions may have changed."
        )

    blocked = [plan[i] for i in requested if plan[i].status != STATUS_READY]
    if blocked:
        names = ", ".join(f"“{p.name}”" for p in blocked)
        raise RekeyBlockedError(
            f"Cannot re-key {names}: its values cannot be matched to this "
            "column's labels. Nothing was changed."
        )

    code_to_label = _column_dictionary(column)
    updated: list[int] = []
    renamed_keys = 0

    for def_id in requested:
        item = plan[def_id]
        defn = db.get(RecodeDefinition, def_id)
        mapping = _parse_mapping(defn)
        rename_by_old = {r.old: r.new for r in item.renames}

        # Rebuilt in the definition's OWN key order so the editor does not
        # reshuffle under the researcher; VALUES are copied verbatim.
        new_mapping = {}
        for key, value in mapping.items():
            new_mapping[rename_by_old.get(str(key), str(key))] = value
            if str(key) in rename_by_old:
                renamed_keys += 1
        defn.mapping = json.dumps(new_mapping)

        excludes = _parse_exclude_values(defn)
        if excludes:
            defn.exclude_values = json.dumps(
                [_resolve(e, code_to_label) or e for e in excludes]
            )

        db.flush()  # the apply below re-reads the definition from the session

        if defn.is_primary:
            recompute_primary_value_numeric(db, defn, defn.column_id)

        updated.append(def_id)

    return {"updated": updated, "renamed_keys": renamed_keys}
