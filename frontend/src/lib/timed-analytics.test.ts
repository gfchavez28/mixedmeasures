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
  coveredTotalSeconds,
  detailVisible,
  timedExtent,
  timedLayerFor,
  type CoderInclude,
  type TimedClipLike,
  type TimedLayer,
  type TimedLens,
} from './timed-analytics'

/** The Coders layer with no machine coder — every pre-#1077 case below. */
const lens = (
  include: CoderInclude,
  layer: TimedLayer = 'human',
  machines: number[] = [],
): TimedLens => ({ include, machineCoderIds: new Set(machines), layer })

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
    expect(detailVisible(1, lens(null))).toBe(true)
    expect(detailVisible(null, lens(null))).toBe(true)
  })
  it('an active include DROPS unattributed — the backend _coder_filter mirror', () => {
    const include = new Set([1])
    expect(detailVisible(1, lens(include))).toBe(true)
    expect(detailVisible(2, lens(include))).toBe(false)
    expect(detailVisible(null, lens(include))).toBe(false)
  })
})

describe('#1077 (b) — the lens knows the LAYER, like the backend charts beside it', () => {
  // The audit's measurement: a person covers 0–10 s, a model (coder 9) 20–60 s.
  // With an include set alone the Coders layer read 50 covered seconds; the
  // backend's human arm, which the Descriptives charts use, says 10.
  const MIXED: TimedClipLike[] = [clip(1, 0, 10, [[5, 1]]), clip(2, 20, 60, [[5, 9]])]

  it('the Coders layer leaves a machine\'s marks out; the Machine layer keeps only them', () => {
    expect(coveredTotalSeconds(MIXED, [5], lens(null, 'human', [9]), 100)).toBe(10)
    expect(coveredTotalSeconds(MIXED, [5], lens(null, 'machine', [9]), 100)).toBe(40)
    // Discrimination: with no machine known, the two coders are pooled — the
    // number the chart used to show on the Coders layer.
    expect(coveredTotalSeconds(MIXED, [5], lens(null, 'human', []), 100)).toBe(50)
  })

  it('an UNATTRIBUTED mark is a person\'s (the backend NULL arm), never a machine\'s', () => {
    expect(detailVisible(null, lens(null, 'human', [9]))).toBe(true)
    expect(detailVisible(null, lens(null, 'machine', [9]))).toBe(false)
  })

  it('the include set still narrows WITHIN the layer (blind → self)', () => {
    expect(detailVisible(9, lens(new Set([1]), 'machine', [9]))).toBe(false)
    expect(detailVisible(9, lens(new Set([9]), 'machine', [9]))).toBe(true)
    expect(detailVisible(1, lens(new Set([1]), 'machine', [9]))).toBe(false)
  })

  it('by-coder rows follow the layer too', () => {
    const human = computeTimedRowsByCoder(MIXED, [5], lens(null, 'human', [9]), 100)
    expect(human.map(r => r.userId)).toEqual([1])
    const machine = computeTimedRowsByCoder(MIXED, [5], lens(null, 'machine', [9]), 100)
    expect(machine.map(r => r.userId)).toEqual([9])
  })

  it('timedLayerFor: consensus has no timeline layer; the default is the Coders layer', () => {
    expect(timedLayerFor('consensus')).toBeNull()
    expect(timedLayerFor('machine')).toBe('machine')
    expect(timedLayerFor('human')).toBe('human')
    expect(timedLayerFor(undefined)).toBe('human')
  })
})

