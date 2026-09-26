"""Materialize the derived consensus layer (Track J · J2-3, Slab 4).

The consensus layer is ordinary ``CodeApplication`` rows (``origin='consensus'``)
owned by the single global consensus coder (``get_or_create_consensus_user``). It
is auto-generated from the human/AI coder layers wherever they agree, so the
existing per-coder filters, counts, and exports treat it as just another coder
(D5). Nothing here ever touches a human coder's rows — it INSERT/DELETEs only the
consensus user's own layer (invariant J2-E).

**The rule (DEC-D · majority + flag).** Per target (a segment XOR a dataset
value): the *voters* are the HUMAN roster coders
(``auth.reliability_coder_clause()`` — EXCLUDING the merged-legacy
"Unattributed" bucket, ADJ-2; EXCLUDING archived coders, DEC-F; and since #989
EXCLUDING MACHINE coders, so the stored layer's voter roster matches
``consensus_enabled``, the IRR gather and STRATEGY's commitment that the machine
layer is excludable from every reliability aggregate) who applied ≥1
NON-universal code to that target. A target needs
≥2 voters — a solo-coded target has nothing to reconcile. Each code is resolved
to its *effective code* (the D3 equivalence-group seam) before counting, so
"Positive" and "POSITIVE" agree. For each effective code applied by ≥1 voter:

  - applied by ALL voters            → consensus row, no flag (rule="unanimous")
  - applied by a STRICT majority     → consensus row + flag (rule="majority")
  - tie / sub-majority               → no consensus row

The rule + counts are recorded in ``origin_context`` JSON so the reconciliation
UI can show "2 of 3 agreed" and surface the majority flag.

**Project scoping (ADJ-1, load-bearing).** The consensus coder is GLOBAL (one
row, no ``project_id`` on ``User``); its applications span every project. A
rebuild therefore DELETEs only consensus rows whose target belongs to THIS
project — never a bare ``user_id == consensus`` delete, which would wipe every
other project's consensus layer.

Flushes but does not commit — the caller owns the transaction (composes inside
the portability import and the future staleness sweep).
"""
from __future__ import annotations

import json
import statistics
from collections.abc import Iterator
from itertools import groupby
from operator import itemgetter
from typing import NamedTuple

from sqlalchemy import func, insert, or_, select
from sqlalchemy.orm import Session

from ..auth import get_or_create_consensus_user, reliability_coder_clause
from ..models.code import Code
from ..models.code_application import CodeApplication
from ..models.dataset import Dataset, DatasetColumn, DatasetValue
from ..models.segment import Segment
from ..models.user import User
from ..routers.helpers import visible_segment_filter
from .coding_layers import (
    CONSENSUS_ORIGIN,
    build_effective_code_map,
    consensus_eligible_segment_clause,
    consensus_scoped_segments,
    non_consensus_filter,
    project_scoped_segments,
    resolve_effective_code,
)
from .code_sets import CodeSetIndex, build_code_set_index
from .magnitude import read_scale


def consensus_enabled(db: Session) -> bool:
    """True when the roster has ≥2 selectable coders.

    Consensus can only form across multiple coders, so single-coder projects (the
    overwhelmingly common case) skip ALL consensus work — no marking, no
    recompute. Cheap: the users table is tiny.
    """
    return (
        db.query(User)
        .filter(
            reliability_coder_clause(),
            User.archived == False,  # noqa: E712
        )
        .count()
        >= 2
    )


def consensus_exists_for_project(db: Session, project_id: int) -> bool:
    """True if the project has any materialized consensus applications (Slab 7).

    Drives the frontend's "offer the consensus view only when it exists" (the
    selector itself is frontend — DEC-A). Project-scoped via the same target joins
    the materializer uses; short-circuits on the first hit.
    """
    # Broad scope: this reports what EXISTS, so it must never HIDE a row (a row on
    # a just-unfrozen observation is still there until the next rebuild reclaims it).
    seg_hit = (
        project_scoped_segments(
            db.query(CodeApplication.id)
            .join(Segment, CodeApplication.segment_id == Segment.id),
            project_id,
        )
        .filter(CodeApplication.origin == CONSENSUS_ORIGIN)
        .first()
    )
    if seg_hit is not None:
        return True
    val_hit = (
        db.query(CodeApplication.id)
        .join(DatasetValue, CodeApplication.dataset_value_id == DatasetValue.id)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            CodeApplication.origin == CONSENSUS_ORIGIN,
            Dataset.project_id == project_id,
        )
        .first()
    )
    return val_hit is not None


#: A target needs at least this many voters before EITHER decider can write a
#: row — `_decide_consensus` and `_decide_set_selection` both read it, and so does
#: the writer's gather (#958), which is what makes skipping the one-voter targets
#: in SQL safe rather than an approximation. One number, three readers.
MIN_CONSENSUS_VOTERS = 2

#: The rebuild writes its consensus rows in bulk inserts of this many (#958). It
#: used to `db.add` one ORM object per row and flush every 5,000: the objects were
#: held until each flush, and the ORM wrote them ONE STATEMENT PER ROW — 169,347
#: `execute` calls on BES, ~75% of the rebuild's time (profiled 2026-09-24).
CONSENSUS_REBUILD_INSERT_BATCH = 5000

