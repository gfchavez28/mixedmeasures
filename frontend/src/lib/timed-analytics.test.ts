/**
 * Slab 6c compute pins. The load-bearing behaviors:
 * - airtime is a per-code UNION (overlapping marks count once), never a sum of
 *   mark durations — the number the whole surface exists to get right;
 * - the coder lens is INCLUDE-list semantics mirroring the backend
 *   `_coder_filter` (an active include DROPS unattributed marks), so the
 *   timeline agrees with the neighboring backend-computed charts;
 * - point events count as marks (and in the rate) but have no duration:
 *   excluded from bout stats, zero airtime (D7);
 * - the codeline is code-keyed lanes grouped by category (NOT buildLanes'
 *   category-keyed collapse), with assignTracks stacking overlaps;
 * - the extent is the D34 law with a null-not-zero degenerate.
 */
import { describe, it, expect } from 'vitest'
import {
  buildCodelineLanes,
  computeTimedRows,
  computeTimedRowsByCoder,
  detailVisible,
  timedExtent,
  type TimedClipLike,
} from './timed-analytics'

const clip = (
  id: number,
  start: number,
  end: number,
  details: Array<[number, number | null]>,
): TimedClipLike => ({
  id,
  start_time: start,
  end_time: end,
  applied_code_details: details.map(([code_id, user_id]) => ({ code_id, user_id })),
})

// Two coders (1, 2) + one unattributed application; code 10 overlaps itself
// across coders, code 20 has a point event.
const CLIPS: TimedClipLike[] = [
  clip(101, 0, 30, [[10, 1]]),
  clip(102, 20, 50, [[10, 2]]),     // overlaps 101 by 10s — union must count once
  clip(103, 60, 90, [[10, 1], [20, 1]]),
  clip(104, 100, 100, [[20, 2]]),   // point event
  clip(105, 200, 230, [[10, null]]), // unattributed
]

describe('detailVisible (include-list semantics)', () => {
  it('null include admits everyone, unattributed included', () => {
    expect(detailVisible(1, null)).toBe(true)
    expect(detailVisible(null, null)).toBe(true)
  })
  it('an active include DROPS unattributed — the backend _coder_filter mirror', () => {
    const include = new Set([1])
    expect(detailVisible(1, include)).toBe(true)
    expect(detailVisible(2, include)).toBe(false)
    expect(detailVisible(null, include)).toBe(false)
  })
})

describe('computeTimedRows', () => {
  it('airtime is the per-code UNION, not the sum of mark durations', () => {
    const [row10] = computeTimedRows(CLIPS, [10], null, 300)
    // marks: [0,30], [20,50], [60,90], [200,230] → union 0-50 + 60-90 + 200-230 = 110
    // (a sum of durations would say 120 — the overlap counted twice)
    expect(row10.airtimeSeconds).toBe(110)
    expect(row10.marks).toBe(4)
    expect(row10.airtimeFraction).toBeCloseTo(110 / 300)
  })

  it('point events count as marks and in the rate, but not as bouts or airtime', () => {
    const [row20] = computeTimedRows(CLIPS, [20], null, 300)
    expect(row20.marks).toBe(2)
    expect(row20.pointMarks).toBe(1)
    expect(row20.airtimeSeconds).toBe(30)          // only the 60-90 state mark covers
    expect(row20.ratePerMinute).toBeCloseTo(2 / 5) // 2 marks over 5 minutes
    expect(row20.meanBoutSeconds).toBe(30)         // the point is not a bout
    expect(row20.medianBoutSeconds).toBe(30)
    expect(row20.maxBoutSeconds).toBe(30)
  })

  it('an active include filters marks — and drops the unattributed one', () => {
    const [row10] = computeTimedRows(CLIPS, [10], new Set([1]), 300)
    expect(row10.marks).toBe(2)                    // clips 101 + 103 only
    expect(row10.airtimeSeconds).toBe(60)          // 0-30 + 60-90
  })

  it('a zero-mark selected code keeps its row — "never occurred" is a finding', () => {
    const [row99] = computeTimedRows(CLIPS, [99], null, 300)
    expect(row99.marks).toBe(0)
    expect(row99.airtimeSeconds).toBe(0)
    expect(row99.meanBoutSeconds).toBeNull()
  })

  it('a null extent nulls the ratio fields rather than dividing by zero', () => {
    const [row10] = computeTimedRows(CLIPS, [10], null, null)
    expect(row10.airtimeFraction).toBeNull()
    expect(row10.ratePerMinute).toBeNull()
    expect(row10.marks).toBe(4)
  })

  it('median is the midpoint of an even bout count', () => {
    const clips = [
      clip(1, 0, 10, [[5, 1]]),
      clip(2, 20, 50, [[5, 1]]),
      clip(3, 60, 80, [[5, 1]]),
      clip(4, 90, 130, [[5, 1]]),
    ]
    const [row] = computeTimedRows(clips, [5], null, 200)
    expect(row.medianBoutSeconds).toBe(25) // bouts 10,20,30,40 → (20+30)/2
  })
})

