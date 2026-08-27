/**
 * #525 — the caveat is the load-bearing half.
 *
 * A bare p-value beside the non-parametric toggle would make the tool MORE
 * confidently wrong than saying nothing: Shapiro–Wilk over-rejects above n ≈ 200
 * and has almost no power below n ≈ 10. These pin that the sentence appears in
 * the right direction for the n at hand, and stays silent in the middle band
 * where it would be noise.
 */
import { describe, it, expect } from 'vitest'
import {
  assumptionTestLabel,
  normalityCaveat,
  worstNormalityCaveat,
  leveneCaveat,
  SHAPIRO_OVERSENSITIVE_N,
  SHAPIRO_UNDERPOWERED_N,
} from './assumption-basis'

describe('#525 — the normality caveat runs in both directions', () => {
  it('warns about OVER-sensitivity at large n', () => {
    expect(normalityCaveat(SHAPIRO_OVERSENSITIVE_N)).toMatch(/too small/)
    expect(normalityCaveat(5000)).toMatch(/too small/)
  })

  it('warns about NO POWER at small n', () => {
    expect(normalityCaveat(SHAPIRO_UNDERPOWERED_N - 1)).toMatch(/little power/)
    expect(normalityCaveat(3)).toMatch(/little power/)
  })

  it('says nothing in the band where the test behaves as advertised', () => {
    expect(normalityCaveat(SHAPIRO_UNDERPOWERED_N)).toBeNull()
    expect(normalityCaveat(50)).toBeNull()
    expect(normalityCaveat(SHAPIRO_OVERSENSITIVE_N - 1)).toBeNull()
  })

  it('a non-significant result at small n is NOT called evidence of normality', () => {
    // The inversion researchers actually make.
    expect(normalityCaveat(4)).toMatch(/not evidence of it/)
  })

  it('across groups it reports the caveat that actually applies', () => {
    expect(worstNormalityCaveat([300, 50])).toMatch(/too small/)
    expect(worstNormalityCaveat([5, 50])).toMatch(/little power/)
    expect(worstNormalityCaveat([40, 60])).toBeNull()
    expect(worstNormalityCaveat([])).toBeNull()
  })
})

describe('#525 — the test names its own basis', () => {
  it('names Levene\'s CENTRE, because the mean-centred variant differs', () => {
    expect(assumptionTestLabel('levene', 'median')).toMatch(/Brown–Forsythe/)
    expect(assumptionTestLabel('levene', 'mean')).toMatch(/mean-centred/)
  })

  /**
   * An unknown test from a newer backend is shown VERBATIM rather than
   * relabelled as one we know — the stated-basis family's silence rule.
   */
  it('reports an unknown test verbatim instead of guessing', () => {
    expect(assumptionTestLabel('anderson_darling')).toBe('anderson_darling')
  })
})

describe('#525b — groups in the comparison but not in the test', () => {
  it('names an EMPTY group, which Levene drops outright', () => {
    const s = leveneCaveat({ excluded_groups: ['East'], singleton_groups: [] })!
    expect(s).toMatch(/East/)
    expect(s).toMatch(/empty/i)
  })

  /**
   * MEASURED: `levene([1.0], [1,2,3,4], center="median")` returns a
   * confident-looking p = 0.219 resting on a deviation that is zero by
   * construction. Naming it is not refusing it.
   */
  it('names a SINGLETON group, whose deviation is structurally zero', () => {
    const s = leveneCaveat({ excluded_groups: [], singleton_groups: ['Solo'] })!
    expect(s).toMatch(/Solo/)
    expect(s).toMatch(/single observation/i)
  })

  it('keeps the two cases DISTINCT', () => {
    // A fixture carrying only one arm cannot tell them apart, and a reader
    // keyed on the wrong list would still look right (#709's disjunction rule).
    const s = leveneCaveat({ excluded_groups: ['Empty'], singleton_groups: ['Solo'] })!
    expect(s).toMatch(/Empty/)
    expect(s).toMatch(/Solo/)
    expect(s.indexOf('Empty')).toBeLessThan(s.indexOf('Solo'))
  })

  it('is null when every group is in the test — no caveat is noise', () => {
    expect(leveneCaveat({ excluded_groups: [], singleton_groups: [] })).toBeNull()
    expect(leveneCaveat({})).toBeNull()
    expect(leveneCaveat(null)).toBeNull()
  })

  it('survives a payload from a server that predates the fields', () => {
    // Both are optional on the wire; an older backend sends neither.
    expect(leveneCaveat({ excluded_groups: undefined, singleton_groups: undefined }))
      .toBeNull()
  })
})