#: Rows the shared gather fetches per round trip, and targets the rollup resolves
#: to participants per call (#958). Each bounds what is held at once; neither
#: changes an answer.
GATHER_STREAM_BATCH = 5000


def _decide_consensus(per_coder: dict[int, set[int]]) -> list[tuple[int, str, int, int]]:
    """Apply the DEC-D rule to one target's per-coder effective-code sets.

    ``per_coder`` maps ``user_id`` → set of effective code ids that coder applied
    to the target. Returns ``(effective_code_id, rule, agree, voters)`` tuples for
    each code that reaches consensus, sorted by code id for deterministic output.
    Pure (no DB) — unit-testable and reused by the per-target staleness recompute
    (Slab 5).
    """
    n_voters = len(per_coder)
    if n_voters < MIN_CONSENSUS_VOTERS:
        return []

    tally: dict[int, int] = {}
    for codes in per_coder.values():
        for eff in codes:
            tally[eff] = tally.get(eff, 0) + 1

    decisions: list[tuple[int, str, int, int]] = []
    for eff, agree in sorted(tally.items()):
        if agree == n_voters:
            decisions.append((eff, "unanimous", agree, n_voters))
        elif agree * 2 > n_voters:  # strict majority (ties excluded)
            decisions.append((eff, "majority", agree, n_voters))
    return decisions


# ── #35 — consensus over RATINGS ───────────────────────────────────────────────
#
# A rating consensus is NOT a vote. Across coders, spread is ERROR to be
# minimised (the design note §2's one asymmetry), so the consensus rating is the
# MEDIAN of the voters' ratings — robust to one harsh coder — and the disagreement
# signal is the SPREAD, in the scale's own units. The categorical decider above is
# a majority over SETS and is deliberately not extended to carry this: a rating is
# one number per coder, a code set is many codes per coder, and the two questions
# ("did they agree it applies?" and "did they agree HOW MUCH?") are asked in
# sequence — the second only of a code that reached consensus on the first.

# ── Row 48 — consensus over a CODE SET ────────────────────────────────────────
#
# A THIRD decider, not a widened one. `_decide_consensus` above is a majority
# over SETS OF CODES; a code set asks a majority over ONE CHOSEN VALUE, where
# "none of these" is itself a candidate. Its neighbouring comment already states
# the principle for the rating case, and it applies here unchanged: the questions
# are asked in sequence and each one has its own decider.
#
# 🔴 **AND THE TWO MUST NOT BOTH DECIDE THE SAME CODE.** A set member reaching a
# majority would be written once by `_decide_consensus` and once by this decider
# — the same `(target, code, consensus_user)` twice, which is
# `ix_code_applications_seg_code_user_unique` raising an `IntegrityError` mid-loop
# under `autoflush=False`, i.e. the J3-2 trap. So set members are stripped out of
# the sets `_decide_consensus` tallies; `split_set_choices` is that split, and
# `decide_target` (below) is the ONE place it is performed.
#
# 🔴 **THE VOTER POOL IS THE TARGET'S, NOT THE SOURCE'S — a deliberate departure
# from the scope document, which specified Option-B source-level engagement.**
# `_decide_consensus`'s voters are the coders who applied ≥1 non-universal code to
# THIS target, and `recompute_consensus_for_target` — the hot path the staleness
# sweep runs — holds no source-level engagement at all; computing it would add a
# per-target query to the sweep. It also matters that the two deciders agree about
# who is voting: a set decision resting on a wider electorate than the categorical
# one beside it would make one row say "3 of 4" and its neighbour "2 of 3" about
# the same unit. A coder who engaged the source and left the target entirely blank
# is not a voter here — exactly as they are not one for any other code.

SET_CONSENSUS_NONE = "none"


def split_set_choices(
    per_coder: dict[int, set[int]], set_index,
) -> tuple[dict[int, set[int]], dict[int, dict[int, int]]]:
    """Separate a target's per-coder effective codes into non-set codes + set choices.

    Returns ``(per_coder_without_members, {set_id: {user_id: value}})`` where a
    value is a member's effective code id or ``code_sets.SET_NONE``. Every voter
    gets an entry for every set — a voter who chose nothing is an abstention
    (exhaustive) or a vote for "none of these" (inclusive), and which of those it
    is belongs to the decider, not to this split.
    """
    from .code_sets import selection_for

    if not set_index.sets:
        return per_coder, {}
    member_ids: set[int] = set()
    for resolved in set_index.sets:
        member_ids |= resolved.member_ids
    stripped = {uid: codes - member_ids for uid, codes in per_coder.items()}
    choices: dict[int, dict[int, int]] = {}
    for resolved in set_index.sets:
        if not resolved.member_ids:
            continue
        choices[resolved.id] = {
            uid: selection_for(codes, resolved) for uid, codes in per_coder.items()
        }
    return stripped, choices


