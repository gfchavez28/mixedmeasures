"""Cutting a recording's timeline into clips.

ONE pure function decides where an observation's clips fall, and BOTH the
preview and the write call it. That is what makes the wizard's promise honest:
the count you saw in the preview is the count you get, because it is the same
code reading the same persisted duration — not a browser measurement in the
preview and a container probe at import (which is how the two can disagree, and
does on a VBR mp3 or a header-less WebM).

Clips are POINTERS at a timeline, not a partition of it: they may overlap, they
may leave gaps, and an observation with zero clips is a legal, first-class state
(the manual path — you cut them in the workbench while watching).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

# Modes are a closed set; anything else is a wiring bug, not user input.
MODE_NONE = "none"
MODE_FIXED_INTERVAL = "fixed_interval"
MODE_CUE_LIST = "cue_list"
SEGMENTATION_MODES = (MODE_NONE, MODE_FIXED_INTERVAL, MODE_CUE_LIST)

# A 3-hour recording at a 1-second interval is 10,800 clips — enough to make the
# timeline unrenderable, the merge gate's per-source uuid set enormous, and the
# preview payload a megabyte of JSON. The cap lives HERE, in the shared cutter,
# so the preview refuses before the user commits rather than after.
MAX_CLIPS = 2000

# Below this an "interval" is not a coding unit, and 0 would loop forever.
MIN_INTERVAL_SECONDS = 1.0

# Clips shorter than this are rounding dust (a trailing sliver on an exact
# division), not units. Distinct from a deliberate point event (start == end),
# which the timeline draws as a pin and which stays legal.
MIN_CLIP_SECONDS = 0.001


class SegmentationError(ValueError):
    """A segmentation request that cannot be honoured. Surfaces as a 400."""


@dataclass(frozen=True)
class ClipSpec:
    """One proposed clip. `sequence_order` is assigned after the whole set is sorted."""

    start_time: float
    end_time: float
    label: str = ""


@dataclass
class CutResult:
    clips: list[ClipSpec] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def total(self) -> int:
        return len(self.clips)


def _order_clips(clips: list[ClipSpec]) -> list[ClipSpec]:
    """Deterministic order for a set that may overlap.

    Overlapping intervals have no natural total order, so pin one:
    (start, end, original index). The index tiebreak keeps the sort stable for
    identical ranges — Zoom VTTs routinely emit duplicate consecutive timestamps.
    `sequence_order` is then just the position in this list.
    """
    return [c for _, c in sorted(
        ((i, c) for i, c in enumerate(clips)),
        key=lambda pair: (pair[1].start_time, pair[1].end_time, pair[0]),
    )]


def _fixed_interval_clips(duration: float, interval: float) -> list[ClipSpec]:
    count = math.ceil(duration / interval)
    clips: list[ClipSpec] = []
    for i in range(count):
        # Multiply, never accumulate: `t += interval` drifts measurably over
        # thousands of iterations.
        start = i * interval
        end = min((i + 1) * interval, duration)
        if end - start < MIN_CLIP_SECONDS:
            # An exact division leaves a zero-width sliver at the end; it is not
            # a unit. (A deliberate point event is a different thing entirely.)
            continue
        clips.append(ClipSpec(start_time=start, end_time=end))
    return clips


def _cue_list_clips(cues: list[dict], duration: float | None) -> tuple[list[ClipSpec], list[str]]:
    """Cue in/out points become clips; cue text becomes the clip's label.

    The cue file and the recording are INDEPENDENT artifacts (a trimmed export, a
    transcript of a longer session), so a cue past the end of the recording is
    reported, never silently dropped and never clamped — clamping would edit the
    researcher's data to fit our file.
    """
    clips: list[ClipSpec] = []
    warnings: list[str] = []
    reversed_count = 0
    past_end_count = 0

    for cue in cues:
        start = float(cue.get("start", 0.0))
        end = float(cue.get("end", 0.0))
        if end < start:
            # parse_subtitle_cues does no range validation at all.
            reversed_count += 1
            continue
        if duration is not None and start > duration:
            past_end_count += 1
        label = (cue.get("text") or "").strip()
        clips.append(ClipSpec(start_time=start, end_time=end, label=label))

    if reversed_count:
        warnings.append(
            f"Skipped {reversed_count} cue(s) whose end time came before their start time."
        )
    if past_end_count:
        warnings.append(
            f"{past_end_count} cue(s) start after the recording ends — they were kept as "
            "clips, but there is no video behind them. Check that the cue file matches "
            "this recording."
        )
    return clips, warnings


def cut_clips(
    mode: str,
    *,
    duration_seconds: float | None = None,
    interval_seconds: float | None = None,
    cues: list[dict] | None = None,
) -> CutResult:
    """Decide where an observation's clips fall. Pure — no DB, no IO.

    Raises SegmentationError for a request that cannot be honoured (the caller
    maps it to a 400). Never returns a silently-empty set for a mode the user
    actively chose: "you asked for intervals and got zero clips" is the failure
    we refuse to ship.
    """
    if mode not in SEGMENTATION_MODES:
        raise SegmentationError(f"Unknown segmentation mode: {mode!r}")

    if mode == MODE_NONE:
        return CutResult()

    if mode == MODE_FIXED_INTERVAL:
        if interval_seconds is None:
            raise SegmentationError("An interval is required to cut fixed-interval clips.")
        if not math.isfinite(interval_seconds) or interval_seconds < MIN_INTERVAL_SECONDS:
            raise SegmentationError(
                f"The interval must be at least {MIN_INTERVAL_SECONDS:g} second(s)."
            )
        if duration_seconds is None or duration_seconds <= 0:
            # The honest refusal. Cutting zero clips and calling it success is
            # how a researcher discovers, an hour later, that nothing happened.
            raise SegmentationError(
                "We couldn't read how long this recording is, so it can't be sliced "
                "into intervals. Start empty and mark clips in the workbench instead."
            )
        clips = _fixed_interval_clips(duration_seconds, interval_seconds)
        warnings: list[str] = []

    else:  # MODE_CUE_LIST
        if not cues:
            raise SegmentationError(
                "No cues were found in that file. A cue file is a WebVTT (.vtt) or "
                "SubRip (.srt) export with timed entries."
            )
        clips, warnings = _cue_list_clips(cues, duration_seconds)
        if not clips:
            raise SegmentationError("None of the cues in that file could be used as clips.")

    if len(clips) > MAX_CLIPS:
        raise SegmentationError(
            f"That would create {len(clips):,} clips, over the {MAX_CLIPS:,} limit. "
            "Use a longer interval, or start empty and mark the moments that matter."
        )

    return CutResult(clips=_order_clips(clips), warnings=warnings)


def looks_like_a_transcript(cues: list[dict], default_speaker: str) -> bool:
    """Is this cue file really a dialogue transcript?

    Then the researcher probably wants to code what was SAID, and a Conversation
    (with the recording attached) is the source type that can do that — an
    Observation would turn every utterance into a clip label and give them no
    searchable text and no speaker spine. Derived from the parser's existing
    output: a voice tag or a `Name:` prefix actually fired on some cue.
    """
    return any(cue.get("speaker") and cue["speaker"] != default_speaker for cue in cues)


def resequence_observation_clips(db, observation_id: int) -> None:
    """Re-derive ``sequence_order`` for an observation's VISIBLE clips (slab 3a).

    Clips are written in start-time order at cut time, but a boundary edit,
    manual create, delete, or time-op can change temporal order — and every
    ordering surface (exports, the excerpt ±1-context lookup, code-analysis
    quote ordering, the ORM default relationship order) reads ``sequence_order``,
    never ``start_time``. The rule is §0.8's deterministic sort for a set that
    may overlap: ``(start_time, end_time, id)`` → 0..n-1, one bulk UPDATE.

    Soft-deleted (merged/split-away) rows are left untouched: they are invisible
    everywhere, and the time-op inverses resequence again on restore.
    """
    from sqlalchemy import case

    from ..models.segment import Segment
    from ..routers.helpers import visible_segment_filter

    rows = (
        db.query(Segment.id)
        .filter(Segment.observation_id == observation_id, *visible_segment_filter())
        .order_by(Segment.start_time, Segment.end_time, Segment.id)
        .all()
    )
    changes = {seg_id: order for order, (seg_id,) in enumerate(rows)}
    if not changes:
        return
    db.query(Segment).filter(Segment.id.in_(changes)).update(
        {Segment.sequence_order: case(changes, value=Segment.id)},
        synchronize_session="fetch",
    )


# --------------------------------------------------------------------------- #
# Coverage intervals (6a — D34)
# --------------------------------------------------------------------------- #
#
# ⚠️ TWO-LANGUAGE MIRROR. `frontend/src/lib/clip-timeline.ts` holds the same
# math for the workbench gauge (blind-scoped, per-coder) while this side serves
# the LIST's all-coder percentage — the list loads no clip payloads, so it
# cannot reuse the client's. The two are pinned against ONE shared table of
# cases (`tests/test_observation_coverage.py::COVERAGE_CASES` ↔
# `clip-timeline.test.ts`), the `order_value_labels`/`compareValueLabels`
# precedent. Edit them together.
#
# Gaps deliberately have NO Python mirror: nothing server-side consumes them
# (`u` is a client gesture), and an unconsumed helper is the speculative code
# this plan keeps warning about. Add it here the day a backend surface needs it.


def union_intervals(intervals: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Merge overlapping/abutting ranges into a disjoint, ascending cover.

    Zero-width ranges are DROPPED — a point event marks an instant, it does not
    cover time (D7). Abutting ranges merge: the boundary is one cut, not a gap.
    """
    ordered = sorted((i for i in intervals if i[1] > i[0]))
    merged: list[tuple[float, float]] = []
    for start, end in ordered:
        if merged and start <= merged[-1][1]:
            if end > merged[-1][1]:
                merged[-1] = (merged[-1][0], end)
        else:
            merged.append((start, end))
    return merged


def coverage_extent(duration_seconds: float | None, max_clip_end: float | None) -> float | None:
    """D34's ONE extent law, server side: ``max(duration ?? 0, max clip end)``.

    ``None`` when there is nothing to measure against — no readable duration AND
    no clips — so the wire can say "no denominator" instead of dividing by zero
    or implying 0%. Clips legally outrun the recording (the cue posture), which
    is why the max is taken rather than the duration trusted; the frontend's
    mirror additionally drops its 60 s ruler DISPLAY floor, which must never
    reach a denominator.
    """
    extent = max(duration_seconds or 0.0, max_clip_end or 0.0)
    return extent if extent > 0 else None


def covered_seconds(union: list[tuple[float, float]], extent: float) -> float:
    """Seconds covered by a union, clamped into ``[0, extent]``.

    The clamp matters: clips legally OUTRUN the recording (``_validate_clip_range``
    never clamps — the cue posture), so without it a long overhanging clip would
    report more than 100% covered.
    """
    if extent <= 0:
        return 0.0
    total = 0.0
    for start, end in union:
        lo = max(0.0, min(start, extent))
        hi = max(0.0, min(end, extent))
        if hi > lo:
            total += hi - lo
    return total
