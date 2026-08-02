/**
 * Pure logic for the observation timeline (slab 3d) — jsdom-testable without
 * the component: the I/O/P marking state machine, same-lane overlap stacking,
 * and the boundary-nudge clamp. The DOM/pointer layer lives in
 * `components/observations/ClipTimeline.tsx`; keeping the decisions here is
 * what makes the marking flow testable the way §8h.5 requires.
 */

import { formatTimecode } from '@/lib/utils'

/** A committed range from the marking machine. `start === end` = point event (D7). */
export interface MarkedRange {
  start: number
  end: number
}

/**
 * The armed-mark state: `null` = idle; a number = the in-point armed at that
 * timeline time. Deliberately a bare value, not an object — the state machine
 * is three verbs over one number.
 */
export type ArmedMark = number | null

/** `I` — arm the in-point at the playhead. Re-pressing MOVES it (never stacks). */
export function armMark(playhead: number): ArmedMark {
  return Math.max(0, playhead)
}

/**
 * `O` — commit the armed range at the playhead. Returns null when nothing is
 * armed (O alone is not a gesture). The range is NORMALIZED to [min, max]: a
 * backward seek between I and O is forgiven, not rejected — the researcher
 * marked two positions, and order is our job. Equal positions commit a point
 * event (legal, D7) rather than erroring a deliberate double-tap.
 */
export function commitMark(armed: ArmedMark, playhead: number): MarkedRange | null {
  if (armed === null) return null
  const t = Math.max(0, playhead)
  return { start: Math.min(armed, t), end: Math.max(armed, t) }
}

/** `P` — a point event at the playhead, armed state untouched. */
export function pointMark(playhead: number): MarkedRange {
  const t = Math.max(0, playhead)
  return { start: t, end: t }
}

/**
 * Same-lane overlap stacking: assign each clip a track index so overlapping
 * clips render stacked instead of occluding. Greedy sweep over clips in
 * (start, end, id) order — first track whose last occupant has ended. Point
 * events occupy an instant; two clips ABUTTING (a.end === b.start) share a
 * track (they don't overlap — the boundary is one cut).
 *
 * Input may be any order; output maps clip id → track. Track count is
 * `1 + max(track)`, which sizes the lane.
 */
export function assignTracks(
  clips: { id: number; start_time: number; end_time: number }[],
): Map<number, number> {
  const ordered = [...clips].sort(
    (a, b) => a.start_time - b.start_time || a.end_time - b.end_time || a.id - b.id,
  )
  const trackEnds: number[] = []
  const result = new Map<number, number>()
  for (const clip of ordered) {
    let track = trackEnds.findIndex(end => end <= clip.start_time)
    if (track === -1) {
      track = trackEnds.length
      trackEnds.push(clip.end_time)
    } else {
      trackEnds[track] = clip.end_time
    }
    // A point event must still BLOCK its instant: treat its occupancy as an
    // epsilon so a second point at the same time stacks below, not on top.
    if (clip.start_time === clip.end_time) trackEnds[track] = clip.end_time + 1e-9
    result.set(clip.id, track)
  }
  return result
}

// ── The live drag readout (#655) ────────────────────────────────────────────

/**
 * A pointer drag in progress on the timeline. Lives here rather than in the
 * component because `dragReadout` is the decision worth testing without a DOM.
 */
export type TimelineDrag =
  | { kind: 'boundary'; clipId: number; edge: 'start' | 'end'; value: number }
  | { kind: 'create'; anchor: number; current: number; moved: boolean }

export interface DragReadout {
  /** Timeline seconds the label anchors to — the edge under the pointer. */
  at: number
  /** What the label says. */
  text: string
}

/**
 * What the floating label says while dragging, or null for no label.
 *
 * #655: this used to exist for BOUNDARY drags only, so marking a NEW clip by
 * dragging empty lane space showed no start, no end and no duration — you drew
 * the range blind and learned what you had made only after releasing. A create
 * drag is the gesture that most needs the numbers, because unlike a boundary
 * edit there is no existing clip on screen to read them off.
 *
 * A create drag under the movement threshold returns null: that gesture is
 * still a click-to-seek, and flashing "0:00.0–0:00.0 · 0:00.0" on every seek
 * would be noise. This mirrors the preview rectangle, which draws on `moved`
 * for the same reason.
 */
export function dragReadout(drag: TimelineDrag | null): DragReadout | null {
  if (drag === null) return null
  if (drag.kind === 'boundary') {
    return { at: drag.value, text: formatTimecode(drag.value) }
  }
  if (!drag.moved) return null
  const start = Math.min(drag.anchor, drag.current)
  const end = Math.max(drag.anchor, drag.current)
  return {
    // Anchored to the moving edge, not the fixed one, so the label tracks the
    // pointer instead of being left behind at the start of a long drag.
    at: drag.current,
    text: `${formatTimecode(start)}–${formatTimecode(end)} · ${formatTimecode(end - start)}`,
  }
}

