/**
 * Group-difference test selection for the Add Statistical Test dialog (#506).
 *
 * Counts must be REAL group counts (`real_group_count` — results with a
 * non-null group_value). `result_count` also counts the None listwise-deletion
 * bucket that `compute_metric` keeps for missing grouping values, which
 * inflated "(N groups)" and, at the 2-real-group boundary, auto-picked ANOVA
 * for what is actually a 2-group comparison (mislabeling the test and
 * reporting η²/ω² instead of Cohen's d).
 */
export function pickGroupDifferenceTest(
  realGroupCount: number,
): 'independent_t_test' | 'one_way_anova' {
  return realGroupCount === 2 ? 'independent_t_test' : 'one_way_anova'
}

export function groupDifferenceTestLabel(realGroupCount: number): string {
  if (realGroupCount === 2) return 'Will use independent t-test (2 groups)'
  if (realGroupCount >= 3) return `Will use one-way ANOVA (${realGroupCount} groups)`
  return 'Need at least 2 groups with computed results'
}
