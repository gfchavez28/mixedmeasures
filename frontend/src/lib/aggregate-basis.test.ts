/**
 * #693 — a scale score names what it is, and its `n` says what it counts.
 */
import { describe, it, expect } from 'vitest'
import {
  UNWEIGHTED_ITEM_MEANS,
  isUnweightedItemMeans,
  aggregateBasisLabel,
  aggregateBasisCaveat,
  aggregateNLabel,
  aggregateNCaveat,
} from './aggregate-basis'

describe('the basis rides the wire', () => {
  it('labels the aggregation Mixed Measures actually performs', () => {
    expect(aggregateBasisLabel(UNWEIGHTED_ITEM_MEANS)).toBe('unweighted mean of item means')
  })

  it('says the equivalence was asserted, not tested', () => {
    // #693(iii) — the tool never checks that the items share a scale, and the
    // caveat has to say so or it only describes the arithmetic.
    expect(aggregateBasisCaveat(UNWEIGHTED_ITEM_MEANS)).toMatch(/does not test/)
    expect(aggregateBasisCaveat(UNWEIGHTED_ITEM_MEANS)).toMatch(/asserted by you/)
  })

  /**
   * An unknown basis invents nothing. Older `ComputedResult` rows predate the
   * field, and a second aggregation (POMP — #693(ii)) will take its own value:
   * describing an unidentified computation is the failure this module exists to
   * prevent, so silence is the correct output.
   *
   * ⚠️ This covers the RUNTIME unknown only. The COMPILE-TIME one — a basis added
   * to `AggregationBasis` with no phrase written for it — is caught by
   * `satisfies Record<AggregationBasis, string>` on the two maps, and no runtime
   * assertion can see it. The two must not be collapsed: silence is right for a
   * payload we cannot identify and wrong for a value we simply forgot to describe.
   */
  it('says nothing about a basis it cannot identify', () => {
    expect(aggregateBasisLabel(undefined)).toBeUndefined()
    expect(aggregateBasisLabel(null)).toBeUndefined()
    expect(aggregateBasisLabel('pomp')).toBeUndefined()
    expect(aggregateBasisCaveat('pomp')).toBeUndefined()
    expect(isUnweightedItemMeans('pomp')).toBe(false)
  })
})

describe('the n states its unit and its spread', () => {
  /**
   * The dangerous half of #693. `valid_n` is the SUM of the items' respondent
   * counts, and a sum reads as a respondent count beside a mean: n=1000 mean=2.0
   * plus n=10 mean=8.0 displays 5.0 next to "n = 1010" when the
   * respondent-weighted estimate is ≈2.06.
   */
  it('names items and the per-item range rather than the pooled total', () => {
    expect(aggregateNLabel({ member_count: 2, member_n_min: 10, member_n_max: 1000 }))
      .toBe('2 items · n 10–1000')
    expect(aggregateNLabel({ member_count: 2, member_n_min: 10, member_n_max: 1000 }))
      .not.toContain('1010')
  })

  it('prints one number when every item has the same n', () => {
    // "n 40–40" reads as a formatting bug; the spread is the point, and there
    // isn't one here.
    expect(aggregateNLabel({ member_count: 3, member_n_min: 40, member_n_max: 40 }))
      .toBe('3 items · n 40')
  })

  it('says "item" for a one-item scale', () => {
    expect(aggregateNLabel({ member_count: 1, member_n_min: 12, member_n_max: 12 }))
      .toBe('1 item · n 12')
  })

  it('falls back to the plain n on a result that predates the fields', () => {
    // A stored ComputedResult from before this change. Returning null lets the
    // caller print `row.n`, rather than claiming "0 items".
    expect(aggregateNLabel({})).toBeNull()
    expect(aggregateNLabel({ member_count: 0 })).toBeNull()
    expect(aggregateNCaveat({}, 100)).toBeNull()
  })

  it('names the pooled figure in the tooltip as a total across items', () => {
    const caveat = aggregateNCaveat({ member_count: 2, member_n_min: 10, member_n_max: 1000 }, 1010)
    expect(caveat).toContain('1010')
    expect(caveat).toMatch(/not a count of respondents/)
  })

  it('states the item count even when the per-item range is missing', () => {
    expect(aggregateNLabel({ member_count: 4 })).toBe('4 items')
  })
})
