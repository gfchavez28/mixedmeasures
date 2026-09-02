"""Materialize the derived consensus layer (Track J · J2-3, Slab 4).

The consensus layer is ordinary ``CodeApplication`` rows (``origin='consensus'``)
owned by the single global consensus coder (``get_or_create_consensus_user``). It
is auto-generated from the human/AI coder layers wherever they agree, so the
existing per-coder filters, counts, and exports treat it as just another coder
(D5). Nothing here ever touches a human coder's rows — it INSERT/DELETEs only the
consensus user's own layer (invariant J2-E).

**The rule (DEC-D · majority + flag).** Per target (a segment XOR a dataset
value): the *voters* are the roster coders (``coder_type NOT IN
SYSTEM_CODER_TYPES`` — human + AI, EXCLUDING the merged-legacy "Unattributed"
bucket, ADJ-2, AND EXCLUDING archived coders — DEC-F, so the stored layer's
voter roster matches ``consensus_enabled`` and the IRR gather) who applied ≥1
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

from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..auth import SYSTEM_CODER_TYPES, get_or_create_consensus_user
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
            User.coder_type.notin_(SYSTEM_CODER_TYPES),
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


def _decide_consensus(per_coder: dict[int, set[int]]) -> list[tuple[int, str, int, int]]:
    """Apply the DEC-D rule to one target's per-coder effective-code sets.

    ``per_coder`` maps ``user_id`` → set of effective code ids that coder applied
    to the target. Returns ``(effective_code_id, rule, agree, voters)`` tuples for
    each code that reaches consensus, sorted by code id for deterministic output.
    Pure (no DB) — unit-testable and reused by the per-target staleness recompute
    (Slab 5).
    """
    n_voters = len(per_coder)
    if n_voters < 2:
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
    rating: dict | None, *, segment_id: int | None = None, dataset_value_id: int | None = None,
) -> CodeApplication:
    """ONE constructor for both writers, so the stored shape cannot drift.

    The ``magnitude`` key rides `origin_context` ONLY when a rating consensus
    exists — an unrated code keeps the exact three-key shape it always had. The
    row's own `magnitude` column carries the median (or stays NULL), so the
    consensus layer's chips render a rating the same way a coder's do.
    """
    context: dict = {"rule": rule, "agree": agree, "voters": voters}
    if rating is not None:
        context["magnitude"] = rating
    return CodeApplication(
        code_id=eff,
        user_id=consensus_user_id,
        origin=CONSENSUS_ORIGIN,
        origin_context=json.dumps(context),
        # `is not None`, never truthiness: a median of 0 is a rating (#35 §2).
        magnitude=rating["median"] if rating is not None else None,
        segment_id=segment_id,
        dataset_value_id=dataset_value_id,
    )


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
            User.coder_type.notin_(SYSTEM_CODER_TYPES),
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

    decisions = _decide_consensus(per_coder)
    scales = scales_for_project(db, project_id) if decisions else {}
    for eff, rule, agree, voters in decisions:
        rating = (
            _decide_magnitude(_rating_values(ratings, per_coder, eff), scales[eff])
            if eff in scales else None
        )
        db.add(_consensus_row(
            consensus_user.id, eff, rule, agree, voters, rating,
            segment_id=segment_id, dataset_value_id=dataset_value_id,
        ))
    db.flush()
    return len(decisions)


def materialize_consensus_for_project(db: Session, project_id: int) -> dict:
    """Rebuild the consensus layer for one project. Returns a summary dict.

    DELETE (project-scoped) + recompute. Idempotent: re-running yields the same
    consensus set. See module docstring for the rule and the project-scoping
    invariant. Flush-only; caller commits.
    """
    consensus_user = get_or_create_consensus_user(db)
    effective_map = build_effective_code_map(db, project_id)

    # Voter applications (roster coders only, non-universal codes, non-consensus,
    # visible segments) — bucketed per target → per coder → effective-code set.
    seg_rows = (
        consensus_scoped_segments(
            db.query(
                CodeApplication.segment_id, CodeApplication.user_id, CodeApplication.code_id,
                CodeApplication.magnitude,
            )
            .join(Segment, CodeApplication.segment_id == Segment.id)
            .join(Code, CodeApplication.code_id == Code.id)
            .join(User, CodeApplication.user_id == User.id),
            project_id,
        )
        .filter(
            *visible_segment_filter(),
            non_consensus_filter(),
            Code.is_universal == False,  # noqa: E712
            User.coder_type.notin_(SYSTEM_CODER_TYPES),
            User.archived == False,  # noqa: E712 — DEC-F: archived coders don't vote
        )
        .all()
    )
    val_rows = (
        db.query(CodeApplication.dataset_value_id, CodeApplication.user_id, CodeApplication.code_id,
                 CodeApplication.magnitude)
        .join(DatasetValue, CodeApplication.dataset_value_id == DatasetValue.id)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .join(Code, CodeApplication.code_id == Code.id)
        .join(User, CodeApplication.user_id == User.id)
        .filter(
            Dataset.project_id == project_id,
            non_consensus_filter(),
            Code.is_universal == False,  # noqa: E712
            User.coder_type.notin_(SYSTEM_CODER_TYPES),
            User.archived == False,  # noqa: E712 — DEC-F: archived coders don't vote
        )
        .all()
    )

    seg_buckets: dict[int, dict[int, set[int]]] = {}
    seg_ratings: dict[int, dict[int, dict[int, float | None]]] = {}
    for seg_id, user_id, code_id, magnitude in seg_rows:
        eff = resolve_effective_code(effective_map, code_id)
        seg_buckets.setdefault(seg_id, {}).setdefault(user_id, set()).add(eff)
        seg_ratings.setdefault(seg_id, {}).setdefault(user_id, {})[code_id] = magnitude
    val_buckets: dict[int, dict[int, set[int]]] = {}
    val_ratings: dict[int, dict[int, dict[int, float | None]]] = {}
    for val_id, user_id, code_id, magnitude in val_rows:
        eff = resolve_effective_code(effective_map, code_id)
        val_buckets.setdefault(val_id, {}).setdefault(user_id, set()).add(eff)
        val_ratings.setdefault(val_id, {}).setdefault(user_id, {})[code_id] = magnitude
    # #35 — the declared instruments, once per rebuild.
    scales = scales_for_project(db, project_id)

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

    created = unanimous = majority = rated = 0

    def _emit(per_coder, ratings, *, segment_id=None, dataset_value_id=None):
        nonlocal created, unanimous, majority, rated
        for eff, rule, agree, voters in _decide_consensus(per_coder):
            rating = (
                _decide_magnitude(_rating_values(ratings, per_coder, eff), scales[eff])
                if eff in scales else None
            )
            db.add(_consensus_row(
                consensus_user.id, eff, rule, agree, voters, rating,
                segment_id=segment_id, dataset_value_id=dataset_value_id,
            ))
            created += 1
            if rule == "unanimous":
                unanimous += 1
            else:
                majority += 1
            if rating is not None:
                rated += 1

    for seg_id, per_coder in seg_buckets.items():
        _emit(per_coder, seg_ratings.get(seg_id, {}), segment_id=seg_id)
    for val_id, per_coder in val_buckets.items():
        _emit(per_coder, val_ratings.get(val_id, {}), dataset_value_id=val_id)

    db.flush()
    return {
        "consensus_user_id": consensus_user.id,
        "created": created,
        "unanimous": unanimous,
        "majority": majority,
        # #35 — consensus rows that also carry a rating consensus (a median).
        "rated": rated,
        "targets": len(seg_buckets) + len(val_buckets),
    }
