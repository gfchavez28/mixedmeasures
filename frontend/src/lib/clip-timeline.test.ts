/**
 * The marking state machine + overlap stacking + boundary clamp (slab 3d).
 * Multi-digit times and sub-second boundaries per the fixture rule.
 */
import { describe, it, expect } from 'vitest'
import {
  deepLinkSeekTarget, armMark, assignTracks, buildLanes, clampBoundary, commitMark,
  coveredSeconds, dragReadout, gapsInExtent, laneCodeIds, nextGapStart, pointMark,
  unionIntervals,
} from './clip-timeline'

describe('the I/O/P marking machine', () => {
  it('I arms, re-pressing MOVES the in-point (never stacks)', () => {
    expect(armMark(83.4)).toBe(83.4)
    expect(armMark(-2)).toBe(0) // pre-roll arm clamps to 0
  })

  it('O commits [min, max] — a backward seek between I and O is forgiven', () => {
    expect(commitMark(120.5, 95.2)).toEqual({ start: 95.2, end: 120.5 })
    expect(commitMark(95.2, 120.5)).toEqual({ start: 95.2, end: 120.5 })
  })

  it('O with nothing armed is not a gesture', () => {
    expect(commitMark(null, 42)).toBeNull()
  })

  it('O at the armed position commits a point event (D7), never errors', () => {
    expect(commitMark(494.3, 494.3)).toEqual({ start: 494.3, end: 494.3 })
  })

  it('P is a point event at the playhead', () => {
    expect(pointMark(494.3)).toEqual({ start: 494.3, end: 494.3 })
  })
})

describe('assignTracks — same-lane overlap stacking', () => {
  const clip = (id: number, s: number, e: number) => ({ id, start_time: s, end_time: e })

  it('non-overlapping and ABUTTING clips share track 0', () => {
    const tracks = assignTracks([clip(1, 0, 130), clip(2, 130, 210), clip(3, 500, 610)])
    expect([...tracks.values()]).toEqual([0, 0, 0])
  })

  it('overlap stacks; a later clip reuses a freed track', () => {
    const tracks = assignTracks([
      clip(1, 0, 100),
      clip(2, 50, 150),   // overlaps 1 → track 1
      clip(3, 120, 200),  // 1 has ended → back on track 0
    ])
    expect(tracks.get(1)).toBe(0)
    expect(tracks.get(2)).toBe(1)
    expect(tracks.get(3)).toBe(0)
  })

  it('input order does not matter (sorted internally)', () => {
    const tracks = assignTracks([clip(2, 50, 150), clip(1, 0, 100)])
    expect(tracks.get(1)).toBe(0)
    expect(tracks.get(2)).toBe(1)
  })

  it('two point events at the same instant stack instead of occluding', () => {
    const tracks = assignTracks([clip(1, 494.3, 494.3), clip(2, 494.3, 494.3)])
    expect(new Set(tracks.values()).size).toBe(2)
  })
})

describe('clampBoundary — an edit can never cross the far edge', () => {
  const clip = { start_time: 100, end_time: 200 }

  it('clamps within [0, other edge]', () => {
    expect(clampBoundary('start', -5, clip)).toBe(0)
    expect(clampBoundary('start', 150, clip)).toBe(150)
    expect(clampBoundary('start', 250, clip)).toBe(200)  // stops AT the end, no swap
    expect(clampBoundary('end', 50, clip)).toBe(100)     // stops AT the start
    expect(clampBoundary('end', 1000, clip)).toBe(1000)  // no upper clamp — overhang is legal
  })
})

