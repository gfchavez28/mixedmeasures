"""Ratings → one number per person per rated code (row 45 (i) step 2).

A rating lives on one coded passage. This rolls a participant's ratings up into
a single score per code, so it can be charted, compared across groups and
exported like any other variable.

🔴 **TWO STEPS, NEVER ONE, AND THEY MUST NOT SHARE A NAME** (design note §2.2).

  1. **Across CODERS, on one passage → the MEDIAN.** A *reliability* act: one
     true value, coder noise discarded. **Already built** — `consensus.py::
     _decide_magnitude`. Called here the **target rating**.
  2. **Across TARGETS, for one participant → the MEAN.** A *scoring* act. This
     module's only new arithmetic. Called here the **participant score**.

  Mean and not median at step 2 deliberately: the median exists at step 1 to
  discard coder noise, and that job is done. Naming both "average magnitude" is
  how a researcher ends up reporting one as the other.

  ⚠️ Aggregating to the participant FIRST is also the design note's prescribed
  remedy for the clustering hazard (§2.4): segment-level ratings are not
  independent observations, but the resulting per-person score is an ordinary
  respondent-level measure with no nesting left in it.

🔴 **WHOSE RATINGS — decided per TARGET, on the consensus layer's own voter
rule** (Decision 3, and the sole place this module departs from "read what
consensus stored"):

  * **≥2 voters on the target** — the consensus layer governs. A code that
    reached consensus contributes its rating; a code that did NOT is EXCLUDED
    and disclosed as `no_code_consensus`, because the coders did not agree the
    code applies and scoring it would quote a judgement the team rejected.
  * **exactly 1 voter** — no consensus is possible, so the sole coder's
    judgement IS the target rating. Without this arm a single-coder project
    (the common case) would produce no scores at all.

  A "voter" is a coder who applied any non-universal code to that target —
  `_decide_consensus`'s own definition, at its own grain. Do not invent a third
  voter model; the reconciliation grid and the IRR gather already use two
  (target-level and source-level) for stated reasons.

  🔴 **This is derived LIVE rather than read from the stored consensus layer,
  and that is forced rather than preferred:** an absent consensus row cannot say
  whether it is absent because only one coder looked or because the code was a
  minority — and those two states must produce opposite outcomes here. Live
  derivation is also the `build_reconciliation` precedent, and it is always
  fresh (the stored layer trails a sweep loop).

🔴 **A SCORE STATES ITS *n*, AND THE *n* IS THE DANGEROUS HALF** (#693's rule).
One participant may rest on 8 rated passages and another on 1. Worse, a target
rating can rest on a SINGLE coder even where two voted (`magnitude-coding.md`
§6c) — so `min_raters_per_target` is carried precisely so "two coders agreed"
and "one coder said so" cannot look alike.

⚠️ **NULL IS NOT ZERO, HERE TOO.** A participant with no usable rating produces
NO ROW; a consumer materialising this as a column must write NULL, never 0
(#35 §2). `participants_coded_unrated` names the ones who were coded and could
still be rated — a different fact from a participant with no coding at all, who
is simply absent.

⚠️ **Never pooled across scales.** Rows are keyed per (participant, EFFECTIVE
code) and each carries the canonical code's declared instrument. Two codes'
scores are two variables; a consumer that averages them has invented a number.
Ratings enter only from applications of the canonical code itself — a grouped
sibling's rating was given on the sibling's own scale.

🔴 **A SCORE CARRIES AN INTERVAL, AND THE INTERVAL SAYS WHAT IT IS OVER** (row 45
(iii), the B9 obligation). Two intervals exist in this pipeline and they answer
different questions — the design note's warning about the two averages, one
level up:

  * **Across CODERS on one passage** — a *reliability* question. Its
    uncertainty is α's interval (`reliability_intervals`, #43) and the
    per-passage `flag` (spread > step). A t-interval over two or three coders'
    ratings would be a number nobody should quote, so the target rating
    deliberately carries NONE.
  * **Across a participant's PASSAGES** — a *descriptive* question: how
    consistent was this person's expressed level across what they said? THIS
    is the interval a score carries — `passage_level_t`, a t-interval over the
    step-1 target ratings with n = `n_targets`.

  It is NOT a sampling interval over people. Once the score is a variable in
  the participant table, the analysis view computes THAT one from the scores
  themselves (`t_interval`, n = participants). Rendering this one as a bare
  "95% CI" beside it would claim the two are the same kind of statement — the
  exact false claim `ci_method` exists to prevent, and why this is a NEW value
  rather than `t_interval`. Fewer than three rated passages ⇒ no interval, and
  the score SAYS so (`insufficient_passages`) rather than leaving a blank that
  reads as an oversight beside a neighbour that has one.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from statistics import fmean, stdev

from sqlalchemy.orm import Session

from ..models.code import Code
from .consensus import (
    SEGMENT_SCOPE_PROJECT,
    _decide_consensus,
    _decide_magnitude,
    _rating_values,
    gather_target_votes,
)
from .metrics import _ci_mean
from .participant_resolution import ParticipantRoute, resolve_participants

# ── The stated basis ─────────────────────────────────────────────────────────
#
# The stated-basis family's rule: the server states HOW a number was produced
# and the client displays that rather than inferring it. A future variant —
# a median at step 2, or a rating-weighted mean — must take a NEW value here.
#
# ⚠️ OWED AT STEP 4: the `lib/` mirror + the Python-reads-TypeScript contract
# test every member of the family needs. There is no client for this payload
# yet, and a mirror nothing imports is the "built but never consumed" shape
# #855 exists to catch — so the vocabulary lands here first, on purpose.

MAGNITUDE_ROLLUP_BASIS_MEAN_OF_TARGET_RATINGS = "mean_of_target_ratings"

MAGNITUDE_ROLLUP_BASES = frozenset({MAGNITUDE_ROLLUP_BASIS_MEAN_OF_TARGET_RATINGS})

# ── The interval's stated kind (the `ci_method` family — `lib/ci-label.ts`) ──
#
# 🔴 **A THIRD module now mints a `CI_METHOD_*`.** `metrics.py` holds the
# dataset ones, `reliability_intervals.py` the coefficient ones, and this one
# the participant score's. `test_ci_method_contract.py` walks all three
# (`_VOCABULARY_MODULES`) — a value minted here without a descriptor in
# `ci-label.ts` would otherwise fall through to a bare "95% CI", which is the
# exact false statement that module exists to prevent (the ROADMAP recorded
# this trap before the module existed; adding the module to the walk is what
# closes it).

#: A t-interval over ONE participant's per-passage target ratings
#: (n = `n_targets`). Deliberately not `t_interval`: that value means "over
#: respondents", and the analysis view will produce exactly that interval from
#: the score column — the two must never render alike.
CI_METHOD_PASSAGE_LEVEL_T = "passage_level_t"

#: Fewer than three rated passages. `_ci_mean`'s own floor — an interval over
#: two values has one degree of freedom and a critical value of 12.7, which is
#: a number that describes nothing. Distinct from `reliability_intervals`'
#: `insufficient_units` because the remedy differs: rate more of THIS person's
#: passages, not double-code more material.
CI_UNAVAILABLE_INSUFFICIENT_PASSAGES = "insufficient_passages"

# ── Why a rating did not reach a score ───────────────────────────────────────
#
# Decision 4 obliges the rollup to SAY what it excluded rather than drop it
# silently. These three are this module's own; the five route reasons come from
# `participant_resolution` and are merged into the same dict, so a consumer
# renders one list. ⚠️ Counted at the RATING grain — one coder judgement each —
# because "we excluded 2 ratings on video clips" is the sentence a researcher
# needs, and it differs from the resolver's own TARGET-grained count.

#: The target has ≥2 voters and this code did not reach consensus among them.
EXCLUDED_NO_CODE_CONSENSUS = "no_code_consensus"

#: A facilitator's own turn. Every participant count in the codebase excludes
#: these; the link is real, so `participant_resolution` reports it and this is
#: where the decision is taken.
EXCLUDED_FACILITATOR_TURN = "facilitator_turn"

#: A rating on a code that declares no scale — reachable because clearing a
#: scale is allowed and KEEPS the stored ratings (`magnitude.py` §5). A number
#: with no declared range is not interpretable, so it scores nothing.
EXCLUDED_NO_DECLARED_SCALE = "no_declared_scale"

EXCLUSION_REASONS = (
    EXCLUDED_NO_CODE_CONSENSUS,
    EXCLUDED_FACILITATOR_TURN,
    EXCLUDED_NO_DECLARED_SCALE,
)


@dataclass(frozen=True)
class ParticipantCodeScore:
    """One participant's score on one rated code — the row 45 variable's cell."""

    participant_id: int
    #: The EFFECTIVE (canonical) code. A grouped code scores under its canonical.
    code_id: int
    code_name: str
    #: Step 2: the MEAN of the target ratings. Never called an "average
    #: magnitude" — see the module docstring on why the two steps need two names.
    mean: float
    #: The step-1 values this mean is over, in a stable target order.
    target_ratings: tuple[float, ...]
    #: How many rated passages. THE denominator of `mean` — not people, not
    #: ratings.
    n_targets: int
    #: How many individual coder judgements sit underneath those targets.
    n_ratings: int
    #: The thinnest and thickest target. `min_raters_per_target == 1` means at
    #: least one target rests on ONE coder's rating even if others agreed.
    min_raters_per_target: int
    max_raters_per_target: int
    #: Targets whose coders differed by more than one declared step
    #: (`_decide_magnitude`'s `flag`). A score built from flagged passages is
    #: weaker evidence, and the flag is already computed at step 1.
    n_flagged_targets: int
    #: The canonical code's declared instrument. Two codes' scores are two
    #: variables; this is what makes that checkable.
    scale: dict
    #: Sample SD of `target_ratings` — how consistently this person was rated
    #: across their passages. None below two passages, where it is undefined.
    target_sd: float | None
    #: The interval over this person's passages (module docstring). Both bounds
    #: None when it is unavailable, in which case `ci_unavailable_reason` says
    #: why; `ci_method` is stated EITHER way, so a consumer that renders the
    #: reason still knows what kind of interval is missing.
    ci_lower: float | None
    ci_upper: float | None
    ci_level: float
    ci_method: str
    ci_unavailable_reason: str | None
    basis: str = MAGNITUDE_ROLLUP_BASIS_MEAN_OF_TARGET_RATINGS


@dataclass(frozen=True)
class MagnitudeRollup:
    """Every participant score in one project, plus what was left out and why."""

    scores: tuple[ParticipantCodeScore, ...]
    #: ``{reason: coder judgements not used}``. Merges this module's three
    #: reasons with `participant_resolution`'s five. Empty when nothing was
    #: dropped; a reason is absent rather than zero.
    excluded_ratings: dict[str, int] = field(default_factory=dict)
    #: Participants with usable coding but no score — "you can still rate
    #: these". Distinct from a participant with no coding, who is absent
    #: entirely, and from a score of zero, which does not exist.
    participants_coded_unrated: frozenset[int] = frozenset()

    def for_participant(self, participant_id: int) -> tuple[ParticipantCodeScore, ...]:
        return tuple(s for s in self.scores if s.participant_id == participant_id)


def _exclude(counts: dict[str, int], reason: str, n: int = 1) -> None:
    if n:
        counts[reason] = counts.get(reason, 0) + n


def _passage_interval(target_ratings: tuple[float, ...]) -> dict:
    """The interval over ONE participant's per-passage ratings, or why not.

    ONE t-interval implementation in the codebase — `metrics._ci_mean`, which
    takes the honest label as a parameter precisely so a caller cannot stamp
    it afterwards (#690). It returns None below three values, and that floor
    is the ONLY thing deciding `insufficient_passages` here: a second copy of
    "n < 3" would be the #733 class waiting for the floor to move.

    ⚠️ A sample SD of exactly 0 (every passage rated the same) is a REAL
    measurement and yields a zero-width interval — never shortened to a
    falsy check, and never reported as "unavailable".
    """
    n = len(target_ratings)
    sd = stdev(target_ratings) if n >= 2 else None
    ci = (
        _ci_mean(fmean(target_ratings), sd, n, method=CI_METHOD_PASSAGE_LEVEL_T)
        if sd is not None else None
    )
    if ci is None:
        return {
            "target_sd": sd,
            "ci_lower": None,
            "ci_upper": None,
            "ci_level": 0.95,
            "ci_method": CI_METHOD_PASSAGE_LEVEL_T,
            "ci_unavailable_reason": CI_UNAVAILABLE_INSUFFICIENT_PASSAGES,
        }
    return {"target_sd": sd, **ci, "ci_unavailable_reason": None}


def compute_magnitude_rollup(db: Session, project_id: int) -> MagnitudeRollup:
    """Roll every rating in one project up to a per-participant, per-code score.

    Pure over the database: reads, computes, stores nothing. See the module
    docstring for the two steps, the voter rule and the disclosure.
    """
    # 🔴 The PROJECT scope, not the consensus writer's. A rollup that must SAY
    # what it excluded has to be able to SEE it: sourcing this from
    # `consensus_eligible` drops an UNFROZEN observation's clips before they
    # arrive, so their ratings vanish with no disclosure — the one failure mode
    # Decision 4 forbids. See `gather_target_votes`' docstring.
    votes = gather_target_votes(db, project_id, segment_scope=SEGMENT_SCOPE_PROJECT)

    # Resolve every target ONCE. Bounded by coding volume, not dataset size.
    resolution = resolve_participants(
        db, project_id,
        segment_ids=votes.seg_buckets.keys(),
        dataset_value_ids=votes.val_buckets.keys(),
    )
    code_names = dict(
        db.query(Code.id, Code.name).filter(Code.project_id == project_id).all()
    )

    excluded: dict[str, int] = {}
    # (participant, effective code) → the step-1 target ratings, in target order.
    collected: dict[tuple[int, int], list[dict]] = {}
    # Participants any usable application reached, whether or not it was rated.
    reached: set[int] = set()

    def _consume(
        target_key: tuple[str, int],
        per_coder: dict[int, set[int]],
        ratings: dict[int, dict[int, float | None]],
        route: ParticipantRoute | None,
    ) -> None:
        # How many coder judgements does this target carry at all? Counted up
        # front so an excluded target discloses its ratings rather than its
        # applications — the grain the docstring promises.
        def _n_ratings_for(eff: int) -> int:
            return sum(1 for v in _rating_values(ratings, per_coder, eff) if v is not None)

        all_effs = {eff for codes in per_coder.values() for eff in codes}

        if route is None:
            # Not resolvable at all — a target outside the project cannot be in
            # this project's gather, so this is unreachable rather than a state.
            return
        if route.participant_id is None:
            for eff in all_effs:
                _exclude(excluded, route.unresolved_reason, _n_ratings_for(eff))
            return
        if route.via_facilitator:
            for eff in all_effs:
                _exclude(excluded, EXCLUDED_FACILITATOR_TURN, _n_ratings_for(eff))
            return

        reached.add(route.participant_id)

        if len(per_coder) >= 2:
            agreed = {eff for eff, _rule, _agree, _voters in _decide_consensus(per_coder)}
        else:
            # One voter: no consensus is possible, and their judgement stands.
            agreed = all_effs

        for eff in all_effs:
            if eff not in agreed:
                _exclude(excluded, EXCLUDED_NO_CODE_CONSENSUS, _n_ratings_for(eff))
                continue
            scale = votes.scales.get(eff)
            if scale is None:
                _exclude(excluded, EXCLUDED_NO_DECLARED_SCALE, _n_ratings_for(eff))
                continue
            # Step 1 — the target rating. ONE implementation, shared with the
            # stored consensus layer, so a score can never disagree with the
            # median the reconciliation grid shows for the same passage.
            decision = _decide_magnitude(_rating_values(ratings, per_coder, eff), scale)
            if decision is None:
                continue  # applied but nobody rated it — contributes nothing
            collected.setdefault((route.participant_id, eff), []).append(
                {"key": target_key, "decision": decision}
            )

    for seg_id, per_coder in votes.seg_buckets.items():
        _consume(
            ("seg", seg_id), per_coder, votes.seg_ratings.get(seg_id, {}),
            resolution.segments.get(seg_id),
        )
    for val_id, per_coder in votes.val_buckets.items():
        _consume(
            ("val", val_id), per_coder, votes.val_ratings.get(val_id, {}),
            resolution.dataset_values.get(val_id),
        )

    scores: list[ParticipantCodeScore] = []
    for (participant_id, eff), entries in sorted(collected.items()):
        entries.sort(key=lambda e: e["key"])
        decisions = [e["decision"] for e in entries]
        medians = tuple(float(d["median"]) for d in decisions)
        rater_counts = [int(d["n_rated"]) for d in decisions]
        scores.append(ParticipantCodeScore(
            participant_id=participant_id,
            code_id=eff,
            code_name=code_names.get(eff, ""),
            # Step 2 — the scoring act, and the only new arithmetic here.
            mean=fmean(medians),
            target_ratings=medians,
            n_targets=len(medians),
            n_ratings=sum(rater_counts),
            min_raters_per_target=min(rater_counts),
            max_raters_per_target=max(rater_counts),
            n_flagged_targets=sum(1 for d in decisions if d["flag"]),
            scale=votes.scales[eff],
            # Row 45 (iii) — over THIS person's passages, stated as such.
            **_passage_interval(medians),
        ))

    scored = {s.participant_id for s in scores}
    return MagnitudeRollup(
        scores=tuple(scores),
        excluded_ratings=excluded,
        participants_coded_unrated=frozenset(reached - scored),
    )