def _decide_set_selection(
    choices: dict[int, int], exhaustive: bool,
) -> tuple[int, str, int, int] | None:
    """The consensus VALUE for one set on one target, or None.

    ``choices`` maps voter id → the member effective code id they chose, or
    ``code_sets.SET_NONE``. Returns ``(code_id, rule, agree, voters)``.

    - **Exhaustive set:** a coder who chose nothing has MISSING data on this
      variable and is not a voter for it. This is the one place `exhaustive`
      changes a WRITE rather than a display.
    - **Inclusive set:** their blank IS the value "none of these" and can win.
    - 🔴 **A coder holding TWO members (`SET_MULTIPLE`) is not a voter either,
      on either kind of set (#1017).** Who counts is `code_sets.comparable_choice`
      — the rule the α matrix and the reconciliation grid read — never a copy
      here. The copy this replaced forgot `SET_MULTIPLE`, so a contradiction
      could WIN and the writer built a row for code id −2.
    - **A tie produces NO consensus row** — identical to `_decide_consensus`, and
      correct: two coders choosing differently is exactly the state
      reconciliation exists to resolve.
    - 🔴 **"None of these" winning also produces NO ROW**, because there is no
      code to attach one to. The absence IS the consensus, and the
      reconciliation grid reads it as agreement rather than as a gap.
    """
    from .code_sets import SET_NONE, comparable_choice

    voters = {
        uid: comparable
        for uid, value in choices.items()
        if (comparable := comparable_choice(value, exhaustive)) is not None
    }
    n_voters = len(voters)
    if n_voters < MIN_CONSENSUS_VOTERS:
        return None
    tally: dict[int, int] = {}
    for value in voters.values():
        tally[value] = tally.get(value, 0) + 1
    winner, agree = max(sorted(tally.items()), key=lambda kv: kv[1])
    if agree * 2 <= n_voters:  # no strict majority (ties excluded)
        return None
    if winner == SET_NONE:
        return None
    rule = "unanimous" if agree == n_voters else "majority"
    return winner, rule, agree, n_voters


class ConsensusDecision(NamedTuple):
    """One code that reached consensus on one target.

    ``code_set`` is the set decision's own context (``{set_id, rule, agree,
    voters}``) when the code was decided as a set VALUE, else None — the writers
    put it in ``origin_context`` exactly when it is present.
    """

    code_id: int
    rule: str
    agree: int
    voters: int
    code_set: dict | None


def decide_target(per_coder: dict[int, set[int]], set_index) -> list[ConsensusDecision]:
    """Every code that reaches consensus on ONE target — the per-target decision.

    🔴 **THE ONE PLACE A TARGET IS DECIDED, and it has FOUR consumers (#1018):**
    `recompute_consensus_for_target` and `materialize_consensus_for_project`
    (the two WRITERS), `reconciliation.build_reconciliation` (the grid's live
    column) and `magnitude_rollup.compute_magnitude_rollup` (whose ratings count).
    The split + set-decider loop used to be written out three times and the
    rollup, a fourth consumer, had none of it — so a member of an exhaustive
    set could be unanimous in the stored layer and "no code consensus" in a
    participant's score. A fifth consumer calls this, never a copy.

    ``per_coder`` maps voter id → the EFFECTIVE codes they applied; set members
    are split out and decided by `_decide_set_selection`, everything else by
    `_decide_consensus` (the collision note above says why neither may decide
    the other's codes). Ordered: categorical codes by id, then set decisions in
    set order. Pure — no DB.
    """
    per_coder_codes, set_choices = split_set_choices(per_coder, set_index)
    decisions = [
        ConsensusDecision(eff, rule, agree, voters, None)
        for eff, rule, agree, voters in _decide_consensus(per_coder_codes)
    ]
    for resolved in set_index.sets:
        choices = set_choices.get(resolved.id)
        if not choices:
            continue
        decided = _decide_set_selection(choices, resolved.exhaustive)
        if decided is None:
            continue
        eff, rule, agree, voters = decided
        decisions.append(ConsensusDecision(eff, rule, agree, voters, {
            "set_id": resolved.id, "rule": rule, "agree": agree, "voters": voters,
        }))
    return decisions


MAGNITUDE_CONSENSUS_RULE = "median"


def _decide_magnitude(values: list[float | None], scale: dict) -> dict | None:
    """The rating consensus for ONE code on ONE target, or None with no ratings.

    ``values`` are the ratings the VOTERS gave on the code's own scale. A coder
    who applied the code but left it unrated contributes nothing — an explicit
    skip is not a rating of zero (#35 §2), and a rating OF zero is kept. Returns::

        {"rule": "median", "median": 7.5, "n_rated": 2,
         "spread": 1.0, "step": 1.0, "flag": False}

    🔴 **The flag is `spread > step`: the coders differ by MORE THAN ONE STEP of
    the declared scale.** The step is the researcher's own granularity — on a
    0–10 step-1 scale a 7 and an 8 are neighbours while a 7 and a 9 are worth
    adjudicating; on a 0–100 step-5 scale the same threshold is five points. Any
    other cutoff would be a number nobody declared. Every field is carried so the
    grid can SAY the rule rather than only show a mark.

    ⚠️ The median of an even count can fall between steps (7 and 8 → 7.5). That
    is correct: the consensus row is DERIVED, not a coder's judgement, and a
    median snapped to one side would be taking that coder's side.
    """
    rated = [v for v in values if v is not None]
    if not rated:
        return None
    step = float(scale.get("step") or 1.0)
    spread = float(max(rated) - min(rated))
    return {
        "rule": MAGNITUDE_CONSENSUS_RULE,
        "median": float(statistics.median(rated)),
        "n_rated": len(rated),
        "spread": spread,
        "step": step,
        # A hair of tolerance: 0.1 + 0.2 is not 0.3 in binary, and two coders on
        # adjacent ticks of a fractional-step scale must not be flagged.
        "flag": spread > step + 1e-9,
    }


