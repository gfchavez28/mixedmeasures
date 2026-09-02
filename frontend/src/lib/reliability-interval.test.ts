/**
 * Reading a reliability interval (#43).
 *
 * The load-bearing test here is the STRADDLE logic: it is the one piece of
 * reasoning the panel does with the interval rather than merely printing it,
 * and getting the boundary wrong would either cry wolf on every row or stay
 * silent on the case the feature exists for.
 */
import { describe, it, expect } from 'vitest'
import {
  hasBounds, intervalAccessibleText, intervalRangeText, intervalVisualText,
  straddleNote, straddledThresholds, type ReliabilityInterval,
} from './reliability-interval'

const ALPHA_CUTOFFS = { tentative: 0.667, reliable: 0.8 }

function ci(lower: number | null, upper: number | null): ReliabilityInterval {
  return {
    lower, upper, level: 0.95, method: 'alpha_bootstrap_units',
    n_resamples: 2000, unavailable_reason: null,
  }
}

describe('hasBounds', () => {
  it('rejects an interval whose bounds are null', () => {
    expect(hasBounds(ci(null, null))).toBe(false)
    expect(hasBounds(null)).toBe(false)
    expect(hasBounds(undefined)).toBe(false)
    expect(hasBounds(ci(0.5, 0.8))).toBe(true)
  })

  it('accepts a bound of exactly zero', () => {
    // The falsy-zero defect this project has shipped twice: 0.0 is a real
    // bound, and a κ interval that starts at chance level is the interesting
    // case, not the missing one.
    expect(hasBounds(ci(0, 0.4))).toBe(true)
  })
})

describe('formatting', () => {
  it('renders brackets for the eye and "to" for the ear', () => {
    expect(intervalVisualText(ci(0.5732, 0.7486))).toBe('[0.57, 0.75]')
    expect(intervalRangeText(ci(0.5732, 0.7486))).toBe('0.57 to 0.75')
  })

  it('spells a negative bound rather than dashing it', () => {
    // A range dash would be announced as a minus sign, and κ can legitimately be
    // negative — so "−0.10–0.30" is not merely ugly, it is unreadable.
    expect(intervalRangeText(ci(-0.1, 0.3))).toBe('-0.10 to 0.30')
  })

  it('names the level and the qualifier in the spoken form', () => {
    expect(intervalAccessibleText(ci(0.57, 0.75), ' over units'))
      .toBe('95% confidence interval 0.57 to 0.75 over units')
  })

  it('falls back to 95 for a missing or malformed level', () => {
    const malformed = { ...ci(0.1, 0.2), level: 0 }
    expect(intervalAccessibleText(malformed, '')).toContain('95% confidence interval')
  })

  it('returns null rather than a half-formed string when there are no bounds', () => {
    expect(intervalVisualText(ci(null, null))).toBeNull()
    expect(intervalAccessibleText(null, '')).toBeNull()
  })
})

describe('straddledThresholds', () => {
  it('names a cutoff the interval spans', () => {
    expect(straddledThresholds(ci(0.55, 0.85), ALPHA_CUTOFFS).map(t => t.name))
      .toEqual(['tentative', 'reliable'])
  })

  it('stays silent when the interval settles the question', () => {
    // Entirely above both cutoffs: the data HAVE decided, and saying so anyway
    // would train the reader to ignore the line.
    expect(straddledThresholds(ci(0.85, 0.95), ALPHA_CUTOFFS)).toEqual([])
    // Entirely below both.
    expect(straddledThresholds(ci(0.1, 0.4), ALPHA_CUTOFFS)).toEqual([])
  })

  it('orders the crossed cutoffs by value, not by key', () => {
    // `Object.entries` yields insertion order, which is not ascending here.
    const scrambled = { reliable: 0.8, tentative: 0.667 }
    expect(straddledThresholds(ci(0.5, 0.9), scrambled).map(t => t.value))
      .toEqual([0.667, 0.8])
  })

  it('treats a cutoff exactly at the upper bound as crossed and one at the lower as settled', () => {
    // The boundary convention, asserted rather than left to a reading of the
    // filter: `lower < cutoff <= upper`. An interval whose LOWER bound is the
    // cutoff lies entirely in the band above it.
    expect(straddledThresholds(ci(0.5, 0.8), ALPHA_CUTOFFS).map(t => t.name))
      .toEqual(['tentative', 'reliable'])
    expect(straddledThresholds(ci(0.8, 0.9), ALPHA_CUTOFFS)).toEqual([])
  })

  it('is empty for an interval with no bounds or no thresholds', () => {
    expect(straddledThresholds(ci(null, null), ALPHA_CUTOFFS)).toEqual([])
    expect(straddledThresholds(ci(0.5, 0.9), undefined)).toEqual([])
    expect(straddledThresholds(ci(0.5, 0.9), {})).toEqual([])
  })
})

describe('straddleNote', () => {
  const word = (k: string) => k

  it('states the consequence, not just the fact', () => {
    const note = straddleNote(ci(0.7, 0.85), ALPHA_CUTOFFS, word)
    expect(note).toContain('0.8 (reliable)')
    expect(note).toContain('cannot tell those readings apart')
    expect(note).not.toContain('cutoffs')   // singular for one
  })

  it('lists two crossed cutoffs in a readable sentence', () => {
    const note = straddleNote(ci(0.55, 0.85), ALPHA_CUTOFFS, word)
    expect(note).toContain('0.667 (tentative) and 0.8 (reliable)')
    expect(note).toContain('cutoffs')
  })

  it('returns null when nothing is straddled', () => {
    expect(straddleNote(ci(0.85, 0.95), ALPHA_CUTOFFS, word)).toBeNull()
    expect(straddleNote(null, ALPHA_CUTOFFS, word)).toBeNull()
  })

  it('takes its band words from the caller, inventing no vocabulary', () => {
    const note = straddleNote(ci(0.7, 0.85), ALPHA_CUTOFFS, () => 'RELIABLE-WORD')
    expect(note).toContain('RELIABLE-WORD')
  })
})
