import { describe, it, expect } from 'vitest'
import { describeScaleCrossing, scaleRange, scalesDiffer } from './magnitude'
import {
  anchorLabelFor,
  anchorLayout,
  describeMagnitude,
  formatMagnitude,
  isScalePoint,
  isTickable,
  isUnrated,
  normalizedPosition,
  scaleSignature,
  stepsReachMax,
  tickValues,
  MAX_TICKS,
  type MagnitudeScale,
} from './magnitude'

/**
 * 🔴 The fixtures are BIPOLAR on purpose (−1…+1), not 0–10.
 *
 * The rule this module exists to keep is that UNRATED and a rating of ZERO are
 * different facts. On a 0–10 scale zero is the floor, so a falsy-zero slip and a
 * correct implementation agree about nearly everything and the tests certify
 * nothing. On −1…+1 zero is INTERIOR and meaningful, which is the axis where the
 * two implementations produce different answers.
 */
const BIPOLAR: MagnitudeScale = {
  min: -1,
  max: 1,
  step: 0.5,
  anchors: [
    { value: -1, label: 'strongly negative' },
    { value: 0, label: 'neither' },
    { value: 1, label: 'strongly positive' },
  ],
}

const ZERO_BASED: MagnitudeScale = { min: 0, max: 10, step: 1, anchors: [] }

describe('isUnrated', () => {
  it('treats null and undefined as unrated', () => {
    expect(isUnrated(null)).toBe(true)
    expect(isUnrated(undefined)).toBe(true)
  })

  it('🔴 does NOT treat zero as unrated', () => {
    // The single most important assertion in this file. A `!value` check passes
    // every other test here and fails this one.
    expect(isUnrated(0)).toBe(false)
  })

  it('treats a negative rating as rated', () => {
    expect(isUnrated(-1)).toBe(false)
  })
})

describe('formatMagnitude', () => {
  it('renders whole numbers without a decimal tail', () => {
    expect(formatMagnitude(10)).toBe('10')
    expect(formatMagnitude(0)).toBe('0')
  })

  it('uses a Unicode minus, not a hyphen', () => {
    // At 10px in a proportional font a hyphen reads as a dash, which on a
    // bipolar scale is the difference between −1 and 1.
    expect(formatMagnitude(-0.5)).toBe('−0.5')
    expect(formatMagnitude(-0.5)).not.toContain('-')
  })
})

describe('normalizedPosition', () => {
  it('maps a value to its position within its OWN range', () => {
    expect(normalizedPosition(-1, BIPOLAR)).toBe(0)
    expect(normalizedPosition(0, BIPOLAR)).toBe(0.5)
    expect(normalizedPosition(1, BIPOLAR)).toBe(1)
  })

  it('makes different scales comparable — the reason it exists', () => {
    // 8/10 and 0.6 on −1…+1 are both "high"; the raw numbers are not comparable
    // and the normalized positions are.
    expect(normalizedPosition(8, ZERO_BASED)).toBeCloseTo(0.8)
    expect(normalizedPosition(0.6, BIPOLAR)).toBeCloseTo(0.8)
  })

  it('returns 0 rather than NaN for a degenerate scale', () => {
    // The server refuses min >= max, so this is only reachable from a stale
    // payload — but NaN in a `width` renders as a FULL bar, which is the most
    // confident possible display of a value we could not compute.
    const bad: MagnitudeScale = { min: 5, max: 5, step: 1, anchors: [] }
    expect(normalizedPosition(5, bad)).toBe(0)
    expect(Number.isNaN(normalizedPosition(5, bad))).toBe(false)
  })

  it('clamps a value left outside its range by a later scale edit', () => {
    expect(normalizedPosition(99, ZERO_BASED)).toBe(1)
    expect(normalizedPosition(-99, ZERO_BASED)).toBe(0)
  })
})

describe('describeMagnitude', () => {
  it('says "not rated" and never says zero', () => {
    expect(describeMagnitude(null, BIPOLAR)).toBe('not rated')
    expect(describeMagnitude(undefined, BIPOLAR)).toBe('not rated')
  })

  it('reads a zero-based scale as "out of"', () => {
    expect(describeMagnitude(8, ZERO_BASED)).toBe('8 out of 10')
  })

  it('names BOTH bounds when the scale does not start at zero', () => {
    // "−0.5 out of 1" invites the reader to assume a floor of zero, which is
    // exactly wrong on a bipolar scale.
    expect(describeMagnitude(-0.5, BIPOLAR)).toBe(
      '−0.5 on a scale from −1 to 1',
    )
  })

  it('appends an anchor label when the value has one', () => {
    expect(describeMagnitude(0, BIPOLAR)).toContain('neither')
  })

  it('🔴 describes a zero rating as a rating, not as unrated', () => {
    expect(describeMagnitude(0, BIPOLAR)).not.toBe('not rated')
  })
})

