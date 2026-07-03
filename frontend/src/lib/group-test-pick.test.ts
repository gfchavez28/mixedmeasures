import { describe, it, expect } from 'vitest'
import { pickGroupDifferenceTest, groupDifferenceTestLabel } from './group-test-pick'

// #506 regression: the dialog previously fed result_count (which counts the
// None listwise-deletion bucket) into the t-vs-ANOVA pick. The corpus repro:
// Site has 3 real groups + a None bucket → result_count 4; a 2-real-group
// variable with missing values has result_count 3 and auto-picked ANOVA.
describe('pickGroupDifferenceTest (#506)', () => {
  it('picks the t-test at exactly 2 REAL groups (the boundary the None bucket broke)', () => {
    expect(pickGroupDifferenceTest(2)).toBe('independent_t_test')
  })

  it('picks ANOVA at 3+ real groups', () => {
    expect(pickGroupDifferenceTest(3)).toBe('one_way_anova')
    expect(pickGroupDifferenceTest(4)).toBe('one_way_anova')
  })

  it('labels match the pick', () => {
    expect(groupDifferenceTestLabel(2)).toBe('Will use independent t-test (2 groups)')
    expect(groupDifferenceTestLabel(3)).toBe('Will use one-way ANOVA (3 groups)')
    expect(groupDifferenceTestLabel(1)).toBe('Need at least 2 groups with computed results')
    expect(groupDifferenceTestLabel(0)).toBe('Need at least 2 groups with computed results')
  })
})