def has_rating_disagreement(
    per_coder_ratings: dict[int, dict[int, float | None]], scales: dict[int, dict],
) -> bool:
    """True iff for some scaled code two coders' ratings on this unit differ by
    more than one step — the SAME rule `_decide_magnitude` flags with, asked of
    a unit that need not have a consensus at all (a tie on WHETHER the code
    applies can still carry two ratings that disagree on HOW MUCH)."""
    by_code: dict[int, list[float]] = {}
    for ratings in per_coder_ratings.values():
        for code_id, value in ratings.items():
            if value is not None and code_id in scales:
                by_code.setdefault(code_id, []).append(value)
    for code_id, values in by_code.items():
        if len(values) >= 2:
            decision = _decide_magnitude(values, scales[code_id])
            if decision is not None and decision["flag"]:
                return True
    return False


def scales_for_project(db: Session, project_id: int) -> dict[int, dict]:
    """Every scaled code's declaration, keyed by code id — ONE query per rebuild.

    A code whose scale was cleared keeps its stored ratings but is absent here,
    so they reach no consensus and no flag: a number with no declared range is
    not interpretable (the chip and the α table apply the same rule).
    """
    out: dict[int, dict] = {}
    for code in (
        db.query(Code)
        .filter(
            Code.project_id == project_id,
            Code.magnitude_min.isnot(None),
            Code.magnitude_max.isnot(None),
        )
        .all()
    ):
        scale = read_scale(code)
        if scale is not None:
            out[code.id] = scale
    return out


def _rating_values(
    ratings: dict[int, dict[int, float | None]], voters: dict[int, set[int]], eff: int,
) -> list[float | None]:
    """The voters' ratings on effective code ``eff`` — taken ONLY from
    applications of the canonical code itself (``ratings`` is keyed by the RAW
    code). A rating on a grouped sibling was given on the sibling's own scale,
    which may differ, so it is never pooled — the rule the α table applies."""
    return [ratings[uid][eff] for uid in voters if eff in ratings.get(uid, {})]


def _consensus_row(
    consensus_user_id: int, eff: int, rule: str, agree: int, voters: int,
    rating: dict | None, *, segment_id: int | None = None,
    dataset_value_id: int | None = None, code_set: dict | None = None,
) -> dict:
    """ONE shape for both writers, so the stored layer cannot drift.

    Returns the row's column VALUES: the per-target recompute adds them as one
    ORM object, the project rebuild bulk-inserts them in batches (#958). Every
    key is always present — the rebuild's `executemany` sends one statement per
    key set, and a key that came and went would split a batch.

    The ``magnitude`` key rides `origin_context` ONLY when a rating consensus
    exists — an unrated code keeps the exact three-key shape it always had. The
    row's own `magnitude` column carries the median (or stays NULL), so the
    consensus layer's chips render a rating the same way a coder's do.

    ``code_set`` rides the same way (row 48) and for the same reason: a row that
    is not a set selection keeps the exact shape it had, so the four pre-#35
    tests asserting the literal dict stay honest.
    """
    context: dict = {"rule": rule, "agree": agree, "voters": voters}
    if rating is not None:
        context["magnitude"] = rating
    if code_set is not None:
        context["code_set"] = code_set
    return {
        "code_id": eff,
        "user_id": consensus_user_id,
        "origin": CONSENSUS_ORIGIN,
        "origin_context": json.dumps(context),
        # `is not None`, never truthiness: a median of 0 is a rating (#35 §2).
        "magnitude": rating["median"] if rating is not None else None,
        "segment_id": segment_id,
        "dataset_value_id": dataset_value_id,
    }


def has_disagreement(per_engaged_coder: dict[int, set[int]]) -> bool:
    """True iff ≥2 SOURCE-engaged coders gave non-identical effective-code sets.

    The reconciliation flag — DELIBERATELY broader than "no consensus": a unit can
    have a majority consensus AND a dissenting minority (or a colleague who reviewed
    the source but left this unit blank). ``per_engaged_coder`` is the SOURCE-level
    projection — every coder engaged in the unit's source, with a blank set for one
    who left this unit uncoded (Option B explicit absence). This is a separate input
    from ``_decide_consensus``'s TARGET-level voters, so the two are NOT one shared
    tally. Pure (no DB); unit-tested.
    """
    if len(per_engaged_coder) < 2:
        return False
    return len({frozenset(s) for s in per_engaged_coder.values()}) > 1


