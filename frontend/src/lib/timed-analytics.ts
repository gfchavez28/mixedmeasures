/**
 * Timed analytics for observation clips (slab 6c) — pure compute.
 *
 * Built ON clip-timeline's coverage primitives (`unionIntervals`/`coveredSeconds`)
 * — a second union implementation is the drift class (plan §8k.4/§8q). Everything
 * here takes bare data and returns bare data; the component owns rendering.
 *
 * Coder lens = INCLUDE-list semantics, deliberately mirroring the backend's
 * `_coder_filter` (services/code_analysis.py) rather than the workbench's
 * hidden-set lens: with an active include set (blind → self, or the coder
 * filter), a detail whose `user_id` is null (unattributed) does NOT count —
 * exactly as `CodeApplication.user_id.in_(coder_ids)` drops NULL rows — so the
 * timeline chart agrees with the neighboring heatmap/bar charts under every
 * lens state. `include === null` means no filter: all coders AND unattributed.
 *
 * Definitions (locked in §8q, DEC-6c-5):
 * - A MARK is one visible (clip × code × coder) application — two coders coding
 *   the same clip with the same code are two marks (each observed a bout).
 * - AIRTIME per code pools all visible coders' marks and unions them, so an
 *   interval two coders both marked counts once. Airtimes across codes do NOT
 *   sum to the covered total (codes overlap) — the table must say so (#503).
 * - BOUT lengths are mark durations PRE-union; point events (start == end) are
 *   counted as marks and in the rate, but have no duration: they are excluded
 *   from bout statistics and contribute nothing to airtime (D7: they mark,
 *   they don't cover).
 * - EXTENT is the D34 law verbatim: max(recording duration ?? 0, farthest clip
 *   end), null when both are absent; the caller labels the fallback.
 */

import { unionIntervals, coveredSeconds, assignTracks } from './clip-timeline'
import { formatTimecode } from './utils'
import type { CodeApplicationIdentity } from './coding-progress'

export interface TimedClipLike {
  id: number
  start_time: number
  end_time: number
  // Identity only: the timeline asks which code and which coder, never the rating.
  applied_code_details: readonly CodeApplicationIdentity[]
}

/** null = no filter (all coders + unattributed). A set = ONLY these coder ids. */
export type CoderInclude = ReadonlySet<number> | null

export function detailVisible(userId: number | null, include: CoderInclude): boolean {
  return include === null || (userId !== null && include.has(userId))
}

export interface TimedMark {
  clipId: number
  start: number
  end: number
  userId: number | null
}

/** Every visible (clip × coder) application of `codeId`, one mark each. */
export function marksForCode(
  clips: readonly TimedClipLike[],
  codeId: number,
  include: CoderInclude,
): TimedMark[] {
  const marks: TimedMark[] = []
  for (const clip of clips) {
    for (const d of clip.applied_code_details) {
      if (d.code_id !== codeId) continue
      if (!detailVisible(d.user_id, include)) continue
      marks.push({ clipId: clip.id, start: clip.start_time, end: clip.end_time, userId: d.user_id })
    }
  }
  return marks
}

export interface TimedCodeRow {
  codeId: number
  /** Visible marks, point events included. */
  marks: number
  /** Zero-length subset of `marks` (disclosed when > 0). */
  pointMarks: number
  /** Per-code union ∩ [0, extent]; 0 when extent is null. */
  airtimeSeconds: number
  /** airtimeSeconds / extent; null when extent is null. */
  airtimeFraction: number | null
  /** marks per minute of extent; null when extent is null. */
  ratePerMinute: number | null
  meanBoutSeconds: number | null
  medianBoutSeconds: number | null
  maxBoutSeconds: number | null
}