describe('dragReadout — what the live drag label says (#655)', () => {
  it('a boundary drag reads its value (the pre-#655 behavior, unchanged)', () => {
    expect(dragReadout({ kind: 'boundary', clipId: 1, edge: 'end', value: 494.3 }))
      .toEqual({ at: 494.3, text: '8:14.3' })
  })

  // The bug: only boundary drags had a readout, so marking a NEW clip showed
  // no start, no end and no duration.
  it('a create drag reads start–end · duration', () => {
    expect(dragReadout({ kind: 'create', anchor: 130, current: 494.3, moved: true }))
      .toEqual({ at: 494.3, text: '2:10.0–8:14.3 · 6:04.3' })
  })

  it('a BACKWARD create drag reports the range, not the gesture order', () => {
    const back = dragReadout({ kind: 'create', anchor: 494.3, current: 130, moved: true })
    expect(back!.text).toBe('2:10.0–8:14.3 · 6:04.3')
    // ...but the label still tracks the pointer, which is at the LEFT edge here.
    expect(back!.at).toBe(130)
  })

  it('stays silent below the movement threshold — that gesture is still a seek', () => {
    expect(dragReadout({ kind: 'create', anchor: 130, current: 130.02, moved: false })).toBeNull()
    expect(dragReadout(null)).toBeNull()
  })
})

describe('buildLanes — category lanes through the blind lens (D28/D13)', () => {
  const c = (id: number) => ({ id })
  const CATS = [{ id: 10, name: 'Behavior' }, { id: 20, name: 'Context' }]
  // code 1 → Behavior · code 2 → Context · code 3 → no category
  const CODE_CATS = new Map<number, number | null>([[1, 10], [2, 20], [3, null]])

  it('a two-category clip appears in BOTH lanes; same-category codes dedupe to one instance', () => {
    const visible = new Map<number, number[]>([[7, [1, 2]], [8, [1, 1]]])
    const lanes = buildLanes([c(7), c(8)], clip => visible.get(clip.id) ?? [], CATS, CODE_CATS)
    expect(lanes.map(l => l.key)).toEqual(['cat-10', 'cat-20', 'uncoded'])
    expect(lanes[0].clips.map(x => x.id)).toEqual([7, 8]) // Behavior: both
    expect(lanes[1].clips.map(x => x.id)).toEqual([7])    // Context: only the two-category clip
  })

  it('uncoded clips land on the Uncoded lane, which ALWAYS exists (the create surface)', () => {
    const lanes = buildLanes([c(7)], () => [], CATS, CODE_CATS)
    expect(lanes).toEqual([{ key: 'uncoded', label: 'Uncoded', clips: [c(7)] }])
    // Even with every clip coded, Uncoded stays (empty) — drag-create needs a home.
    const coded = buildLanes([c(7)], () => [1], CATS, CODE_CATS)
    expect(coded.map(l => l.key)).toEqual(['cat-10', 'uncoded'])
    expect(coded[coded.length - 1].clips).toEqual([])
  })

  it('membership uses the caller-supplied VISIBLE-code lens — a blind-hidden colleague code cannot leak lane placement', () => {
    // The clip carries a colleague's code, but the blind lens returns [] —
    // the clip must read UNCODED, exactly like the chips.
    const lanes = buildLanes([c(7)], () => [], CATS, CODE_CATS)
    expect(lanes.find(l => l.key === 'uncoded')?.clips.map(x => x.id)).toEqual([7])
    expect(lanes.some(l => l.key === 'cat-10')).toBe(false)
  })

  it('category order follows the given list; uncategorized codes get their own lane before Uncoded', () => {
    const visible = new Map<number, number[]>([[7, [2]], [8, [3]], [9, [1]]])
    const lanes = buildLanes([c(7), c(8), c(9)], clip => visible.get(clip.id) ?? [], CATS, CODE_CATS)
    expect(lanes.map(l => l.label)).toEqual(['Behavior', 'Context', 'Uncategorized', 'Uncoded'])
  })
})