def recompute_consensus_for_target(
    db: Session,
    project_id: int,
    *,
    segment_id: int | None = None,
    dataset_value_id: int | None = None,
) -> int:
    """Recompute the consensus layer for ONE target (write-side, synchronous).

    The cheap path: used inline by single apply/remove and by the staleness sweep
    (Slab 5). DELETE this target's consensus rows + re-derive from its voters via
    ``_decide_consensus``. A single target can't span projects, so ADJ-1's
    project-scoping is automatic; ``project_id`` is needed only for the
    effective-code map (equivalence resolution — a no-op query when the project
    has no groups). Returns the number of consensus rows written. Flush-only.
    """
    if (segment_id is None) == (dataset_value_id is None):
        raise ValueError("exactly one of segment_id / dataset_value_id is required")

    consensus_user = get_or_create_consensus_user(db)
    effective_map = build_effective_code_map(db, project_id)
    target_filter = (
        CodeApplication.segment_id == segment_id
        if segment_id is not None
        else CodeApplication.dataset_value_id == dataset_value_id
    )

    voters = (
        db.query(CodeApplication.user_id, CodeApplication.code_id, CodeApplication.magnitude)
        .join(Code, CodeApplication.code_id == Code.id)
        .join(User, CodeApplication.user_id == User.id)
        .filter(
            target_filter,
            non_consensus_filter(),
            Code.is_universal == False,  # noqa: E712
            reliability_coder_clause(),
            User.archived == False,  # noqa: E712 — DEC-F: archived coders don't vote
        )
    )
    if segment_id is not None:
        # A soft-deleted (merged/split) segment is no longer codable — recomputing
        # it yields zero voters, which clears any stale consensus on it. This keeps
        # per-target recompute consistent with the project materializer (both
        # honor visibility) so the sweep tidies up consensus after segment ops.
        #
        # Observations track (D18 — supersedes D2's blanket exclusion): a clip is
        # consensus-eligible iff its Observation is FROZEN, i.e. the team agreed
        # the cuts before coding, so every coder codes the SAME clips. An UNFROZEN
        # observation's clips are each coder's own (one voter per clip), so voting
        # is meaningless there and unitizing-alpha is the reliability statistic
        # instead.
        #
        # This must use the SAME eligibility definition as the exists-gate, the
        # materializer's gather and the rebuild DELETE — a consensus row written
        # here on a segment the rebuild's scope can't see would be a permanent,
        # invisible orphan that no rebuild can clean. That trap is exactly why D2
        # excluded observations wholesale; the fix is one shared definition, not a
        # blanket exclusion. Yielding zero voters writes nothing AND lets the
        # DELETE below tidy any orphan defensively.
        voters = voters.join(Segment, CodeApplication.segment_id == Segment.id).filter(
            *visible_segment_filter(),
            consensus_eligible_segment_clause(),
        )
    rows = voters.all()
    per_coder: dict[int, set[int]] = {}
    # #35 — each voter's RATINGS, keyed by the RAW code (the instrument is the
    # code's own scale; `_rating_values` says why they are never pooled).
    ratings: dict[int, dict[int, float | None]] = {}
    for user_id, code_id, magnitude in rows:
        per_coder.setdefault(user_id, set()).add(resolve_effective_code(effective_map, code_id))
        ratings.setdefault(user_id, {})[code_id] = magnitude

    db.query(CodeApplication).filter(
        CodeApplication.origin == CONSENSUS_ORIGIN,
        target_filter,
    ).delete(synchronize_session="fetch")
    db.flush()

    decisions = decide_target(per_coder, build_code_set_index(db, project_id, effective_map))
    scales = scales_for_project(db, project_id) if decisions else {}
    for eff, rule, agree, voters, code_set in decisions:
        rating = (
            _decide_magnitude(_rating_values(ratings, per_coder, eff), scales[eff])
            if eff in scales else None
        )
        db.add(CodeApplication(**_consensus_row(
            consensus_user.id, eff, rule, agree, voters, rating,
            segment_id=segment_id, dataset_value_id=dataset_value_id,
            code_set=code_set,
        )))
    db.flush()
    return len(decisions)


#: The two kinds of coding target — `CodeApplication`'s segment-XOR-value
#: target — as a ballot names them. Row 45's rollup keys a passage by
#: ``(kind, target_id)``, so these are also its sort order.
TARGET_SEGMENT = "seg"
TARGET_VALUE = "val"

#: The `CodeApplication` column each kind's id belongs in. A lookup, never a
#: conditional: a third kind raises here instead of writing a row with no target.
_TARGET_COLUMN = {TARGET_SEGMENT: "segment_id", TARGET_VALUE: "dataset_value_id"}


