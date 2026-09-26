"""Code sets — a mutually exclusive group of codes read as ONE variable (row 48).

Every rule about code sets is answered HERE, and every writer routes through it:
may this code join a set (`membership_refusal`) · which member did a coder choose
on a unit (`selection_for`) · what the unit set was when α was computed
(`SET_BASIS_*`) · and the write itself (`apply_selection`).

A guard at a router is not a guard on the operation (#589) — the import and the
portability paths reach these columns without passing any router — so the
refusals live here and the routers only make them earlier and cheaper.

## The three values a cell can take, and why the third is not a value

`selection_for` returns one of:

- a member's EFFECTIVE code id — the coder chose that value;
- `SET_NONE` — the coder chose no member. On a NON-exhaustive set that is the
  real value *"none of these"*; on an exhaustive one the caller turns it into
  `None`, i.e. missing data;
- `SET_MULTIPLE` — the coder holds TWO members of one set on one unit.

🔴 **`SET_MULTIPLE` IS A CONTRADICTION, NOT A VALUE, AND IT IS COUNTED RATHER THAN
RESOLVED.** It is reachable four ways — legacy data predating the set, a
`.mmproject` merge that unions two coders' work, a set created over codes already
applied, and a direct API call — so it is a real state that needs a decided rule.
Silently picking one (lowest id, most recent) fabricates a judgement nobody made;
the unit becomes `None` for that coder and the payload reports
`n_multiple_selection`, which makes it visible and fixable. This mirrors
`_distinct_comparable_values`: decide over what is actually comparable, and
disclose the rest.

## The sentinel must not collide with a code id

`SET_NONE` and `SET_MULTIPLE` are NEGATIVE because `codes.id` is a positive
autoincrement, so they can never name a real member. They are ordinary dict keys
inside `irr.unit_coincidence`, which is value-agnostic — but **a set α is scored
NOMINALLY and must stay so**: the ordinal/interval metrics sort their values and
would place "none of these" below every code id as though the categories had an
order. `assert_nominal_metric` is the tripwire.

## Composition with equivalence groups

A member may itself sit in an equivalence group ("Neg" ≡ "Negative"). The
effective-code resolver runs FIRST and set membership is read on the EFFECTIVE
code, so a coder who applied "Neg" is recorded as having chosen "Negative".

🔴 **That composition has a hole and `membership_refusal` closes the half that can
be closed at this door.** If the equivalence group's canonical code is NOT in the
set, every application of a member resolves to a code the set does not contain
and the selection silently disappears. So a code may not JOIN a set when its own
effective code is a different code outside that set. ⚠️ **The reverse direction is
NOT guarded here** — regrouping a code afterwards can re-open the same hole from
the equivalence side, which is why `set_composition_warnings` exists and is
reported on the set's own payload rather than left to be discovered in a number.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from sqlalchemy import insert
from sqlalchemy.orm import Session

from ..models import Code, CodeApplication, CodeSet
from .id_set import in_id_set

# ── The sentinels ────────────────────────────────────────────────────────────

#: The coder chose no member of the set. A real VALUE on a non-exhaustive set
#: ("none of these"); turned into `None` (missing) on an exhaustive one.
SET_NONE = -1

#: The coder holds two or more members of one set on one unit. Not a value — the
#: cell becomes `None` and the occurrence is counted.
SET_MULTIPLE = -2

# ── The stated basis — the TWELFTH member of the family ──────────────────────
#
# The same coders on the same data produce DIFFERENT α under the two, because
# `exhaustive` decides whether a blank is a value or a hole. A reader cannot tell
# which they are looking at from the number, so the server states it and
# `lib/code-set-basis.ts` renders it. Mirrored + contract-tested from Python.

#: Blanks are MISSING data; the unit contributes only the coders who chose.
SET_BASIS_EXHAUSTIVE_WITH_MISSING = "exhaustive_with_missing"

#: Blanks are the value "none of these" and enter the coincidence matrix.
SET_BASIS_INCLUSIVE_WITH_NONE = "inclusive_with_none"

SET_BASES = frozenset({
    SET_BASIS_EXHAUSTIVE_WITH_MISSING,
    SET_BASIS_INCLUSIVE_WITH_NONE,
})


def set_basis(exhaustive: bool) -> str:
    """The basis string for a set — the ONE place the flag becomes vocabulary."""
    return (
        SET_BASIS_EXHAUSTIVE_WITH_MISSING if exhaustive
        else SET_BASIS_INCLUSIVE_WITH_NONE
    )


def assert_nominal_metric(metric: str) -> None:
    """A set α is nominal. The sentinels are negative, so an ordinal or interval
    metric would sort "none of these" below every code id and score the distance
    between two categories as though the ids meant something."""
    if metric != "nominal":
        raise ValueError(
            f"a code-set alpha is scored nominally, never {metric!r}: its values are "
            "category identifiers and a reserved sentinel, which no ordered metric "
            "can interpret"
        )


# ── Membership refusals ──────────────────────────────────────────────────────
#
# A REASON, never a bool — an inactive code and a universal one need different
# words on screen (the `variableRulesRefusal` shape, #806), and the router turns
# the reason into the sentence.

REFUSAL_UNIVERSAL = "universal"
REFUSAL_INACTIVE = "inactive"
REFUSAL_OTHER_SET = "other_set"
REFUSAL_GROUPED_ELSEWHERE = "grouped_elsewhere"

_REFUSAL_SENTENCE = {
    REFUSAL_UNIVERSAL: (
        "“{name}” is a universal code. Universal codes are excluded from every "
        "coded-count and reliability surface, so a set containing one would never "
        "reach a statistic."
    ),
    REFUSAL_INACTIVE: (
        "“{name}” is inactive, so no coder can choose it. Reactivate it first — "
        "codes already in the set stay in it when they are deactivated."
    ),
    REFUSAL_OTHER_SET: (
        "“{name}” already belongs to the set “{other}”. A code belongs to at most "
        "one set, because two sets claiming one code makes “which value did this "
        "unit take?” ambiguous."
    ),
    REFUSAL_GROUPED_ELSEWHERE: (
        "“{name}” is grouped with “{other}” as one effective code, and “{other}” is "
        "not in this set. Agreement is computed on the effective code, so every use "
        "of “{name}” would be recorded as “{other}” and leave the set. Add “{other}” "
        "instead, or ungroup them."
    ),
}


def membership_refusal(
    code: Code,
    target_set: CodeSet,
    *,
    effective_map: dict[int, int],
    codes_by_id: dict[int, Code],
    incoming_ids: frozenset[int] = frozenset(),
) -> tuple[str, str] | None:
    """May ``code`` join ``target_set``? Returns ``(reason, sentence)`` or None.

    ``incoming_ids`` are the other codes being added in the SAME request — a set
    built in one act may legitimately contain both halves of an equivalence
    group, and judging each member against the database alone would refuse the
    canonical code's own companion.
    """
    if code.is_universal:
        return REFUSAL_UNIVERSAL, _REFUSAL_SENTENCE[REFUSAL_UNIVERSAL].format(name=code.name)
    if not code.is_active:
        return REFUSAL_INACTIVE, _REFUSAL_SENTENCE[REFUSAL_INACTIVE].format(name=code.name)
    if code.code_set_id is not None and code.code_set_id != target_set.id:
        other = codes_by_id.get(code.id)
        other_label = (
            other.code_set.label if other is not None and other.code_set is not None
            else "another set"
        )
        return REFUSAL_OTHER_SET, _REFUSAL_SENTENCE[REFUSAL_OTHER_SET].format(
            name=code.name, other=other_label,
        )

    # The composition rule. `effective_map` resolves a raw code to its group's
    # canonical; an ungrouped code maps to itself.
    effective_id = effective_map.get(code.id, code.id)
    if effective_id != code.id:
        canonical = codes_by_id.get(effective_id)
        in_set = (
            effective_id in incoming_ids
            or (canonical is not None and canonical.code_set_id == target_set.id)
        )
        if not in_set:
            return REFUSAL_GROUPED_ELSEWHERE, _REFUSAL_SENTENCE[REFUSAL_GROUPED_ELSEWHERE].format(
                name=code.name,
                other=canonical.name if canonical is not None else f"code {effective_id}",
            )
    return None


def set_composition_warnings(
    members: list[Code], *, effective_map: dict[int, int], codes_by_id: dict[int, Code],
) -> list[str]:
    """Members whose selections would silently leave the set, as sentences.

    `membership_refusal` closes this at the set's own door. It cannot close the
    OTHER door — grouping a member with an outside code afterwards re-opens it —
    so the state is REPORTED on the set rather than left to be discovered as a
    number that quietly stopped counting some coding.
    """
    member_ids = {c.id for c in members}
    out: list[str] = []
    for code in members:
        effective_id = effective_map.get(code.id, code.id)
        if effective_id != code.id and effective_id not in member_ids:
            canonical = codes_by_id.get(effective_id)
            other = canonical.name if canonical is not None else f"code {effective_id}"
            out.append(
                f"“{code.name}” is grouped with “{other}” as one effective code, and "
                f"“{other}” is not in this set — uses of “{code.name}” are recorded as "
                f"“{other}” and do not count as a selection here."
            )
    return out


# ── The resolved view every consumer reads ───────────────────────────────────


@dataclass(frozen=True)
class ResolvedSet:
    """One set as the statistics and the consensus layer need it."""

    id: int
    label: str
    exhaustive: bool
    #: Member ids in the EFFECTIVE-code space — what `applied[unit][coder]` holds.
    member_ids: frozenset[int]
    #: Display order for the confusion matrix's axes and the member breakdown.
    ordered_members: tuple[int, ...]
    #: 🔴 Every member's OWN id, including one that resolves to a grouped sibling.
    #: The WRITE path needs these and `member_ids` is the wrong set for it: a
    #: coder's row names the code they pressed, so clearing by effective id would
    #: leave a grouped sibling's application standing and the unit would still
    #: read as two selections. Carried on the dataclass rather than passed in,
    #: because a parameter is something a fourth caller can forget.
    raw_member_ids: frozenset[int]
    member_names: dict[int, str] = field(default_factory=dict)

    @property
    def basis(self) -> str:
        return set_basis(self.exhaustive)


@dataclass(frozen=True)
class CodeSetIndex:
    """Every set in a project, resolved.

    ⚠️ It carried a `set_of_raw_code` reverse lookup (raw code id → set id) for
    one draft and **nothing ever read it** — the write path is handed the SET by
    the router, so it never needs to ask which set a code belongs to. Deleted
    rather than kept as a convenience, on #941's rule: a field no consumer reads
    is a claim about the design that the design does not make.
    """

    sets: tuple[ResolvedSet, ...]

    def by_id(self, set_id: int) -> ResolvedSet | None:
        for s in self.sets:
            if s.id == set_id:
                return s
        return None


def build_code_set_index(
    db: Session, project_id: int, effective_map: dict[int, int],
) -> CodeSetIndex:
    """Read every set in one project and resolve its membership.

    ⚠️ **Membership is resolved into the EFFECTIVE-code space**, because that is
    the space `gather_coder_applications` reports applications in and
    re-resolving downstream is the trap `resolve_effective_code`'s own docstring
    warns about. A member whose effective code is outside the set contributes
    nothing here — `set_composition_warnings` is where that is said out loud.
    """
    rows = (
        db.query(CodeSet)
        .filter(CodeSet.project_id == project_id)
        .order_by(CodeSet.sequence_order.is_(None), CodeSet.sequence_order, CodeSet.id)
        .all()
    )
    if not rows:
        return CodeSetIndex(sets=())

    members_by_set: dict[int, list[Code]] = {s.id: [] for s in rows}
    for code in (
        db.query(Code)
        .filter(Code.project_id == project_id, Code.code_set_id.isnot(None))
        .order_by(Code.category_order.is_(None), Code.category_order, Code.numeric_id, Code.id)
        .all()
    ):
        if code.code_set_id in members_by_set:
            members_by_set[code.code_set_id].append(code)

    resolved: list[ResolvedSet] = []
    for s in rows:
        ordered: list[int] = []
        names: dict[int, str] = {}
        raw_ids: set[int] = set()
        for code in members_by_set.get(s.id, []):
            raw_ids.add(code.id)
            effective_id = effective_map.get(code.id, code.id)
            # Only a member that IS its own effective code names a value of this
            # variable; one that resolves elsewhere has left the set already.
            if effective_id != code.id:
                continue
            if effective_id not in names:
                ordered.append(effective_id)
                names[effective_id] = code.name
        resolved.append(ResolvedSet(
            id=s.id,
            label=s.label,
            exhaustive=bool(s.exhaustive),
            member_ids=frozenset(ordered),
            ordered_members=tuple(ordered),
            raw_member_ids=frozenset(raw_ids),
            member_names=names,
        ))
    return CodeSetIndex(sets=tuple(resolved))


def selection_for(applied_effective: set[int], resolved: ResolvedSet) -> int:
    """Which member of ``resolved`` this coder chose — or a sentinel.

    ``applied_effective`` is one coder's effective-code set on one unit, exactly
    as `gather_coder_applications` reports it.
    """
    chosen = applied_effective & resolved.member_ids
    if not chosen:
        return SET_NONE
    if len(chosen) > 1:
        return SET_MULTIPLE
    return next(iter(chosen))


def comparable_choice(value: int, exhaustive: bool) -> int | None:
    """What one coder's `selection_for` value counts as — a comparable value, or
    ``None`` for "this coder has no answer on this variable".

    🔴 **THE ONE STATEMENT OF THE RULE, and its three readers are the α matrix
    (`matrix_cell`), the consensus decider (`consensus._decide_set_selection`)
    and the reconciliation grid (`reconciliation._set_selections`).** Until
    #1017 the decider carried its own copy that forgot `SET_MULTIPLE`, counted a
    contradiction as a vote, and — when contradictions held a majority — wrote a
    consensus row for code id −2, which the foreign key refuses.

    - a member's id → itself;
    - `SET_MULTIPLE` → ``None`` (§3: a contradiction is not a value, whichever
      kind of set);
    - `SET_NONE` → ``None`` on an EXHAUSTIVE set (missing data), else itself
      (the real value "none of these").
    """
    if value == SET_MULTIPLE:
        return None
    if value == SET_NONE and exhaustive:
        return None
    return value


def matrix_cell(applied_effective: set[int], resolved: ResolvedSet) -> tuple[int | None, bool]:
    """``(cell, is_multiple)`` for one coder on one unit — `comparable_choice`
    over `selection_for`, plus the flag the α payload counts."""
    value = selection_for(applied_effective, resolved)
    return comparable_choice(value, resolved.exhaustive), value == SET_MULTIPLE


# ── The write path ───────────────────────────────────────────────────────────


def _target_column(dataset_value_ids: list[int] | None):
    """The `CodeApplication` column this call addresses. One branch, one place.

    ⚠️ The two arms were spelled out at four sites inside this module before the
    bulk import widened both entry points to lists (row 49); a target kind
    decided in four places is four chances for a filter and its insert to
    disagree about what "this unit" is.
    """
    return (
        CodeApplication.dataset_value_id if dataset_value_ids is not None
        else CodeApplication.segment_id
    )


def clear_other_members(
    db: Session,
    resolved: ResolvedSet,
    *,
    user_id: int,
    keep_code_id: int | None,
    segment_ids: list[int] | None = None,
    dataset_value_ids: list[int] | None = None,
) -> int:
    """Delete this coder's OTHER members of the set on these targets.

    🔴 **Keyed on `raw_member_ids`, not the effective ones** — see that field.

    ⚠️ **Both target arms take a LIST since row 49.** They were `segment_ids:
    list` and `dataset_value_id: int`, and the asymmetry made the bulk coding
    import's only options one call per cell (75,699 delete/select/insert cycles
    on the demand corpus) or a second implementation of the swap — which is
    exactly what the internal design notes reason 4 says must not happen.

    Returns the number of rows removed. Flush-only; the caller commits.
    """
    targets = [cid for cid in resolved.raw_member_ids if cid != keep_code_id]
    if not targets:
        return 0
    unit_ids = dataset_value_ids if dataset_value_ids is not None else (segment_ids or [])
    if not unit_ids:
        return 0
    removed = (
        db.query(CodeApplication)
        .filter(
            CodeApplication.user_id == user_id,
            CodeApplication.code_id.in_(targets),
            in_id_set(_target_column(dataset_value_ids), unit_ids),
        )
        .delete(synchronize_session=False)
    )
    db.flush()
    return removed


class SetSelectionError(ValueError):
    """A refused selection. The router renders ``str(exc)`` verbatim (#871)."""


def apply_selection(
    db: Session,
    resolved: ResolvedSet,
    *,
    user_id: int,
    code_id: int | None,
    segment_ids: list[int] | None = None,
    dataset_value_ids: list[int] | None = None,
    attribution: str | None = None,
) -> tuple[int | None, int]:
    """Make ``code_id`` this coder's ONE selection in ``resolved`` on these targets.

    Returns ``(code_id, removed)``. ``code_id=None`` clears the selection.

    🔴 **THE SWAP IS ONE ACT ON THE SERVER, NOT TWO CALLS FROM THE CLIENT.** Five
    reasons, and the first alone decides it:

    1. **Atomicity.** A remove that succeeds followed by an apply that fails
       leaves an EXHAUSTIVE set with no selection — a state the interface says
       is impossible, produced by the interface itself.
    2. **One staleness mark**, not two. `mark_participant_scores_stale` is
       ungated and sits above `consensus_enabled`'s early return (row 45 step 4),
       so a doubled act doubles work on single-coder installs — the default.
    3. **The unique index.** `ix_code_applications_seg_code_user_unique` is keyed
       `(target, code, user)`, so a swap is a DELETE and an INSERT on two
       different index keys; under `autoflush=False` (production AND tests) the
       ordering matters and belongs in one place — the #439/#440 family. The
       `db.flush()` inside `clear_other_members` is that ordering.
    4. **The bulk import needs the same operation** and must not re-implement it.
    5. **A refusal is the server's to state** (#871): the client shows the
       server's reason and never invents one.

    ⚠️ **Segment GROUPS fan out**, because a group is coded as ONE unit — that is
    what it is for — and a selection that differed across its members would be a
    distinction the interface never offered a way to make. The caller passes
    every visible sibling (`services/segment_groups.py::group_target_ids`); this
    function does not re-derive the group, because the two routers reach their
    targets differently and a second derivation is where the two would drift.

    ⚠️ **Both target arms are LISTS since row 49**, and one call may carry many
    units — every unit on which THIS coder chose THIS member. The workbench
    routers pass a single-element list and behave exactly as before; the bulk
    import groups its rows by `(set, coder, chosen member)` so a 75,699-row
    import is a handful of calls rather than 75,699 delete/select/insert cycles.

    ⚠️ **The insert is a Core `executemany`, not N `db.add`s.** One ORM instance
    per application is the whole of what remains of the `.mmproject` import's
    memory peak (#958, 1,846 MB on BES), and this path is the other place a
    six-figure number of applications is written at once. Column defaults
    (`origin`, `created_at`) are applied by the Core insert exactly as by the
    ORM; nothing reads the rows back.
    """
    if (segment_ids is None) == (dataset_value_ids is None):
        raise ValueError("exactly one of segment_ids / dataset_value_ids is required")
    if code_id is not None and code_id not in resolved.raw_member_ids:
        raise SetSelectionError(
            f"That code is not a value of “{resolved.label}”."
        )

    removed = clear_other_members(
        db, resolved, user_id=user_id, keep_code_id=code_id,
        segment_ids=segment_ids, dataset_value_ids=dataset_value_ids,
    )
    if code_id is None:
        return None, removed

    is_value_target = dataset_value_ids is not None
    # De-duplicated, because the same unit twice would breach the per-coder
    # unique index at commit — far from here, as an opaque IntegrityError.
    targets = list(dict.fromkeys(dataset_value_ids if is_value_target else (segment_ids or [])))
    if not targets:
        return code_id, removed

    column = _target_column(dataset_value_ids)
    existing = {
        row[0] for row in db.query(column).filter(
            CodeApplication.code_id == code_id,
            CodeApplication.user_id == user_id,
            in_id_set(column, targets),
        ).all()
    }
    fresh = [t for t in targets if t not in existing]
    if fresh:
        db.execute(insert(CodeApplication), [
            {
                "segment_id": None if is_value_target else t,
                "dataset_value_id": t if is_value_target else None,
                "code_id": code_id,
                "user_id": user_id,
                "attribution": attribution,
            }
            for t in fresh
        ])
    db.flush()
    return code_id, removed