function median(sorted: readonly number[]): number {
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function rowFromMarks(codeId: number, marks: readonly TimedMark[], extent: number | null): TimedCodeRow {
  const bouts = marks
    .filter(m => m.end > m.start)
    .map(m => m.end - m.start)
    .sort((a, b) => a - b)
  const airtime = extent != null
    ? coveredSeconds(unionIntervals(marks.map(m => ({ start: m.start, end: m.end }))), extent)
    : 0
  return {
    codeId,
    marks: marks.length,
    pointMarks: marks.length - bouts.length,
    airtimeSeconds: airtime,
    airtimeFraction: extent != null ? airtime / extent : null,
    ratePerMinute: extent != null ? marks.length / (extent / 60) : null,
    meanBoutSeconds: bouts.length > 0 ? bouts.reduce((s, b) => s + b, 0) / bouts.length : null,
    medianBoutSeconds: bouts.length > 0 ? median(bouts) : null,
    maxBoutSeconds: bouts.length > 0 ? bouts[bouts.length - 1] : null,
  }
}

/** One row per selected code, in the caller's (sidebar) order — zero-mark rows kept. */
export function computeTimedRows(
  clips: readonly TimedClipLike[],
  codeIds: readonly number[],
  include: CoderInclude,
  extent: number | null,
): TimedCodeRow[] {
  return codeIds.map(codeId => rowFromMarks(codeId, marksForCode(clips, codeId, include), extent))
}

export interface TimedCoderRow extends TimedCodeRow {
  userId: number | null
}

/**
 * Per-(code, coder) rows — only coders with ≥1 visible mark for that code, so
 * the by-coder table never fabricates empty attribution rows. Coder order
 * within a code: ascending user id (stable across renders).
 */
export function computeTimedRowsByCoder(
  clips: readonly TimedClipLike[],
  codeIds: readonly number[],
  include: CoderInclude,
  extent: number | null,
): TimedCoderRow[] {
  const rows: TimedCoderRow[] = []
  for (const codeId of codeIds) {
    const byCoder = new Map<number | null, TimedMark[]>()
    for (const mark of marksForCode(clips, codeId, include)) {
      const arr = byCoder.get(mark.userId)
      if (arr) arr.push(mark)
      else byCoder.set(mark.userId, [mark])
    }
    const coderIds = [...byCoder.keys()].sort(
      (a, b) => (a ?? Number.MAX_SAFE_INTEGER) - (b ?? Number.MAX_SAFE_INTEGER),
    )
    for (const userId of coderIds) {
      rows.push({ ...rowFromMarks(codeId, byCoder.get(userId)!, extent), userId })
    }
  }
  return rows
}

/**
 * The "Covered by selected coding" anchor: every visible mark for the selected
 * codes, pooled and unioned once — i.e. what share of the session the selected
 * coding touches AT ALL. It is deliberately NOT the sum of the per-code
 * airtimes (codes overlap), which is the disclosure the table carries.
 *
 * Lives here rather than in the component because the canvas EXPORT needs the
 * same number and mounts nothing (#652 slab 4). A second implementation of this
 * would disagree invisibly.
 */
export function coveredTotalSeconds(
  clips: readonly TimedClipLike[],
  codeIds: readonly number[],
  include: CoderInclude,
  extent: number | null,
): number | null {
  if (extent == null) return null
  const codeSet = new Set(codeIds)
  const intervals = clips.flatMap(clip =>
    clip.applied_code_details.some(d => codeSet.has(d.code_id) && detailVisible(d.user_id, include))
      ? [{ start: clip.start_time, end: clip.end_time }]
      : [])
  return coveredSeconds(unionIntervals(intervals), extent)
}

// ── Display formatting ──────────────────────────────────────────────────────
//
// Shared by the on-screen table and the canvas export's flattened table, so the
// two can never disagree by a rounding rule. A formatting divergence is the
// invisible kind: both outputs look right and only differ in the last digit.

/** Seconds → timecode; null → em dash. */
export const formatTimedSeconds = (s: number | null): string => (s == null ? '—' : formatTimecode(s))

/** Fraction → whole percent; null → em dash. */
export const formatTimedShare = (f: number | null): string => (f == null ? '—' : `${Math.round(f * 100)}%`)

/** Marks per minute, 2dp; null → em dash. */
export const formatTimedRate = (r: number | null): string => (r == null ? '—' : `${r.toFixed(2)}/min`)

// ── Codeline layout (DEC-6c-4) ──────────────────────────────────────────────

export interface CodelineMark extends TimedMark {
  /** Stacking row within the code's lane (assignTracks — overlaps stack). */
  track: number
}

export interface CodelineLane {
  codeId: number
  marks: CodelineMark[]
  /** ≥ 1 even when empty, so an empty lane still renders one flat row. */
  trackCount: number
}

export interface CodelineCategoryGroup {
  /** `cat-{id}` | 'uncategorized' — stable keys, mirroring buildLanes. */
  key: string
  /** null for the uncategorized group when it is the ONLY group (no header). */
  label: string | null
  lanes: CodelineLane[]
}

/**
 * One lane per SELECTED code (empty lanes kept — "never occurred" is a
 * finding), grouped under category headers in the caller's category order
 * (D6: categories are the de-facto channels). NOT `buildLanes` — that helper
 * is category-keyed and collapses a clip's codes to their categories (§8q
 * premise correction); tracks within a lane still come from `assignTracks`,
 * so same-coder and cross-coder overlaps stack identically.
 */
export function buildCodelineLanes(
  clips: readonly TimedClipLike[],
  codeIds: readonly number[],
  include: CoderInclude,
  orderedCategories: readonly { id: number; name: string }[],
  codeToCategoryId: ReadonlyMap<number, number | null>,
): CodelineCategoryGroup[] {
  const laneFor = (codeId: number): CodelineLane => {
    const marks = marksForCode(clips, codeId, include)
    const tracks = assignTracks(marks.map((m, i) => ({ id: i, start_time: m.start, end_time: m.end })))
    const withTracks = marks.map((m, i) => ({ ...m, track: tracks.get(i) ?? 0 }))
    const trackCount = Math.max(1, ...withTracks.map(m => m.track + 1))
    return { codeId, marks: withTracks, trackCount }
  }

  const byCategory = new Map<number | null, number[]>()
  for (const codeId of codeIds) {
    const catId = codeToCategoryId.get(codeId) ?? null
    const arr = byCategory.get(catId)
    if (arr) arr.push(codeId)
    else byCategory.set(catId, [codeId])
  }

  const groups: CodelineCategoryGroup[] = []
  for (const cat of orderedCategories) {
    const members = byCategory.get(cat.id)
    if (members && members.length > 0) {
      groups.push({ key: `cat-${cat.id}`, label: cat.name, lanes: members.map(laneFor) })
    }
  }
  const uncategorized = byCategory.get(null)
  if (uncategorized && uncategorized.length > 0) {
    groups.push({
      key: 'uncategorized',
      label: groups.length > 0 ? 'Uncategorized' : null,
      lanes: uncategorized.map(laneFor),
    })
  }
  return groups
}

// ── Extent (D34, verbatim) ──────────────────────────────────────────────────

export interface TimedExtent {
  /** max(duration ?? 0, farthest clip end); null when both absent. */
  extent: number | null
  /** false ⇒ the caller must LABEL the fallback ("of marked extent…"). */
  durationKnown: boolean
}

/**
 * The workbench `coverageExtent` chain minus the media-element fallback (a
 * qual-analysis surface has no mounted media element, so the server duration is
 * the only duration source) and, as everywhere, minus the 60 s ruler floor —
 * a display floor in a DENOMINATOR would silently deflate every rate.
 */
export function timedExtent(
  durationSeconds: number | null | undefined,
  clips: readonly { end_time: number }[],
): TimedExtent {
  const maxClipEnd = clips.length > 0 ? Math.max(...clips.map(c => c.end_time)) : 0
  const extent = Math.max(durationSeconds ?? 0, maxClipEnd)
  return { extent: extent > 0 ? extent : null, durationKnown: durationSeconds != null }
}