/**
 * Clamp one boundary nudge/entry so the edit can never cross the other edge or
 * go negative. Crossing STOPS AT the other edge (yielding a point event at the
 * limit) rather than swapping — a nudge past the far edge is almost always an
 * overshoot, and silently swapping edges inverts what the researcher meant.
 */
export function clampBoundary(
  edge: 'start' | 'end',
  value: number,
  clip: { start_time: number; end_time: number },
): number {
  if (edge === 'start') return Math.min(Math.max(0, value), clip.end_time)
  return Math.max(clip.start_time, value)
}

// ── Category lanes (D28, slab 4e) ───────────────────────────────────────────

export interface TimelineLane<T> {
  /** `cat-{categoryId}` | 'uncategorized' | 'uncoded' — stable collapse keys. */
  key: string
  label: string
  clips: T[]
}

/**
 * Group clips into category lanes (D28/D13): one lane per category with ≥1
 * member (in the caller's given category order — the backend's
 * CodeCategory.display_order), then "Uncategorized" (visible codes with no
 * category), then "Uncoded" — ALWAYS present, even empty: it is the marking
 * strip's lane (D13) and the drag-create surface when every clip is coded.
 *
 * A multi-category clip appears in EACH matching lane (same clip id, several
 * bars — D13); a clip with two codes in the SAME category appears in that lane
 * once. Drag-in-lane creates UNCODED clips regardless of lane — lanes are a
 * READ of the coding, never a write surface.
 *
 * ⚠️ Blind lens: `getVisibleCodeIds` MUST be the chip chokepoint
 * (`distinctVisibleCodeIds(details, chipHidden)`) — raw applied codes would
 * leak "a colleague coded this" through lane placement (the D28 rule).
 */
export function buildLanes<T extends { id: number }>(
  clips: T[],
  getVisibleCodeIds: (clip: T) => number[],
  orderedCategories: { id: number; name: string }[],
  codeToCategoryId: Map<number, number | null>,
): TimelineLane<T>[] {
  const byLane = new Map<string, T[]>()
  const push = (key: string, clip: T) => {
    const arr = byLane.get(key)
    if (arr) arr.push(clip)
    else byLane.set(key, [clip])
  }
  for (const clip of clips) {
    const codeIds = getVisibleCodeIds(clip)
    if (codeIds.length === 0) {
      push('uncoded', clip)
      continue
    }
    const laneKeys = new Set<string>()
    for (const codeId of codeIds) {
      const catId = codeToCategoryId.get(codeId)
      laneKeys.add(catId != null ? `cat-${catId}` : 'uncategorized')
    }
    for (const key of laneKeys) push(key, clip)
  }
  const lanes: TimelineLane<T>[] = []
  for (const cat of orderedCategories) {
    const members = byLane.get(`cat-${cat.id}`)
    if (members && members.length > 0) {
      lanes.push({ key: `cat-${cat.id}`, label: cat.name, clips: members })
    }
  }
  const uncategorized = byLane.get('uncategorized')
  if (uncategorized && uncategorized.length > 0) {
    lanes.push({ key: 'uncategorized', label: 'Uncategorized', clips: uncategorized })
  }
  lanes.push({ key: 'uncoded', label: 'Uncoded', clips: byLane.get('uncoded') ?? [] })
  return lanes
}

/**
 * Which of a clip's VISIBLE codes put it in this lane (#656).
 *
 * `buildLanes` computes this to decide membership and then throws it away, so
 * the timeline knew a clip belonged to "Behavior" but not WHICH behaviour —
 * which is why every bar was the same teal and the timeline carried no
 * information about what was where.
 *
 * ⚠️ `visibleCodeIds` MUST already be through the blind lens
 * (`distinctVisibleCodeIds(details, chipHidden)`) — the same set lane
 * membership uses. Colour derived from raw applied codes would leak "a
 * colleague coded this" through a channel lane placement already closes (D28).
 * Taking the filtered set as an argument is what makes that unbypassable here.
 *
 * Returns ids in the caller's order (the backend's `display_order`), so the
 * colour a bar takes is deterministic when a clip carries several codes from
 * one category. The Uncoded lane has no codes by construction.
 */
export function laneCodeIds(
  visibleCodeIds: readonly number[],
  laneKey: string,
  codeToCategoryId: Map<number, number | null>,
): number[] {
  if (laneKey === 'uncoded') return []
  return visibleCodeIds.filter(id => {
    const catId = codeToCategoryId.get(id)
    return laneKey === 'uncategorized' ? catId == null : `cat-${catId}` === laneKey
  })
}

/** How many colour bands a bar can show before it collapses to "+n". */
export const MAX_CLIP_FILL_BANDS = 3

