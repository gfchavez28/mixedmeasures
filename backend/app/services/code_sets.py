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

## A CLAIMANT is any code whose application counts in a set (#1028)

Two kinds: every MEMBER (by `Code.code_set_id`), and every code OUTSIDE the set
that is grouped INTO one of its values — "Pos" grouped with the member
"Positive" is recorded as choosing "Positive", so an application of it IS a
selection even though "Pos" never joined. The write path clears by claimant, not
by member: clearing members alone left a synonym standing beside the new value,
and the unit read as two selections with nothing on the set saying why.

## The rule holds at EVERY door, not only the set's own endpoint (#1028)

`apply_selection` was the only write that knew about sets, while a chord, a click
in the code list, the context menu, *+ Add code*, a bulk apply and the API all
went through `apply_code` / `bulk_code` and ADDED a second value.
`clear_rival_values` is the same exclusivity asked of an ordinary apply: applying
a claimant removes this coder's OTHER claimants of that set on the same targets,
and the endpoints report what they removed (`replaced_code_ids`) so a client can
say so and an undo can put it back.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from sqlalchemy import insert
from sqlalchemy.orm import Session

from ..models import Code, CodeApplication, CodeSet
from .coding_layers import build_effective_code_map
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


def set_claimants(members: list[Code], *, effective_map: dict[int, int]) -> dict[int, int]:
    """Every code whose application counts in this set → the value it reads as.

    - each MEMBER → its effective code (itself, unless it is grouped — and a
      member grouped with an OUTSIDE code reads as that outside code, which is
      the composition hole `set_composition_warnings` reports);
    - each code OUTSIDE the set grouped INTO one of its values → that value.

    The second kind is #1028(b): "Pos" grouped with the member "Positive" never
    joined the set, yet every consumer that reads the EFFECTIVE code (the α
    matrix, consensus, reconciliation) records it as choosing "Positive". A
    write path that clears only members leaves it standing beside a new choice.

    ⚠️ A code may claim TWO sets — a member of one grouped into a value of
    another, which the set door refuses and the equivalence door does not. It
    is a claimant of both; `CodeSetIndex.set_claimed_by` settles which set an
    apply of it swaps in (its own set first).
    """
    member_ids = {c.id for c in members}
    claimants: dict[int, int] = {
        c.id: effective_map.get(c.id, c.id) for c in members
    }
    # A VALUE of the set is a member that is its own effective code; only those
    # can be read into — a member that resolves elsewhere has left the set.
    values = {mid for mid, value in claimants.items() if mid == value}
    for raw, effective in effective_map.items():
        if raw not in member_ids and effective in values:
            claimants[raw] = effective
    return claimants