describe('tickValues / isTickable', () => {
  it('produces one tick per step, inclusive of both ends', () => {
    expect(tickValues(BIPOLAR)).toEqual([-1, -0.5, 0, 0.5, 1])
  })

  it('does not accumulate floating-point drift', () => {
    // `v += 0.1` thirty times lands at 3.0000000000000004, which is outside the
    // range the server validates against — so the tick would be refused on save.
    const fine: MagnitudeScale = { min: 0, max: 3, step: 0.1, anchors: [] }
    const ticks = tickValues(fine)
    expect(ticks.length).toBeLessThanOrEqual(MAX_TICKS)
    // 0..3 by 0.1 is 31 ticks, over the cap — so it is not tickable at all.
    expect(ticks).toEqual([])
  })

  it('refuses to tick a scale finer than a person can hit', () => {
    // 0–100 by 1 is 101 targets. Unusable at 640×360, so the control renders a
    // number input instead — an empty tick list is the signal for that branch.
    const fine: MagnitudeScale = { min: 0, max: 100, step: 1, anchors: [] }
    expect(isTickable(fine)).toBe(false)
    expect(tickValues(fine)).toEqual([])
  })

  it('ticks a scale exactly at the cap', () => {
    const atCap: MagnitudeScale = { min: 0, max: MAX_TICKS - 1, step: 1, anchors: [] }
    expect(isTickable(atCap)).toBe(true)
    expect(tickValues(atCap)).toHaveLength(MAX_TICKS)
  })
})

describe('anchorLabelFor', () => {
  it('finds a label at an exact value and returns null otherwise', () => {
    expect(anchorLabelFor(0, BIPOLAR)).toBe('neither')
    expect(anchorLabelFor(0.5, BIPOLAR)).toBeNull()
  })
})

// ── #869 — ratings crossing scales (a merge, a collapse) ──────────────────────

describe('scalesDiffer / describeScaleCrossing (#869 b/c)', () => {
  const ten = { min: 0, max: 10, step: 1, anchors: [] }
  const tenCoarse = { min: 0, max: 10, step: 2, anchors: [{ value: 10, label: 'lots' }] }
  const bipolar = { min: -1, max: 1, step: 0.5, anchors: [] }

  it('formats a range with an en dash and a Unicode minus', () => {
    expect(scaleRange(ten)).toBe('0–10')
    expect(scaleRange(bipolar)).toBe('−1–1')
  })

  it('a difference is about the RANGE, never step or anchors', () => {
    expect(scalesDiffer(ten, tenCoarse)).toBe(false)
    expect(scalesDiffer(ten, bipolar)).toBe(true)
    expect(scalesDiffer(null, null)).toBe(false)
    expect(scalesDiffer(ten, null)).toBe(true)
    expect(scalesDiffer(undefined, bipolar)).toBe(true)
  })

  it('says nothing when the scales agree', () => {
    expect(describeScaleCrossing({ name: 'A', scale: ten }, { name: 'B', scale: tenCoarse })).toBeNull()
    expect(describeScaleCrossing({ name: 'A', scale: null }, { name: 'B', scale: null })).toBeNull()
  })

  it('names both ranges when they differ, and what happens to ratings outside the target', () => {
    const note = describeScaleCrossing({ name: 'Joy', scale: ten }, { name: 'Mood', scale: bipolar })!
    expect(note).toContain('“Joy” is rated 0–10')
    expect(note).toContain('“Mood” −1–1')
    expect(note).toContain('outside it are not moved as ratings')
  })

  it('says a scale-less target keeps ratings it cannot show', () => {
    const note = describeScaleCrossing({ name: 'Joy', scale: ten }, { name: 'Mood', scale: null })!
    expect(note).toContain('“Mood” has none')
    expect(note).toContain('cannot be shown until “Mood” declares a scale')
  })

  it('says nothing crosses when only the target is scaled', () => {
    const note = describeScaleCrossing({ name: 'Joy', scale: null }, { name: 'Mood', scale: bipolar })!
    expect(note).toContain('nothing on “Joy” is rated')
  })
})

