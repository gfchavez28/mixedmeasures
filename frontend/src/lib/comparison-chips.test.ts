import { describe, it, expect } from 'vitest'
import { comparisonGroupChips } from './comparison-chips'

// #510 regression: the sidebar chips presented the FIRST variable's per-group
// valid n as THE group n. Corpus repro: Hours+Satisfaction compared by Site —
// East is n=4 for Hours but n=5 for Satisfaction; the chip said "East (n=4)"
// with no attribution.
const rows = [
  {
    label: 'Hours',
    group_stats: [
      { group: 'East', n: 4 },
      { group: 'North', n: 9 },
      { group: 'South', n: 7 },
    ],
  },
  {
    label: 'Satisfaction',
    group_stats: [
      { group: 'East', n: 5 },
      { group: 'North', n: 9 },
      { group: 'South', n: 7 },
    ],
  },
]
const groups = ['East', 'North', 'South']

describe('comparisonGroupChips (#510)', () => {
  it('attributes the n to its variable when 2+ variables have different per-group n', () => {
    const { chips, nVariableLabel } = comparisonGroupChips(groups, rows)
    expect(chips).toEqual([
      { group: 'East', n: 4 },
      { group: 'North', n: 9 },
      { group: 'South', n: 7 },
    ])
    expect(nVariableLabel).toBe('Hours')
  })

  it('omits the attribution for a single variable (its n IS the group n)', () => {
    const { nVariableLabel } = comparisonGroupChips(groups, [rows[0]])
    expect(nVariableLabel).toBeNull()
  })

  it('handles a group missing from the first row stats', () => {
    const { chips } = comparisonGroupChips(['East', 'West'], [rows[0]])
    expect(chips).toEqual([
      { group: 'East', n: 4 },
      { group: 'West', n: null },
    ])
  })

  it('handles no rows', () => {
    const { chips, nVariableLabel } = comparisonGroupChips(groups, [])
    expect(chips.every(c => c.n === null)).toBe(true)
    expect(nVariableLabel).toBeNull()
  })

  // ── #830(b) ────────────────────────────────────────────────────────────────
  //
  // A nominal variable is a legitimate metric input (#371) and holds no
  // `value_numeric`, so every one of its groups comes back n=0. Selected FIRST,
  // it made every chip read "(n=0)" directly above a table reporting n=6 for the
  // same groups — measured on the Ferncrest corpus with `School` selected.
  const nominalRow = {
    label: 'School',
    group_stats: [
      { group: 'East', n: 0 },
      { group: 'North', n: 0 },
      { group: 'South', n: 0 },
    ],
  }

  it('does not take the n from a variable that has none', () => {
    const { chips } = comparisonGroupChips(groups, [nominalRow, rows[0]])
    expect(chips).toEqual([
      { group: 'East', n: 4 },
      { group: 'North', n: 9 },
      { group: 'South', n: 7 },
    ])
  })

  it('names nothing when only ONE variable could supply the n', () => {
    // Attributing "n from Hours" would imply School offers a different number.
    // It offers none, so there is one measurement and no ambiguity to resolve.
    const { nVariableLabel } = comparisonGroupChips(groups, [nominalRow, rows[0]])
    expect(nVariableLabel).toBeNull()
  })

  it('still reports zeros when NO variable measured anything', () => {
    // The all-empty case is a real answer, not a defect: say so rather than
    // blanking, which would read as "not computed".
    const { chips } = comparisonGroupChips(groups, [nominalRow])
    expect(chips.every(c => c.n === 0)).toBe(true)
  })
})