/** A clip bar's fill and the codes that justify it (#656). */
export interface ClipFill {
  /**
   * One resolved hex per visible code in this lane, in the backend's
   * `display_order`, capped at `MAX_CLIP_FILL_BANDS`.
   *
   * ⚠️ The bar renders these as HORIZONTAL BANDS STACKED BY HEIGHT, never as
   * segments across its width. On a time axis a width split reads as "code A
   * happens, then code B happens", which is false — every code applies to the
   * WHOLE clip. Splitting the height says "all of these, throughout", which is
   * what a clip's code set actually means.
   */
  colors: string[]
  /** Every visible code in this lane, uncapped, for the bar's tooltip. */
  codeNames: string[]
  /** Codes beyond the band cap — rendered as "+n", 0 when none. */
  overflow: number
}

// ── Coverage intervals (6a — D33/D34/D35) ──────────────────────────────────
//
// Deliberately here and NOT in `coding-progress.ts`: that module owns
// CODED-ness (which clips count, through the blind lens); this one owns
// timeline geometry. The workbench composes them — filter clips by
// `isSegmentCodedVisible`, then feed the survivors' bare ranges in here. 6c's
// per-code airtimes reuse these unchanged (a second union implementation is
// the drift class), which is why they are generic over bare {start, end}.
//
// The backend mirrors this math for the LIST's all-coder percentage
// (`services/observation_segmentation.py`); the two are pinned against ONE
// shared fixture table, the `order_value_labels`/`compareValueLabels`
// precedent.

export interface Interval {
  start: number
  end: number
}

/**
 * Merge overlapping/abutting ranges into a disjoint, ascending cover.
 *
 * Zero-width ranges are DROPPED: a point event marks an instant, it does not
 * cover time (D7). Abutting ranges (a.end === b.start) MERGE — the boundary is
 * one cut, not a gap, and leaving a zero-width gap there would make `u` offer
 * an unreachable destination.
 */
export function unionIntervals(intervals: readonly Interval[]): Interval[] {
  const ordered = intervals
    .filter(i => i.end > i.start)
    .sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: Interval[] = []
  for (const cur of ordered) {
    const last = merged[merged.length - 1]
    if (last && cur.start <= last.end) {
      if (cur.end > last.end) last.end = cur.end
    } else {
      merged.push({ start: cur.start, end: cur.end })
    }
  }
  return merged
}

/** Seconds covered by a union, clamped into `[0, extent]` (never > extent). */
export function coveredSeconds(union: readonly Interval[], extent: number): number {
  if (extent <= 0) return 0
  let total = 0
  for (const i of union) {
    const start = Math.max(0, Math.min(i.start, extent))
    const end = Math.max(0, Math.min(i.end, extent))
    if (end > start) total += end - start
  }
  return total
}

/**
 * The uncovered stretches of `[0, extent]` — what the gauge counts and `u`
 * walks. A fully-covered (or zero-extent) timeline yields none.
 */
export function gapsInExtent(union: readonly Interval[], extent: number): Interval[] {
  if (extent <= 0) return []
  const gaps: Interval[] = []
  let cursor = 0
  for (const i of union) {
    const start = Math.max(0, Math.min(i.start, extent))
    const end = Math.max(0, Math.min(i.end, extent))
    if (end <= cursor) continue
    if (start > cursor) gaps.push({ start: cursor, end: start })
    cursor = end
    if (cursor >= extent) break
  }
  if (cursor < extent) gaps.push({ start: cursor, end: extent })
  return gaps
}

/**
 * Where `u` goes: the start of the first gap STRICTLY after `from`, wrapping to
 * the first gap when there is none ahead. Returns null when nothing is missing.
 *
 * Strictly-after mirrors the conversation `j` walk (`sequence_order > current`):
 * sitting inside a gap, you are already at work to do, so "next" means the one
 * after it. With a single gap that wraps back to its own start, which still
 * MOVES the playhead to the top of the work — a useful answer, not a no-op.
 */
export function nextGapStart(
  gaps: readonly Interval[],
  from: number,
  { wrap = true }: { wrap?: boolean } = {},
): number | null {
  const ahead = gaps.find(g => g.start > from)
  if (ahead) return ahead.start
  if (wrap && gaps.length > 0) return gaps[0].start
  return null
}

/**
 * Where a `?clip=&t=` deep-link should seek (slab 5c).
 *
 * Pure so the containment rule is testable without a media element. The clamp
 * is against the CLIP, deliberately: `clampMediaSeek` already runs inside
 * `seekMedia`, but it bounds the RECORDING's duration, so it cannot keep a
 * stale, hand-edited, or boundary-edit-stranded `t` inside the clip the link
 * named. Absent or unparseable `t` falls back to the clip's start.
 */
export function deepLinkSeekTarget(
  clip: { start_time: number; end_time: number },
  tParam: string | null,
): number {
  if (tParam === null) return clip.start_time
  const t = Number(tParam)
  if (!Number.isFinite(t)) return clip.start_time
  return Math.min(Math.max(t, clip.start_time), clip.end_time)
}