describe('#1114 — the ticks never pass the maximum', () => {
  const s = (min: number, max: number, step: number) => ({ min, max, step, anchors: [] })

  it('a step that does not divide the range stops at the last whole step', () => {
    expect(tickValues(s(0, 10, 4))).toEqual([0, 4, 8])           // rounding put 12 here
    expect(tickValues(s(-1, 1, 0.75))).toEqual([-1, -0.25, 0.5]) // and 1.25 here
    expect(tickValues(s(0, 10, 6))).toEqual([0, 6])
  })

  it('a fractional step that DOES divide keeps its last tick (the floor must not eat it)', () => {
    // 0.3 / 0.1 is 2.9999999999999996 in binary floating point — measured. A bare
    // floor makes that 2 and drops 0.3. (0–1 by 0.1 cannot show it: 1 / 0.1 is
    // exactly 10, which is how the first version of this test passed a mutant.)
    expect(tickValues(s(0, 0.3, 0.1))).toEqual([0, 0.1, 0.2, 0.3])
    expect(tickValues(s(0, 0.6, 0.2))).toEqual([0, 0.2, 0.4, 0.6])
    expect(stepsReachMax(s(0, 0.7, 0.1))).toBe(true)
    const t = tickValues(s(0, 1, 0.1))
    expect(t).toHaveLength(11)
    expect(t[t.length - 1]).toBe(1)
    // 31 points is past MAX_TICKS, so the strip shows a number input instead.
    expect(tickValues(s(0, 3, 0.1))).toHaveLength(0)
  })

  it('the tickable count is the same floored count', () => {
    // 0–20 by 1 is 21 ticks (tickable); 0–20.5 by 1 is still 21 whole steps.
    expect(isTickable(s(0, 20, 1))).toBe(true)
    expect(isTickable(s(0, 20.5, 1))).toBe(true)
    expect(isTickable(s(0, 21, 1))).toBe(false)
  })

  it('stepsReachMax and isScalePoint read the same arithmetic', () => {
    expect(stepsReachMax(s(0, 10, 4))).toBe(false)
    expect(stepsReachMax(s(0, 10, 5))).toBe(true)
    expect(stepsReachMax(s(0, 1, 0.1))).toBe(true)
    expect(isScalePoint(8, s(0, 10, 4))).toBe(true)
    expect(isScalePoint(10, s(0, 10, 4))).toBe(false)
    expect(isScalePoint(0.3, s(0, 1, 0.1))).toBe(true)
    expect(isScalePoint(0.35, s(0, 1, 0.1))).toBe(false)
    expect(isScalePoint(-0.5, s(-1, 1, 0.5))).toBe(true)
    expect(isScalePoint(11, s(0, 10, 1))).toBe(false)   // outside the range
  })

  it('the signature changes with the range or the step, never with the anchors', () => {
    const a = { min: 0, max: 10, step: 1, anchors: [{ value: 0, label: 'none' }] }
    const unlabelled = { ...a, anchors: [] }
    expect(scaleSignature(a)).toBe(scaleSignature(unlabelled))
    expect(scaleSignature(a)).not.toBe(scaleSignature({ ...a, step: 2 }))
    expect(scaleSignature(a)).not.toBe(scaleSignature({ ...a, max: 5 }))
  })
})

describe('#1113 — every anchor is placed on the one anchor line', () => {
  const scale = (anchors: [number, string][], min = -1, max = 1, step = 1) =>
    ({ min, max, step, anchors: anchors.map(([value, label]) => ({ value, label })) })
  const overlaps = (p: { left: number; width: number }[]) =>
    p.some((a, i) => i > 0 && a.left < p[i - 1].left + p[i - 1].width - 1e-9)

  it('three anchors: the ends hug the edges and the middle one is centred on its tick', () => {
    const p = anchorLayout(scale([[1, 'for'], [-1, 'against'], [0, 'neutral']]), 3)
    expect(p.map(a => a.text)).toEqual(['−1 · against', '0 · neutral', '1 · for'])   // sorted
    expect(p.map(a => a.align)).toEqual(['left', 'center', 'right'])
    expect(p[0].left).toBe(0)
    expect(p[2].left + p[2].width).toBeCloseTo(100)
    // The middle tick's centre is the strip's centre on three equal ticks.
    expect(p[1].left + p[1].width / 2).toBeCloseTo(50)
    expect(overlaps(p)).toBe(false)
  })

  it('the two-end scale reads as it always did — each label owns its half', () => {
    const p = anchorLayout(scale([[-1, 'against'], [1, 'for']]), 3)
    expect(p).toMatchObject([
      { align: 'left', left: 0, width: 50 },
      { align: 'right', left: 50, width: 50 },
    ])
  })

  it('a lone interior anchor is centred on ITS tick, not on the strip', () => {
    const p = anchorLayout(scale([[2, 'little']], 0, 10, 1), 11)
    const centre = p[0].left + p[0].width / 2
    expect(centre).toBeCloseTo(((2 + 0.5) / 11) * 100)
    expect(p[0].left).toBeGreaterThanOrEqual(0)
  })

  it('no two boxes overlap, however the anchors crowd', () => {
    for (const anchors of [
      [[0, 'a'], [1, 'b'], [2, 'c'], [3, 'd']],
      [[0, 'a'], [9, 'b'], [10, 'c']],
      [[4, 'x'], [5, 'y']],
    ] as [number, string][][]) {
      expect(overlaps(anchorLayout(scale(anchors, 0, 10, 1), 11))).toBe(false)
    }
  })

  it('with no ticks (the number-input arm) anchors sit proportionally along the range', () => {
    const p = anchorLayout(scale([[0, 'none'], [50, 'half'], [100, 'all']], 0, 100, 1), 0)
    expect(p[1].left + p[1].width / 2).toBeCloseTo(50)
    expect(p.map(a => a.align)).toEqual(['left', 'center', 'right'])
  })

  it('an anchor between points is placed where its value falls', () => {
    const p = anchorLayout(scale([[0, 'none'], [5, 'mid'], [10, 'all']], 0, 10, 2), 6)
    // 5 is 2.5 steps from 0 on six ticks: centred at (2.5 + 0.5) / 6.
    expect(p[1].left + p[1].width / 2).toBeCloseTo((3 / 6) * 100)
  })
})