describe('laneCodeIds — which codes justify a bar\'s colour (#656)', () => {
  // 7 → Behavior(10), 8 → Behavior(10), 9 → Context(20), 5 → no category.
  const CAT = new Map<number, number | null>([[7, 10], [8, 10], [9, 20], [5, null]])

  it('returns only the codes belonging to THIS lane', () => {
    expect(laneCodeIds([7, 9], 'cat-10', CAT)).toEqual([7])
    expect(laneCodeIds([7, 9], 'cat-20', CAT)).toEqual([9])
  })

  it('keeps the caller\'s order, so a multi-code clip always takes the same colour', () => {
    expect(laneCodeIds([8, 7], 'cat-10', CAT)).toEqual([8, 7])
    expect(laneCodeIds([7, 8], 'cat-10', CAT)).toEqual([7, 8])
  })

  it('routes category-less codes to Uncategorized, never to a category lane', () => {
    expect(laneCodeIds([5, 7], 'uncategorized', CAT)).toEqual([5])
    expect(laneCodeIds([5], 'cat-10', CAT)).toEqual([])
  })

  // The Uncoded lane is the drag-create surface and holds clips BY DEFINITION
  // uncoded through the lens; a colour there would be a contradiction.
  it('never colours the Uncoded lane, even if codes are somehow passed', () => {
    expect(laneCodeIds([7, 8, 9], 'uncoded', CAT)).toEqual([])
  })

  // An unknown code id (archived out of the codes list, say) has no category,
  // so it must NOT fall through into every category lane.
  it('treats an unknown code as uncategorized rather than universal', () => {
    expect(laneCodeIds([99], 'cat-10', CAT)).toEqual([])
    expect(laneCodeIds([99], 'uncategorized', CAT)).toEqual([99])
  })
})

describe('deepLinkSeekTarget', () => {
  const clip = { start_time: 760, end_time: 902.4 }

  it('honors a t inside the clip', () => {
    expect(deepLinkSeekTarget(clip, '800')).toBe(800)
  })

  it('CLAMPS a t past the clip end', () => {
    // A stale link, a hand-edited URL, or a quote stranded by a boundary edit.
    // clampMediaSeek bounds the RECORDING, so it cannot do this containment.
    expect(deepLinkSeekTarget(clip, '5000')).toBe(902.4)
  })

  it('clamps a t before the clip start', () => {
    expect(deepLinkSeekTarget(clip, '0')).toBe(760)
  })

  it('falls back to the clip start when t is absent or unparseable', () => {
    expect(deepLinkSeekTarget(clip, null)).toBe(760)
    expect(deepLinkSeekTarget(clip, 'abc')).toBe(760)
  })

  it('accepts a t of exactly zero on a clip that starts at zero', () => {
    // The falsy-zero trap: `Number(t) || start` would discard a legitimate 0.
    expect(deepLinkSeekTarget({ start_time: 0, end_time: 130 }, '0')).toBe(0)
  })
})