class TargetBallot(NamedTuple):
    """ONE target's votes — exactly what `decide_target` and `_rating_values`
    take for it.

    ``per_coder`` maps voter id → the set of EFFECTIVE code ids they applied.
    ``ratings`` maps voter id → RAW code id → the rating, which is why
    `_rating_values` exists: a grouped sibling's rating was given on the
    sibling's own scale and is never pooled with the canonical's.
    """

    kind: str
    target_id: int
    per_coder: dict[int, set[int]]
    ratings: dict[int, dict[int, float | None]]

    def target(self) -> dict[str, int]:
        """``{"segment_id": id}`` or ``{"dataset_value_id": id}`` — the keyword
        both `_consensus_row` and `ParticipantResolution.for_target` take."""
        return {_TARGET_COLUMN[self.kind]: self.target_id}


def _stream_ballots(query, target_col, kind: str, effective_map) -> Iterator[TargetBallot]:
    """One arm's vote rows as ballots, WITHOUT holding the arm (#958).

    ORDER BY the target makes each target's rows contiguous, so a ballot is
    complete when the next target's first row arrives, and `yield_per` keeps at
    most one fetch batch of rows in Python. MEASURED on BES: the writer's arm
    (518,096 rows, 168,729 targets) streams in 3.6 s at 81 MB; reading it whole
    took 3.8 s at 215 MB before any bucketing, and the rollup's unfiltered arm
    (1,208,742 rows) 4.8 s at 401 MB against 5.8 s at 80 MB streamed.

    🔴 **The ORDER BY is what makes the grouping CORRECT, not a nicety.** On
    BES's filtered arm the plan happens to emit targets in order (the ≥N-voter
    list drives it) and costs nothing; the rollup's unfiltered arm needs a sort.
    Without it a plan change would split one target into two ballots, and each
    half would be decided as though the other coders had not voted.
    """
    rows = query.order_by(target_col).yield_per(GATHER_STREAM_BATCH)
    for target_id, group in groupby(rows, key=itemgetter(0)):
        per_coder: dict[int, set[int]] = {}
        ratings: dict[int, dict[int, float | None]] = {}
        for _target, user_id, code_id, magnitude in group:
            per_coder.setdefault(user_id, set()).add(
                resolve_effective_code(effective_map, code_id)
            )
            ratings.setdefault(user_id, {})[code_id] = magnitude
        yield TargetBallot(kind, target_id, per_coder, ratings)


class TargetVotes:
    """One project's voter applications, STREAMED one target at a time — the
    input BOTH the consensus materializer and row 45's rollup decide from (#35,
    2026-09-08; streamed since #958's last step, 2026-09-24).

    Extracted rather than copied: the eligibility of a vote is decided by SIX
    filters that must agree wherever the question is asked — HUMAN roster coders
    only (`auth.reliability_coder_clause()`, #989), never archived (DEC-F), non-universal
    codes, non-consensus rows, VISIBLE segments, and — for segments —
    `consensus_scoped_segments` (D18 unit provenance). A second hand-rolled gather
    would drift on any one of them silently, and #733's rule is that a copy
    propagates a defect verbatim rather than merely rotting.

    The per-project CONTEXT is read once, on construction. The VOTES are not:
    `ballots()` runs the two queries as it is iterated and yields one
    `TargetBallot` per target, so no consumer holds a project's votes at once.
    Each call re-reads the database; iterate it once.
    """

    def __init__(self, db: Session, project_id: int, scope, min_voters: int):
        self._db = db
        self._project_id = project_id
        self._scope = scope
        self._min_voters = min_voters
        self.effective_map: dict[int, int] = build_effective_code_map(db, project_id)
        # #35 — the declared instruments, once per gather.
        self.scales: dict[int, dict] = scales_for_project(db, project_id)
        #: The project's code sets, resolved into the same effective-code space
        #: as a ballot's ``per_coder`` — what `decide_target` needs beside it.
        #: Carried here so a consumer of this gather cannot decide a target
        #: without it, which is how the rollup came to skip the set split
        #: entirely (#1018). Read ONCE, like `scales`: per target it would be a
        #: query per row.
        self.set_index: CodeSetIndex = build_code_set_index(db, project_id, self.effective_map)

    def ballots(self) -> Iterator[TargetBallot]:
        """Every target with at least ``min_voters`` eligible voters, segments
        then dataset values, each in ascending target id."""
        db, project_id, scope = self._db, self._project_id, self._scope
        seg_query = _seg_votes(db, project_id, scope, (
            CodeApplication.segment_id, CodeApplication.user_id, CodeApplication.code_id,
            CodeApplication.magnitude,
        ))
        val_query = _val_votes(db, project_id, (
            CodeApplication.dataset_value_id, CodeApplication.user_id, CodeApplication.code_id,
            CodeApplication.magnitude,
        ))
        if self._min_voters > 1:
            # 🔴 The ≥N-voter target set is built from the SAME two query builders,
            # so "a voter" here means exactly what it means in the ballots — never
            # a raw row count (one coder's two codes are one voter) and never a
            # coder the six filters drop (a machine or an archived coder).
            seg_query = seg_query.filter(CodeApplication.segment_id.in_(
                _targets_with_voters(
                    _seg_votes(db, project_id, scope, ()), CodeApplication.segment_id,
                    self._min_voters,
                )
            ))
            val_query = val_query.filter(CodeApplication.dataset_value_id.in_(
                _targets_with_voters(
                    _val_votes(db, project_id, ()), CodeApplication.dataset_value_id,
                    self._min_voters,
                )
            ))
        yield from _stream_ballots(
            seg_query, CodeApplication.segment_id, TARGET_SEGMENT, self.effective_map,
        )
        yield from _stream_ballots(
            val_query, CodeApplication.dataset_value_id, TARGET_VALUE, self.effective_map,
        )