describe('computeTimedRows', () => {
  it('airtime is the per-code UNION, not the sum of mark durations', () => {
    const [row10] = computeTimedRows(CLIPS, [10], lens(null), 300)
    // marks: [0,30], [20,50], [60,90], [200,230] → union 0-50 + 60-90 + 200-230 = 110
    // (a sum of durations would say 120 — the overlap counted twice)
    expect(row10.airtimeSeconds).toBe(110)
    expect(row10.marks).toBe(4)
    expect(row10.airtimeFraction).toBeCloseTo(110 / 300)
  })

  it('point events count as marks and in the rate, but not as bouts or airtime', () => {
    const [row20] = computeTimedRows(CLIPS, [20], lens(null), 300)
    expect(row20.marks).toBe(2)
    expect(row20.pointMarks).toBe(1)
    expect(row20.airtimeSeconds).toBe(30)          // only the 60-90 state mark covers
    expect(row20.ratePerMinute).toBeCloseTo(2 / 5) // 2 marks over 5 minutes
    expect(row20.meanBoutSeconds).toBe(30)         // the point is not a bout
    expect(row20.medianBoutSeconds).toBe(30)
    expect(row20.maxBoutSeconds).toBe(30)
  })

  it('an active include filters marks — and drops the unattributed one', () => {
    const [row10] = computeTimedRows(CLIPS, [10], lens(new Set([1])), 300)
    expect(row10.marks).toBe(2)                    // clips 101 + 103 only
    expect(row10.airtimeSeconds).toBe(60)          // 0-30 + 60-90
  })

  it('a zero-mark selected code keeps its row — "never occurred" is a finding', () => {
    const [row99] = computeTimedRows(CLIPS, [99], lens(null), 300)
    expect(row99.marks).toBe(0)
    expect(row99.airtimeSeconds).toBe(0)
    expect(row99.meanBoutSeconds).toBeNull()
  })

  it('a null extent nulls the ratio fields rather than dividing by zero', () => {
    const [row10] = computeTimedRows(CLIPS, [10], lens(null), null)
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
    const [row] = computeTimedRows(clips, [5], lens(null), 200)
    expect(row.medianBoutSeconds).toBe(25) // bouts 10,20,30,40 → (20+30)/2
  })
})

describe('computeTimedRowsByCoder', () => {
  it('splits a code into per-coder rows with per-coder unions', () => {
    const rows = computeTimedRowsByCoder(CLIPS, [10], lens(null), 300)
    expect(rows.map(r => r.userId)).toEqual([1, 2, null]) // null (unattributed) last
    expect(rows[0].airtimeSeconds).toBe(60)  // coder 1: 0-30 + 60-90
    expect(rows[1].airtimeSeconds).toBe(30)  // coder 2: 20-50
    expect(rows[2].airtimeSeconds).toBe(30)  // unattributed: 200-230
  })

  it('fabricates no empty attribution rows', () => {
    const rows = computeTimedRowsByCoder(CLIPS, [20], lens(new Set([1])), 300)
    expect(rows).toHaveLength(1)
    expect(rows[0].userId).toBe(1)
  })
})

describe('buildCodelineLanes', () => {
  const CATS = [{ id: 7, name: 'Behavior' }]
  const CODE_TO_CAT = new Map<number, number | null>([[10, 7], [20, null]])

  it('one lane per CODE grouped by category — never the buildLanes category collapse', () => {
    const groups = buildCodelineLanes(CLIPS, [10, 20], lens(null), CATS, CODE_TO_CAT)
    expect(groups.map(g => g.key)).toEqual(['cat-7', 'uncategorized'])
    expect(groups[0].lanes.map(l => l.codeId)).toEqual([10])
    expect(groups[1].lanes.map(l => l.codeId)).toEqual([20])
    expect(groups[1].label).toBe('Uncategorized') // labelled because another group exists
  })

  it('overlapping marks stack onto distinct tracks; disjoint marks share one', () => {
    const [group] = buildCodelineLanes(CLIPS, [10], lens(null), [], new Map())
    const lane = group.lanes[0]
    const byStart = [...lane.marks].sort((a, b) => a.start - b.start)
    expect(byStart[0].track).not.toBe(byStart[1].track) // 0-30 vs 20-50 overlap
    expect(lane.trackCount).toBe(2)
  })

  it('an empty selected code keeps a one-track lane', () => {
    const [group] = buildCodelineLanes(CLIPS, [99], lens(null), [], new Map())
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