// ── Coverage intervals (6a) ─────────────────────────────────────────────────
//
// ⚠️ SHARED FIXTURE TABLE — the backend mirrors these EXACT cases in
// `backend/tests/test_observation_coverage.py::COVERAGE_CASES`. The frontend
// (workbench gauge, blind-scoped) and the backend (list %, all-coder) are a
// deliberate two-language mirror of one definition, so the cases are pinned in
// both suites and must be edited together — the
// `order_value_labels`/`compareValueLabels` precedent.
//
// Values are ≥10s throughout: the #406 rule (a 1–5-shaped fixture hid a
// lexicographic bug for the project's entire life).
const COVERAGE_CASES: {
  name: string
  intervals: { start: number; end: number }[]
  extent: number
  union: { start: number; end: number }[]
  covered: number
  gaps: { start: number; end: number }[]
}[] = [
  {
    name: 'disjoint ranges stay separate',
    intervals: [{ start: 10, end: 20 }, { start: 40, end: 55 }],
    extent: 100,
    union: [{ start: 10, end: 20 }, { start: 40, end: 55 }],
    covered: 25,
    gaps: [{ start: 0, end: 10 }, { start: 20, end: 40 }, { start: 55, end: 100 }],
  },
  {
    name: 'overlapping ranges merge and do NOT double-count',
    intervals: [{ start: 10, end: 30 }, { start: 25, end: 45 }],
    extent: 100,
    union: [{ start: 10, end: 45 }],
    covered: 35,
    gaps: [{ start: 0, end: 10 }, { start: 45, end: 100 }],
  },
  {
    name: 'a contained range adds nothing',
    intervals: [{ start: 10, end: 90 }, { start: 30, end: 40 }],
    extent: 100,
    union: [{ start: 10, end: 90 }],
    covered: 80,
    gaps: [{ start: 0, end: 10 }, { start: 90, end: 100 }],
  },
  {
    name: 'abutting ranges merge — the boundary is one cut, not a gap',
    intervals: [{ start: 10, end: 25 }, { start: 25, end: 40 }],
    extent: 100,
    union: [{ start: 10, end: 40 }],
    covered: 30,
    gaps: [{ start: 0, end: 10 }, { start: 40, end: 100 }],
  },
  {
    name: 'point events are dropped — they mark, they do not cover (D7)',
    intervals: [{ start: 15, end: 15 }, { start: 30, end: 45 }],
    extent: 100,
    union: [{ start: 30, end: 45 }],
    covered: 15,
    gaps: [{ start: 0, end: 30 }, { start: 45, end: 100 }],
  },
  {
    name: 'a clip overhanging the extent is clamped by the CONSUMERS, not the union',
    intervals: [{ start: 80, end: 140 }],
    extent: 100,
    union: [{ start: 80, end: 140 }],
    covered: 20,
    gaps: [{ start: 0, end: 80 }],
  },
  {
    name: 'nothing coded — the whole extent is one gap',
    intervals: [],
    extent: 100,
    union: [],
    covered: 0,
    gaps: [{ start: 0, end: 100 }],
  },
  {
    name: 'fully covered — no gaps',
    intervals: [{ start: 0, end: 100 }],
    extent: 100,
    union: [{ start: 0, end: 100 }],
    covered: 100,
    gaps: [],
  },
  {
    name: 'input order does not matter',
    intervals: [{ start: 60, end: 75 }, { start: 10, end: 20 }],
    extent: 100,
    union: [{ start: 10, end: 20 }, { start: 60, end: 75 }],
    covered: 25,
    gaps: [{ start: 0, end: 10 }, { start: 20, end: 60 }, { start: 75, end: 100 }],
  },
  {
    name: 'zero extent (no duration, no clips) covers nothing and offers no gap',
    intervals: [{ start: 10, end: 20 }],
    extent: 0,
    union: [{ start: 10, end: 20 }],
    covered: 0,
    gaps: [],
  },
]

describe('coverage intervals (the shared fixture table)', () => {
  it.each(COVERAGE_CASES)('$name', ({ intervals, extent, union, covered, gaps }) => {
    const u = unionIntervals(intervals)
    expect(u).toEqual(union)
    expect(coveredSeconds(u, extent)).toBeCloseTo(covered, 6)
    expect(gapsInExtent(u, extent)).toEqual(gaps)
  })

  it('does not mutate its input', () => {
    const input = [{ start: 40, end: 55 }, { start: 10, end: 20 }]
    unionIntervals(input)
    expect(input).toEqual([{ start: 40, end: 55 }, { start: 10, end: 20 }])
  })
})

describe('nextGapStart (the `u` destination — D35)', () => {
  const gaps = [{ start: 0, end: 10 }, { start: 20, end: 40 }, { start: 75, end: 100 }]

  it('finds the next gap STRICTLY after the playhead', () => {
    expect(nextGapStart(gaps, 5)).toBe(20)
    expect(nextGapStart(gaps, 45)).toBe(75)
  })

  it('skips the gap the playhead is standing in (the conversation `j` rule)', () => {
    // Inside [20, 40): you are already at work to do, so "next" is the one after.
    expect(nextGapStart(gaps, 30)).toBe(75)
  })

  it('a gap starting exactly at the playhead is not "after" it', () => {
    expect(nextGapStart(gaps, 20)).toBe(75)
  })

  it('wraps to the first gap when none is ahead', () => {
    expect(nextGapStart(gaps, 90)).toBe(0)
  })

  it('with ONE gap, wrapping still moves the playhead to the top of the work', () => {
    expect(nextGapStart([{ start: 30, end: 90 }], 50)).toBe(30)
  })

  it('returns null when the timeline is fully covered', () => {
    expect(nextGapStart([], 12)).toBeNull()
  })

  it('honours wrap:false', () => {
    expect(nextGapStart(gaps, 90, { wrap: false })).toBeNull()
  })
})