#: The consensus WRITER's segment scope — D18 eligibility applied, so an
#: UNFROZEN observation's clips are not gathered at all.
SEGMENT_SCOPE_CONSENSUS_ELIGIBLE = "consensus_eligible"

#: Every segment in the project, all three parents, no eligibility clause — the
#: CLEANER's scope, and equally the DISCLOSER's.
SEGMENT_SCOPE_PROJECT = "project"

_SEGMENT_SCOPES = {
    SEGMENT_SCOPE_CONSENSUS_ELIGIBLE: consensus_scoped_segments,
    SEGMENT_SCOPE_PROJECT: project_scoped_segments,
}


def _vote_filters():
    """The per-row half of the SIX vote filters — shared by both arms and by the
    ≥N-voter subqueries, so a voter is one definition everywhere it is counted.
    (The other two: the segment arm's scope + visibility, the value arm's
    project join — each applied in its own builder below.)"""
    return (
        non_consensus_filter(),
        Code.is_universal == False,  # noqa: E712
        reliability_coder_clause(),
        User.archived == False,  # noqa: E712 — DEC-F: archived coders don't vote
    )


def _seg_votes(db: Session, project_id: int, scope, columns: tuple):
    """Segment-target voter applications. ``columns`` empty = the target id only
    (the ≥N-voter subquery replaces it with its own)."""
    return (
        scope(
            db.query(*(columns or (CodeApplication.segment_id,)))
            .join(Segment, CodeApplication.segment_id == Segment.id)
            .join(Code, CodeApplication.code_id == Code.id)
            .join(User, CodeApplication.user_id == User.id),
            project_id,
        )
        .filter(*visible_segment_filter(), *_vote_filters())
    )


def _val_votes(db: Session, project_id: int, columns: tuple):
    """Dataset-value-target voter applications (see `_seg_votes`)."""
    return (
        db.query(*(columns or (CodeApplication.dataset_value_id,)))
        .join(DatasetValue, CodeApplication.dataset_value_id == DatasetValue.id)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .join(Code, CodeApplication.code_id == Code.id)
        .join(User, CodeApplication.user_id == User.id)
        .filter(Dataset.project_id == project_id, *_vote_filters())
    )


def _targets_with_voters(votes_query, target_col, min_voters: int):
    """``SELECT target FROM <votes> GROUP BY target HAVING COUNT(DISTINCT user) >= N``
    — a subquery, so no id list crosses into Python (the #842 bind ceiling)."""
    sub = (
        votes_query.with_entities(target_col.label("target"))
        .group_by(target_col)
        .having(func.count(func.distinct(CodeApplication.user_id)) >= min_voters)
        .subquery()
    )
    return select(sub.c.target)


def gather_target_votes(
    db: Session, project_id: int, *, segment_scope: str, min_voters: int,
) -> TargetVotes:
    """Every voter application in one project, as a STREAM of per-target ballots.

    Returns a `TargetVotes`: the per-project context, read now, and `ballots()`,
    which reads the votes one target at a time as it is iterated. The whole-read
    form this replaced — two `.all()`s bucketed into nested dicts — was the
    rebuild's largest allocation (#958: 1,267 MB on BES unfiltered, ~400 MB after
    the ``min_voters`` filter). See `TargetVotes` for why this is shared rather
    than duplicated.

    🔴 **`min_voters` has NO DEFAULT either, for the same reason as the scope.**
    The WRITER passes `MIN_CONSENSUS_VOTERS`: below it neither decider can
    produce a row, so loading those targets is pure cost — on BES 80% of targets
    (674,679 of 843,408) have one voter, and filtering them in SQL is what takes
    the gather from 1,267 to under 500 MB with a byte-identical layer (#958,
    measured). The ROLLUP passes 1: Decision 3's sole-voter arm scores exactly
    the targets the writer drops, so inheriting the writer's value would erase
    every single-coder project's scores without an error.

    🔴 **`segment_scope` has NO DEFAULT, deliberately — the signature is what
    stops a new caller from silently inheriting the writer's narrow scope.**
    The rule from the other side of `project_scoped_segments`' docstring: a
    consumer that must SAY what it left out needs the CLEANER's scope, not the
    WRITER's. Sourcing row 45's rollup from `consensus_eligible` dropped an
    unfrozen observation's rated clips before it could see them — an exclusion
    with no disclosure, which is the one failure mode that design forbids
    (caught by the corpus oracle, 2026-09-08). Anything that only WRITES
    consensus wants `consensus_eligible`; anything that reports on coverage or
    exclusions wants `project`.
    """
    try:
        scope = _SEGMENT_SCOPES[segment_scope]
    except KeyError:
        raise ValueError(
            f"unknown segment_scope {segment_scope!r}; expected one of "
            f"{sorted(_SEGMENT_SCOPES)}"
        ) from None
    if not isinstance(min_voters, int) or isinstance(min_voters, bool) or min_voters < 1:
        raise ValueError(f"min_voters must be a positive int, not {min_voters!r}")
    return TargetVotes(db, project_id, scope, min_voters)