describe('computeTimedRowsByCoder', () => {
  it('splits a code into per-coder rows with per-coder unions', () => {
    const rows = computeTimedRowsByCoder(CLIPS, [10], null, 300)
    expect(rows.map(r => r.userId)).toEqual([1, 2, null]) // null (unattributed) last
    expect(rows[0].airtimeSeconds).toBe(60)  // coder 1: 0-30 + 60-90
    expect(rows[1].airtimeSeconds).toBe(30)  // coder 2: 20-50
    expect(rows[2].airtimeSeconds).toBe(30)  // unattributed: 200-230
  })

  it('fabricates no empty attribution rows', () => {
    const rows = computeTimedRowsByCoder(CLIPS, [20], new Set([1]), 300)
    expect(rows).toHaveLength(1)
    expect(rows[0].userId).toBe(1)
  })
})

describe('buildCodelineLanes', () => {
  const CATS = [{ id: 7, name: 'Behavior' }]
  const CODE_TO_CAT = new Map<number, number | null>([[10, 7], [20, null]])

  it('one lane per CODE grouped by category — never the buildLanes category collapse', () => {
    const groups = buildCodelineLanes(CLIPS, [10, 20], null, CATS, CODE_TO_CAT)
    expect(groups.map(g => g.key)).toEqual(['cat-7', 'uncategorized'])
    expect(groups[0].lanes.map(l => l.codeId)).toEqual([10])
    expect(groups[1].lanes.map(l => l.codeId)).toEqual([20])
    expect(groups[1].label).toBe('Uncategorized') // labelled because another group exists
  })

  it('overlapping marks stack onto distinct tracks; disjoint marks share one', () => {
    const [group] = buildCodelineLanes(CLIPS, [10], null, [], new Map())
    const lane = group.lanes[0]
    const byStart = [...lane.marks].sort((a, b) => a.start - b.start)
    expect(byStart[0].track).not.toBe(byStart[1].track) // 0-30 vs 20-50 overlap
    expect(lane.trackCount).toBe(2)
  })

  it('an empty selected code keeps a one-track lane', () => {
    const [group] = buildCodelineLanes(CLIPS, [99], null, [], new Map())
    expect(group.lanes[0].marks).toEqual([])
    expect(group.lanes[0].trackCount).toBe(1)
    expect(group.label).toBeNull() // sole group → headerless
  })
})

describe('timedExtent (D34)', () => {
  it('takes the larger of duration and farthest clip end', () => {
    expect(timedExtent(200, [{ end_time: 60 }])).toEqual({ extent: 200, durationKnown: true })
    expect(timedExtent(30, [{ end_time: 60 }])).toEqual({ extent: 60, durationKnown: true })
  })
  it('falls back to marked extent, flagged for labelling', () => {
    expect(timedExtent(null, [{ end_time: 60 }])).toEqual({ extent: 60, durationKnown: false })
  })
  it('degenerates to null, never zero', () => {
    expect(timedExtent(null, [])).toEqual({ extent: null, durationKnown: false })
  })
})
