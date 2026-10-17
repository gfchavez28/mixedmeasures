import type { StatisticalTestResponse } from '@/lib/api'

/** The words a saved statistical test's type is shown as. */
export const TEST_TYPE_LABELS: Record<string, string> = {
  cronbachs_alpha: "Cronbach's Alpha",
  independent_t_test: 'Independent T-Test',
  one_way_anova: 'One-Way ANOVA',
  split_half: 'Split-Half Reliability',
}

/**
 * A saved test as its row shows it — "Split-Half Reliability — Wellbeing scale".
 *
 * a11y-name-sweep run 12: the row's two icon buttons were named "Compute test" and
 * "Delete test" whatever the test, so with two saved tests a reader met two of each —
 * in no list and under no row header, one of them a delete (#891 a's shape). Their
 * names carry this label now.
 */
export function savedTestLabel(test: Pick<StatisticalTestResponse, 'test_type' | 'target_label'>): string {
  const kind = TEST_TYPE_LABELS[test.test_type] || test.test_type
  return test.target_label ? `${kind} — ${test.target_label}` : kind
}