def _insert_consensus_rows(db: Session, rows: list[dict]) -> None:
    """Write one batch of `_consensus_row` values in ONE `executemany`, then
    empty the list.

    Never one ORM object per row (#958). Nothing needs these rows as objects:
    every reader of the layer queries it back.

    ⚠️ **A Core insert on the TABLE, not the `.mmproject` import's ORM bulk
    insert of the mapped class — deliberately.** The ORM form OMITS a key whose
    value is None and then splits consecutive rows by key set, so a batch
    mixing a rated row with an unrated one, or a segment target with a value
    target, went out as several statements (measured: a batch of two became
    two). `_consensus_row` gives every row the same keys, and Core sends a None
    as NULL, so one batch is one statement. The import wants the opposite
    trade: its rows may legitimately omit a column and take its default.
    """
    if rows:
        db.execute(insert(CodeApplication.__table__), rows)
        rows.clear()


def materialize_consensus_for_project(db: Session, project_id: int) -> dict:
    """Rebuild the consensus layer for one project. Returns a summary dict.

    DELETE (project-scoped) + recompute. Idempotent: re-running yields the same
    consensus set. See module docstring for the rule and the project-scoping
    invariant. Flush-only; caller commits.

    🔴 **It decides and WRITES as the votes stream past (#958)** — one ballot
    at a time from `TargetVotes.ballots()`, rows out in bulk inserts of
    `CONSENSUS_REBUILD_INSERT_BATCH`. Neither the project's votes nor its
    consensus rows are ever held whole. ⚠️ The inserts share a connection with
    the open read, which SQLite permits (sqlite.org/isolation.html: an INSERT
    during a SELECT is safe; whether the new row is seen is undefined). Here it
    cannot matter — every row written is `origin='consensus'` owned by a system
    coder, and the read excludes both — and each insert lands on a target the
    read has already passed.
    """
    consensus_user = get_or_create_consensus_user(db)
    votes = gather_target_votes(
        db, project_id, segment_scope=SEGMENT_SCOPE_CONSENSUS_ELIGIBLE,
        # Only targets that CAN produce a row (#958 — see the docstring there).
        min_voters=MIN_CONSENSUS_VOTERS,
    )
    scales = votes.scales

    # Project-scoped DELETE of the prior consensus layer (ADJ-1).
    # The CLEANER's scope — deliberately BROADER than the writer's (which is
    # eligibility-filtered above). Unfreezing an observation REVOKES its clips'
    # eligibility, and the rebuild must still be able to SEE the consensus rows it
    # previously wrote there in order to reclaim them. Scoping this DELETE to
    # eligible-only segments would strand them forever as invisible orphans.
    project_segment_ids = project_scoped_segments(db.query(Segment.id), project_id)
    project_value_ids = (
        db.query(DatasetValue.id)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(Dataset.project_id == project_id)
    )
    db.query(CodeApplication).filter(
        CodeApplication.origin == CONSENSUS_ORIGIN,
        or_(
            CodeApplication.segment_id.in_(project_segment_ids),
            CodeApplication.dataset_value_id.in_(project_value_ids),
        ),
    ).delete(synchronize_session="fetch")
    db.flush()

    created = unanimous = majority = rated = targets = 0
    pending: list[dict] = []

    for ballot in votes.ballots():
        targets += 1
        for eff, rule, agree, voters, code_set in decide_target(ballot.per_coder, votes.set_index):
            rating = (
                _decide_magnitude(_rating_values(ballot.ratings, ballot.per_coder, eff), scales[eff])
                if eff in scales else None
            )
            pending.append(_consensus_row(
                consensus_user.id, eff, rule, agree, voters, rating,
                code_set=code_set, **ballot.target(),
            ))
            created += 1
            if rule == "unanimous":
                unanimous += 1
            else:
                majority += 1
            if rating is not None:
                rated += 1
            if len(pending) >= CONSENSUS_REBUILD_INSERT_BATCH:
                # Safe mid-stream: the prior layer's DELETE was flushed above, and
                # `decide_target` never repeats a code within a target, so no
                # batch can collide with another on the per-coder unique index.
                _insert_consensus_rows(db, pending)
    _insert_consensus_rows(db, pending)

    return {
        "consensus_user_id": consensus_user.id,
        "created": created,
        "unanimous": unanimous,
        "majority": majority,
        # #35 — consensus rows that also carry a rating consensus (a median).
        "rated": rated,
        # Targets with ≥ MIN_CONSENSUS_VOTERS eligible voters — the ones that
        # COULD decide. Before #958's filter this counted every coded target.
        "targets": targets,
    }
