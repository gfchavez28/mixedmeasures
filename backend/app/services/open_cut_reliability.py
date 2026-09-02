"""Reliability for OPEN observation cuts (Observations slab 6b-A).

When an observation's segmentation is frozen the team agreed the clips, every
coder codes the same units, and the ordinary consensus/κ engines apply — that is
6b-B. This module is the other case: **each coder marks their own time ranges**,
so there are no shared units to compare on and agreement has to be defined before
it can be measured.

Two definitions ship here, because they answer different questions and a pair of
coders can legitimately score well on one and badly on the other:

* **Unitizing α (α_U)** — Krippendorff's continuum model. Treats the whole
  recording as the unit of analysis and scores how well the coders' *marked
  stretches* line up, boundaries included. Answers "did we carve this up the same
  way?"
* **Time-binned κ** — slice the timeline into fixed bins and ask, per bin, whether
  each coder had the code active. Answers "at any given moment, did we agree about
  what was happening?" This is the number the dedicated video tools report, so it
  is parity rather than novelty.

**This module deliberately does NOT reuse `irr.gather_coder_applications`.** That
gather records engagement at the SOURCE level (Option B), and `Segment` has no
creator column — every coder's clips sit under one `observation_id`, i.e. one
source — so it would hand each coder an explicit "declined" on clips they never
saw. That is not a small distortion: it drives κ to exactly -1.0 when the coders
mark equal numbers of clips, and α to -1 + 1/n, getting worse the more work
everyone does.

Three modelling choices move the numbers and are therefore REPORTED, not hidden
(see `OpenCutDisclosure`): overlapping same-code stretches by one coder are
merged, zero-length marks are dropped, and a coder who marked nothing at all is
excluded from the roster rather than counted as having marked nothing.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from ..auth import SYSTEM_CODER_TYPES
from ..models.code import Code
from ..models.code_application import CodeApplication
from ..models.observation import Observation
from ..models.segment import Segment
from ..models.user import User
from ..routers.helpers import visible_segment_filter
from .coding_layers import (
    build_effective_code_map,
    non_consensus_filter,
    resolve_effective_code,
)
from .irr import (
    ALPHA_THRESHOLDS,
    KAPPA_THRESHOLDS,
    _cohens_kappa,
    _interpret_alpha,
    _interpret_kappa,
    _krippendorff_alpha,
    _percent_agreement,
    _prevalence,
)
from .observation_segmentation import coverage_extent
from .reliability_intervals import (
    CI_UNAVAILABLE_AUTOCORRELATED_BINS,
    CI_UNAVAILABLE_SINGLE_CONTINUUM,
)
from .unitizing import UnitizingUnit, unitizing_alpha

# 100 ms. The continuum is discretized because `unitizing.py` takes INTEGER
# offsets and lengths — it has no tick parameter, and its exact `Fraction`
# arithmetic raises outright on floats. A reported methods parameter, not an
# implementation detail: at 100 ms two coders who differ by a twentieth of a
# second are scored as agreeing.
TICK_MS = 100
_TICKS_PER_SECOND = 1000 / TICK_MS

# Below this a bin count is meaningless; above it we would build a vector per
# code per coder over hundreds of thousands of bins for no added precision.
MIN_BIN_SECONDS = 0.1
MAX_BINS = 200_000
DEFAULT_BIN_SECONDS = 1.0


@dataclass
class OpenCutDisclosure:
    """What the computation did to the data before measuring it.

    Every field here is a modelling decision that MOVES the result, so it rides
    the wire rather than living in a docstring. A reader who cannot see these
    cannot reproduce the number.
    """
    tick_ms: int = TICK_MS
    continuum_seconds: float = 0.0
    extent_source: str = "unknown"  # "recording" | "marked_extent"
    n_merged_overlaps: int = 0
    n_zero_length_dropped: int = 0
    n_clips_without_times: int = 0
    engaged_coder_ids: list[int] = field(default_factory=list)
    excluded_coder_ids: list[int] = field(default_factory=list)
    #: #43 — why these coefficients carry no confidence interval when the
    #: Reliability tab's κ and α do. Set per statistic by the two computers
    #: below, because the two have DIFFERENT reasons. Stated rather than left
    #: blank: a coefficient that silently lacks an interval its neighbour has
    #: reads as an oversight, and the reason is the honest part.
    ci_unavailable_reason: str | None = None


def seconds_to_ticks(seconds: float) -> int:
    """Seconds → whole 100 ms ticks, rounded half-up.

    Python's `round` is banker's rounding, which would send 0.05 s and 0.15 s in
    opposite directions — the same trap `format_timecode` documents.
    """
    return int(seconds * _TICKS_PER_SECOND + 0.5)


def merge_strict_overlaps(
    intervals: list[tuple[float, float]],
) -> tuple[list[tuple[float, float]], int]:
    """Merge OVERLAPPING intervals; leave ABUTTING ones distinct.

    Returns (merged, n_merges).

    ⚠️ Deliberately not `observation_segmentation.union_intervals`, which merges
    abutting ranges too. Krippendorff's reference implementation keeps abutting
    units separate — two back-to-back 5 s marks are two units, not one 10 s unit —
    and collapsing them changes both the unit count and the length distribution,
    each of which feeds the expected disagreement. Reusing the 6a union here would
    silently alter the statistic.

    Merging at all is a modelling decision, not a normalisation: the continuum
    model has no representation for "marked twice", and one coder's two
    overlapping marks of the same code assert their union. `unitizing._sections`
    raises on the un-merged input, so the alternative is refusing to compute.
    """
    if not intervals:
        return [], 0
    ordered = sorted(intervals)
    merged: list[tuple[float, float]] = [ordered[0]]
    n_merges = 0
    for start, end in ordered[1:]:
        last_start, last_end = merged[-1]
        if start < last_end:  # strict overlap — abutting (start == last_end) stays
            merged[-1] = (last_start, max(last_end, end))
            n_merges += 1
        else:
            merged.append((start, end))
    return merged, n_merges


@dataclass
class OpenCutData:
    """The gathered marks, ready for either statistic."""
    coder_ids: list[int]
    # (coder_id, effective_code_id) -> merged, ordered intervals in seconds
    intervals: dict[tuple[int, int], list[tuple[float, float]]]
    extent_seconds: float | None
    disclosure: OpenCutDisclosure


def gather_open_cut_marks(
    db: Session,
    project_id: int,
    observation: Observation,
    coder_ids: list[int] | None = None,
) -> OpenCutData:
    """Per (coder, effective code) time ranges on one UNFROZEN observation.

    Engagement is COD ER-level here, not source-level: a coder who marked at least
    one clip is on the roster and their whole continuum counts (their gaps are
    real judgements); a coder who marked nothing is excluded entirely rather than
    counted as having marked nothing, because a no-show would otherwise read as
    perfect disagreement with everyone.
    """
    disclosure = OpenCutDisclosure()

    roster_q = db.query(User).filter(
        User.coder_type.notin_(SYSTEM_CODER_TYPES),
        User.archived == False,  # noqa: E712
    )
    if coder_ids:
        roster_q = roster_q.filter(User.id.in_(coder_ids))
    roster = sorted(c.id for c in roster_q.all())

    eff = build_effective_code_map(db, project_id)

    rows = (
        db.query(
            Segment.id, Segment.start_time, Segment.end_time,
            CodeApplication.user_id, CodeApplication.code_id,
        )
        .join(CodeApplication, CodeApplication.segment_id == Segment.id)
        .join(Code, CodeApplication.code_id == Code.id)
        .join(User, CodeApplication.user_id == User.id)
        .filter(
            Segment.observation_id == observation.id,
            *visible_segment_filter(),
            non_consensus_filter(),
            Code.is_universal == False,  # noqa: E712
            User.coder_type.notin_(SYSTEM_CODER_TYPES),
            CodeApplication.user_id.in_(roster) if roster else False,
        )
        .all()
    )

    raw: dict[tuple[int, int], list[tuple[float, float]]] = defaultdict(list)
    max_clip_end = 0.0
    for _seg_id, start, end, uid, code_id in rows:
        # `start_time`/`end_time` are nullable on Segment (a transcript segment
        # legitimately has none), so a clip missing either is dropped and counted
        # rather than allowed to reach arithmetic as None.
        if start is None or end is None:
            disclosure.n_clips_without_times += 1
            continue
        if end <= start:
            # A point event. Zero length has no representation on the continuum —
            # `_sections` rejects it — so α_U cannot see point marks at all.
            disclosure.n_zero_length_dropped += 1
            continue
        max_clip_end = max(max_clip_end, end)
        raw[(uid, resolve_effective_code(eff, code_id))].append((start, end))

    intervals: dict[tuple[int, int], list[tuple[float, float]]] = {}
    for key, spans in raw.items():
        merged, n_merges = merge_strict_overlaps(spans)
        disclosure.n_merged_overlaps += n_merges
        intervals[key] = merged

    engaged = sorted({uid for (uid, _code) in intervals})
    disclosure.engaged_coder_ids = engaged
    disclosure.excluded_coder_ids = [c for c in roster if c not in engaged]

    extent = coverage_extent(observation.media_duration_seconds, max_clip_end or None)
    disclosure.continuum_seconds = extent or 0.0
    # #622's lesson: never present a fallback denominator as if it were the
    # recording's length. Which one was used rides the wire.
    disclosure.extent_source = (
        "recording" if observation.media_duration_seconds else "marked_extent"
    )

    return OpenCutData(
        coder_ids=engaged, intervals=intervals,
        extent_seconds=extent, disclosure=disclosure,
    )


def _unavailable(reason: str, disclosure: OpenCutDisclosure) -> dict:
    return {
        "available": False, "reason": reason,
        "n_coders": len(disclosure.engaged_coder_ids),
        "coders": disclosure.engaged_coder_ids,
        "overall": None, "per_category": [],
        "disclosure": disclosure.__dict__,
    }


def compute_unitizing_alpha(
    db: Session, project_id: int, observation: Observation,
    coder_ids: list[int] | None = None,
) -> dict:
    """α_U over one unfrozen observation: overall + per effective code.

    🔴 **No confidence interval, deliberately (#43).** α_U is measured over ONE
    continuum, and the things a bootstrap would resample — the marked stretches —
    are the very objects whose boundaries the statistic is scoring. Resampling
    them changes the continuum, the gap distribution and therefore the expected
    disagreement, so the interval would not be an interval for this coefficient.
    Neither Krippendorff (1995, 2004) nor the DKPro reference implementation
    defines one. The reason rides the disclosure instead.
    """
    data = gather_open_cut_marks(db, project_id, observation, coder_ids)
    d = data.disclosure
    d.ci_unavailable_reason = CI_UNAVAILABLE_SINGLE_CONTINUUM

    if len(data.coder_ids) < 2:
        return _unavailable(
            "Unitizing agreement needs at least 2 coders who marked clips here.", d)
    if not data.extent_seconds:
        return _unavailable(
            "This recording has no readable length and no marked clips, so there is "
            "no continuum to measure against.", d)

    continuum = seconds_to_ticks(data.extent_seconds)
    index_of = {cid: i for i, cid in enumerate(data.coder_ids)}
    units: list[UnitizingUnit] = []
    for (uid, code_id), spans in data.intervals.items():
        for start, end in spans:
            offset = seconds_to_ticks(start)
            length = seconds_to_ticks(end) - offset
            if length <= 0:
                # Two distinct marks can collapse onto one tick at 100 ms.
                d.n_zero_length_dropped += 1
                continue
            # Clips may legally outrun the recording (the cue posture), but a unit
            # outside the continuum is rejected by `_sections`, so clamp the tail.
            if offset >= continuum:
                continue
            length = min(length, continuum - offset)
            units.append(UnitizingUnit(
                coder=index_of[uid], offset=offset, length=length, category=code_id))

    if not units:
        return _unavailable("No clips with a measurable duration to compare.", d)

    result = unitizing_alpha(continuum, len(data.coder_ids), units)
    code_names = dict(
        db.query(Code.id, Code.name)
        .filter(Code.id.in_({u.category for u in units})).all()
    )
    per_category = [
        {
            "code_id": cid,
            "code_name": code_names.get(cid, f"Code {cid}"),
            "n_units": stats["n_units"],
            "alpha": stats["alpha"],
            "interpretation": _interpret_alpha(stats["alpha"]),
            # Coverage share, NOT the bin fraction binned κ reports — the same
            # word with a different denominator, so the two are named apart.
            "coverage_fraction": _coverage_fraction(data, cid),
        }
        for cid, stats in sorted(result["per_category"].items())
    ]
    return {
        "available": True, "reason": None,
        "n_coders": len(data.coder_ids), "coders": data.coder_ids,
        "overall": {
            "alpha": result["overall"]["alpha"],
            "interpretation": _interpret_alpha(result["overall"]["alpha"]),
        },
        "per_category": per_category,
        "disclosure": d.__dict__,
        "interpretation_thresholds": ALPHA_THRESHOLDS,
    }


def _coverage_fraction(data: OpenCutData, code_id: int) -> float | None:
    """Share of the continuum any coder marked with this code — α_U's prevalence.

    Deliberately a different figure from binned κ's bin fraction: reporting one
    number under one name while it silently changes denominator between methods is
    how a prevalence caveat becomes misinformation.
    """
    if not data.extent_seconds:
        return None
    spans = [s for (_uid, cid), v in data.intervals.items() if cid == code_id for s in v]
    if not spans:
        return 0.0
    merged, _n = merge_strict_overlaps(spans)
    covered = sum(end - start for start, end in merged)
    return min(covered / data.extent_seconds, 1.0)


def compute_binned_kappa(
    db: Session, project_id: int, observation: Observation,
    bin_seconds: float = DEFAULT_BIN_SECONDS,
    coder_ids: list[int] | None = None,
) -> dict:
    """Time-binned agreement: slice the timeline, then score per code per bin.

    The bin width is a reported parameter, not a constant — it changes the answer.
    Wider bins absorb boundary disagreements and read as more agreement; narrower
    bins increase the uncoded mass, which inflates percent agreement while κ stays
    honest. That gap is why prevalence is reported beside every coefficient.

    🔴 **No confidence interval, deliberately (#43), and for a DIFFERENT reason
    than α_U's.** The bins are not independent observations: a 5 s mark occupies
    five consecutive 1 s bins, so neighbouring bins are strongly autocorrelated
    and a naive bin bootstrap would understate the interval — the more so the
    wider the marks, i.e. exactly where a reader would trust it most. The correct
    instrument is a block bootstrap whose block length is itself a research
    decision, which is a design call and not a detail to pick silently here.
    """
    data = gather_open_cut_marks(db, project_id, observation, coder_ids)
    d = data.disclosure
    d.ci_unavailable_reason = CI_UNAVAILABLE_AUTOCORRELATED_BINS

    if len(data.coder_ids) < 2:
        return _unavailable(
            "Time-binned agreement needs at least 2 coders who marked clips here.", d)
    if not data.extent_seconds:
        return _unavailable(
            "This recording has no readable length and no marked clips, so there are "
            "no bins to compare.", d)
    if bin_seconds < MIN_BIN_SECONDS:
        return _unavailable(
            f"The bin size must be at least {MIN_BIN_SECONDS:g} seconds.", d)

    n_bins = int(data.extent_seconds / bin_seconds) + 1
    if n_bins > MAX_BINS:
        return _unavailable(
            f"That bin size would make {n_bins:,} bins for this recording "
            f"(limit {MAX_BINS:,}). Use a larger bin.", d)

    index_of = {cid: i for i, cid in enumerate(data.coder_ids)}
    code_ids = sorted({code for (_uid, code) in data.intervals})

    per_code = []
    for code_id in code_ids:
        # bins[coder_index] = set of bin indices where that coder had this code on
        active: list[set[int]] = [set() for _ in data.coder_ids]
        for (uid, cid), spans in data.intervals.items():
            if cid != code_id:
                continue
            for start, end in spans:
                first = int(start / bin_seconds)
                # A mark ending exactly on a boundary does not occupy the next bin.
                last = int((end - 1e-9) / bin_seconds)
                for b in range(max(first, 0), min(last, n_bins - 1) + 1):
                    active[index_of[uid]].add(b)
        rows = [[1 if b in coder_bins else 0 for coder_bins in active]
                for b in range(n_bins)]
        per_code.append({
            "code_id": code_id,
            "code_name": None,  # filled below in one query
            "n_bins": n_bins,
            "percent_agreement": _percent_agreement(rows),
            "cohens_kappa": _cohens_kappa(rows) if len(data.coder_ids) == 2 else None,
            "krippendorff_alpha": _krippendorff_alpha(rows),
            # The sparse-clip trap: on a long recording most bins are empty for
            # both coders, so percent agreement can read ~99% while κ collapses.
            # The base rate is what tells a reader which they are looking at.
            "prevalence": _prevalence(rows),
            "interpretation": _interpret_kappa(
                _cohens_kappa(rows) if len(data.coder_ids) == 2
                else _krippendorff_alpha(rows)),
        })

    names = dict(db.query(Code.id, Code.name).filter(Code.id.in_(code_ids)).all())
    for entry in per_code:
        entry["code_name"] = names.get(entry["code_id"], f"Code {entry['code_id']}")

    return {
        "available": True, "reason": None,
        "n_coders": len(data.coder_ids), "coders": data.coder_ids,
        "bin_seconds": bin_seconds,
        "n_bins": n_bins,
        "per_code": per_code,
        "disclosure": d.__dict__,
        "interpretation_thresholds": KAPPA_THRESHOLDS,
    }
