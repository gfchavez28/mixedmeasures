import { describe, it, expect } from 'vitest'
import { NO_VALUE, formatStat, formatDescriptive, describeUndefined, undefinedTooltip } from './stat-format'

/**
 * #689 — the client half of "an undefined statistic is null with a reason".
 */
describe('formatStat', () => {
  it('renders a real measured zero, and only blanks what has no value', () => {
    // The whole point of the convention: `0.00` must keep meaning "measured
    // zero" now that "not computable" has its own rendering. A `value ? … : —`
    // shortcut here would re-create the defect the backend just removed.
    expect(formatStat(0)).toBe('0.00')
    expect(formatStat(-0)).toBe('0.00')
    expect(formatStat(0.004)).toBe('0.00')
    expect(formatStat(null)).toBe(NO_VALUE)
    expect(formatStat(undefined)).toBe(NO_VALUE)
  })

  it('blanks a non-finite number rather than printing Infinity', () => {
    // Defence in depth: the server no longer sends these, but a stale cached
    // payload or a future endpoint should not render "Infinity" at a user.
    expect(formatStat(Number.NaN)).toBe(NO_VALUE)
    expect(formatStat(Number.POSITIVE_INFINITY)).toBe(NO_VALUE)
  })

  it('honours the requested precision', () => {
    expect(formatStat(0.12345, 3)).toBe('0.123')
  })
})

describe('describeUndefined', () => {
  it('has a distinct sentence for every reason the server can send', () => {
    const reasons = ['insufficient_n', 'empty_group', 'no_variance', 'degenerate']
    const sentences = reasons.map(r => describeUndefined(r))
    expect(sentences.every(Boolean)).toBe(true)
    // Distinct, because they are distinct facts: "only one person answered"
    // and "everyone gave the same answer" lead to different next actions.
    expect(new Set(sentences).size).toBe(reasons.length)
  })

  it('returns null for an unknown code rather than inventing a sentence', () => {
    // A newer backend sending a reason this client does not know must degrade
    // to saying nothing, never to a confident wrong explanation.
    expect(describeUndefined('some_future_reason')).toBeNull()
    expect(describeUndefined(null)).toBeNull()
    expect(describeUndefined('')).toBeNull()
  })

  it('falls back to a neutral tooltip when the reason is unknown', () => {
    expect(undefinedTooltip('no_variance')).toContain('identical')
    expect(undefinedTooltip('some_future_reason')).toBe('Not computable for this data.')
  })
})

describe('formatDescriptive — #823(e), the summary table\'s decimals', () => {
  it('never renders a non-zero value as zero', () => {
    // The measured case: SE = sd/√n on a 43,029-respondent scale. At 1 dp this
    // printed `0.0`, on the one column whose job is to state precision — and it
    // gets WORSE as the study gets bigger, which is the wrong direction.
    expect(formatDescriptive(0.9681 / Math.sqrt(43029))).toBe('0.0047')
    expect(formatDescriptive(0.0004)).toBe('0.00040')
    expect(formatDescriptive(-0.0047)).toBe('-0.0047')
  })

  it('separates values that 1 dp collapsed', () => {
    // Three real SDs from the same screen, all of which rendered `1.0`.
    expect(formatDescriptive(0.9681)).toBe('0.97')
    expect(formatDescriptive(0.9506)).toBe('0.95')
    expect(formatDescriptive(0.9630)).toBe('0.96')
    // …and two means 0.04 apart, both of which rendered `2.0`.
    expect(formatDescriptive(1.9948)).toBe('1.99')
    expect(formatDescriptive(2.0367)).toBe('2.04')
  })

  it('keeps a REAL zero, at the base precision', () => {
    // The falsy-zero rule: a measured 0 is a finding, not an absence, and must
    // not be chased down six decimals looking for a significant digit.
    expect(formatDescriptive(0)).toBe('0.00')
    expect(formatDescriptive(-0)).toBe('0.00')
  })

  it('says NO_VALUE for what has none', () => {
    expect(formatDescriptive(null)).toBe(NO_VALUE)
    expect(formatDescriptive(undefined)).toBe(NO_VALUE)
    expect(formatDescriptive(NaN)).toBe(NO_VALUE)
    expect(formatDescriptive(Infinity)).toBe(NO_VALUE)
  })

  it('stops chasing digits rather than running away', () => {
    // A vanishingly small number gets the cap, not 300 decimals.
    expect(formatDescriptive(1e-30)).toBe('0.000000')
    expect(formatDescriptive(1e-30).length).toBeLessThan(12)
  })

  it('leaves ordinary magnitudes at two decimals', () => {
    expect(formatDescriptive(43029)).toBe('43029.00')
    expect(formatDescriptive(2.5)).toBe('2.50')
  })
})
