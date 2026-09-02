import { describe, it, expect } from 'vitest'
import {
  anchorLabelFor,
  describeMagnitude,
  formatMagnitude,
  isTickable,
  isUnrated,
  normalizedPosition,
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