def set_composition_warnings(
    members: list[Code], *, effective_map: dict[int, int], codes_by_id: dict[int, Code],
) -> list[str]:
    """How grouping has changed what counts in this set, as sentences.

    Two facts, both reachable only from the EQUIVALENCE side:

    - a member grouped with an OUTSIDE code leaves the set — `membership_refusal`
      closes this at the set's own door, but regrouping afterwards re-opens it;
    - an outside code grouped INTO a member counts as choosing that member
      (#1028(b)). Not a defect any more — the write path clears it — but a code
      the set's list does not show is being read as one of its values, and the
      researcher should be able to see that without reading the α.

    Reported on the set rather than left to be discovered as a number.
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
    claimants = set_claimants(members, effective_map=effective_map)
    for raw in sorted(set(claimants) - member_ids):
        code = codes_by_id.get(raw)
        value = codes_by_id.get(claimants[raw])
        name = code.name if code is not None else f"code {raw}"
        value_name = value.name if value is not None else f"code {claimants[raw]}"
        out.append(
            f"“{name}” is not a value of this set, but it is grouped with “{value_name}” "
            f"as one effective code — every use of “{name}” counts as choosing "
            f"“{value_name}”, and choosing another value clears it."
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
    #: What may be CHOSEN through the set's own endpoint — a code outside the set
    #: is refused there even when it reads as one of its values. Carried on the
    #: dataclass rather than passed in, because a parameter is something a fourth
    #: caller can forget.
    raw_member_ids: frozenset[int]
    member_names: dict[int, str] = field(default_factory=dict)
    #: 🔴 Every code whose application counts in this set → the value it reads as
    #: (`set_claimants`). The WRITE path clears by these, never by `member_ids`: a
    #: coder's row names the code they pressed, so clearing by effective id leaves
    #: a grouped sibling standing, and clearing by member alone leaves a synonym
    #: grouped INTO a member standing (#1028(b)) — either way the unit still reads
    #: as two selections.
    claimants: dict[int, int] = field(default_factory=dict)

    @property
    def basis(self) -> str:
        return set_basis(self.exhaustive)


@dataclass(frozen=True)
class CodeSetIndex:
    """Every set in a project, resolved.

    ⚠️ A `set_of_raw_code` reverse lookup was deleted from an early draft because
    nothing read it (#941) — the set's own endpoint is handed the SET. #1028 gave
    it a reader: an ordinary apply is handed a CODE and must ask which set it
    counts in, so `set_claimed_by` exists now and has one.
    """

    sets: tuple[ResolvedSet, ...]

    def by_id(self, set_id: int) -> ResolvedSet | None:
        for s in self.sets:
            if s.id == set_id:
                return s
        return None

    def set_claimed_by(self, code_id: int) -> ResolvedSet | None:
        """The set an application of ``code_id`` is a selection in, or None.

        Its OWN set first: a member of one set grouped into a value of another
        claims both (`set_claimants`), and the set it was deliberately put in is
        the one an apply of it swaps in.
        """
        for s in self.sets:
            if code_id in s.raw_member_ids:
                return s
        for s in self.sets:
            if code_id in s.claimants:
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
        members = members_by_set.get(s.id, [])
        for code in members:
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
            claimants=set_claimants(members, effective_map=effective_map),
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


def _rival_filters(
    resolved: ResolvedSet,
    *,
    user_id: int,
    keep_code_id: int | None,
    segment_ids: list[int] | None,
    dataset_value_ids: list[int] | None,
) -> list | None:
    """The WHERE clause for this coder's other claimants of the set on these
    targets, or None when nothing can match. One definition for the clear and
    for the read that reports it, so the two cannot disagree about "rival"."""
    rivals = [cid for cid in resolved.claimants if cid != keep_code_id]
    unit_ids = dataset_value_ids if dataset_value_ids is not None else (segment_ids or [])
    if not rivals or not unit_ids:
        return None
    return [
        CodeApplication.user_id == user_id,
        CodeApplication.code_id.in_(rivals),
        in_id_set(_target_column(dataset_value_ids), unit_ids),
    ]


def clear_other_members(
    db: Session,
    resolved: ResolvedSet,
    *,
    user_id: int,
    keep_code_id: int | None,
    segment_ids: list[int] | None = None,
    dataset_value_ids: list[int] | None = None,
) -> int:
    """Delete this coder's OTHER claimants of the set on these targets.

    🔴 **Keyed on `claimants`, not the effective ids and not the members alone**
    — see that field. Until #1028 it was the members, which left a synonym
    grouped into a member standing beside the new choice.

    ⚠️ **Both target arms take a LIST since row 49.** They were `segment_ids:
    list` and `dataset_value_id: int`, and the asymmetry made the bulk coding
    import's only options one call per cell (75,699 delete/select/insert cycles
    on the demand corpus) or a second implementation of the swap — which is
    exactly what the internal design notes reason 4 says must not happen.

    Returns the number of rows removed. Flush-only; the caller commits.
    """
    filters = _rival_filters(
        resolved, user_id=user_id, keep_code_id=keep_code_id,
        segment_ids=segment_ids, dataset_value_ids=dataset_value_ids,
    )
    if filters is None:
        return 0
    removed = (
        db.query(CodeApplication)
        .filter(*filters)
        .delete(synchronize_session=False)
    )
    db.flush()
    return removed


def clear_rival_values(
    db: Session,
    index: CodeSetIndex,
    *,
    code_id: int,
    user_id: int,
    segment_ids: list[int] | None = None,
    dataset_value_ids: list[int] | None = None,
) -> dict[int, list[int]]:
    """Before an ordinary APPLY of ``code_id``: remove this coder's other values
    of the set it counts in, on these targets (#1028).

    Returns ``{target_id: [removed code ids]}`` — only targets that lost
    something — so the endpoint can report it: a client says what was replaced
    and an undo puts exactly that back. Empty, with no query, when the code
    counts in no set.

    🔴 **It runs whether or not the coder already holds ``code_id``.** Holding
    two values is a contradiction the α drops (§3); pressing one of them is the
    coder choosing, so the other goes — the one case where re-applying a code
    is not a no-op.

    ⚠️ The same exclusivity `apply_selection` enforces, asked of a code rather
    than a set, and built on the same `_rival_filters`. Flush-only; the caller
    marks staleness for these targets (it already marks them for the apply) and
    commits.
    """
    resolved = index.set_claimed_by(code_id)
    if resolved is None:
        return {}
    filters = _rival_filters(
        resolved, user_id=user_id, keep_code_id=code_id,
        segment_ids=segment_ids, dataset_value_ids=dataset_value_ids,
    )
    if filters is None:
        return {}
    column = _target_column(dataset_value_ids)
    removed: dict[int, list[int]] = {}
    for target, rival in (
        db.query(column, CodeApplication.code_id).filter(*filters)
        .order_by(column, CodeApplication.code_id).all()
    ):
        removed.setdefault(target, []).append(rival)
    if removed:
        db.query(CodeApplication).filter(*filters).delete(synchronize_session=False)
        db.flush()
    return removed


def clear_rivals_before_apply(
    db: Session,
    code: Code,
    *,
    user_id: int,
    segment_ids: list[int] | None = None,
    dataset_value_ids: list[int] | None = None,
) -> dict[int, list[int]]:
    """`clear_rival_values` for the four apply endpoints, which hold a CODE.

    ⚠️ **A code that is neither a member of a set nor grouped with anything can
    count in no set, so it costs no query** — the hot path of every chord press
    on an ordinary code stays exactly what it was. Only a member or a grouped
    code pays for the index (a synonym claims a set through its group).
    """
    if code.code_set_id is None and code.code_equivalence_group_id is None:
        return {}
    index = build_code_set_index(db, code.project_id, build_effective_code_map(db, code.project_id))
    return clear_rival_values(
        db, index, code_id=code.id, user_id=user_id,
        segment_ids=segment_ids, dataset_value_ids=dataset_value_ids,
    )


def replaced_code_ids(removed: dict[int, list[int]]) -> list[int]:
    """The distinct codes a swap removed, in id order — what a single-target
    response reports (a segment GROUP's siblings lose the same values)."""
    return sorted({cid for ids in removed.values() for cid in ids})


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
