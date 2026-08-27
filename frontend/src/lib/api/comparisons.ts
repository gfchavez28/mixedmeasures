import api from './client'
import { namedBlob, EXPORT_TIMEOUT_MS } from './download'

// Comparison types
/**
 * #522b — the five-number summary behind a box plot.
 *
 * ⚠️ `quartile_method` / `whisker_rule` are DISPLAYED, never assumed. Several
 * quartile definitions exist and disagree on small samples, so the figure is
 * only interpretable if the reader is told which drew it (the stated-basis
 * family: the server states how a number was produced, the client shows that).
 */
export interface BoxSummary {
  min: number | null
  q1: number | null
  median: number | null
  q3: number | null
  max: number | null
  whisker_low: number | null
  whisker_high: number | null
  outliers: number[]
  /** Points beyond the cap. Reported so a truncation is never silent. */
  outliers_omitted: number
  quartile_method: string
  whisker_rule: string
}

/** #525 — a normality or equal-variance check. */
export interface AssumptionCheck {
  test: string
  statistic: number | null
  p: number | null
  /** Levene only. STATED because the mean-centred variant gives a different number. */
  center?: string | null
  undefined_reason: string | null
  /** #525b — Levene only. Groups in the COMPARISON but not in the TEST: empty
   *  ones are dropped, and a singleton contributes a structural zero deviation
   *  that reads as perfect homogeneity. Named, not silently absorbed. */
  excluded_groups?: string[]
  singleton_groups?: string[]
}

/** #525b — one plotted pair on the normal QQ diagnostic. */
export interface QQPoint {
  theoretical: number
  sample: number
}

/**
 * #525b — the normal QQ diagnostic for a comparison row.
 *
 * ⚠️ `plotting_position` / `reference_line` are DISPLAYED, never assumed: R's
 * `ppoints()` switches convention at n > 10, so the position is sample-size-
 * dependent in the reference implementation itself.
 */
export interface QQSummary {
  /** Thinned by evenly-spaced order statistics, both extremes always kept. */
  points: QQPoint[]
  points_omitted: number
  /** Residuals behind the plot — NOT `points.length`, which is post-thinning. */
  n: number
  /** Probability-plot correlation, over ALL residuals rather than the drawn set. */
  ppcc: number | null
  line_slope: number | null
  line_intercept: number | null
  singleton_group_count: number
  plotting_position: string
  reference_line: string
  undefined_reason: string | null
}

export interface GroupStat {
  group: string
  n: number
  /** `null` when the group is empty after missing-data exclusion — a mean of
   *  `0.0` with a zero-width CI was a measurement claim about people who are
   *  not there (#689). `median` was already nullable here, which is how the
   *  inconsistency stayed invisible. */
  mean: number | null
  sd: number | null
  median: number | null
  ci_lower: number | null
  ci_upper: number | null
  undefined_reason: string | null
  /** Absent for an empty group, exactly like `mean`/`median`. */
  box?: BoxSummary | null
  /** #525 — Shapiro-Wilk for this group. */
  normality?: AssumptionCheck | null
}

export interface TestResult {
  test_type: string
  statistic: number
  df: number
  df2: number | null
  p: number
  effect_size: number
  effect_size_type: string
  effect_size_label: string | null
  omega_squared: number | null
  /** Classified from `omega_squared`. Use this whenever ω² is the number on
   *  screen — `effect_size_label` describes η², and ω² ≤ η² always (#742). */
  omega_squared_label: string | null
  post_hoc: { post_hoc_method: string; comparisons: { group_a: string; group_b: string; mean_diff: number; p: number; ci_lower: number; ci_upper: number }[] } | null
  effect_size_ci_lower: number | null
  effect_size_ci_upper: number | null
}

export interface ComparisonRow {
  label: string
  full_label: string
  source_id: number
  source_type: string
  group_stats: GroupStat[]
  test: TestResult | null
  /** #566 — why no test was run, when `test` is null. A blank row that cannot
   *  explain itself is indistinguishable from a broken tool. */
  test_omitted_reason: string | null
  /** #525 — Levene across this row's groups. A property of the comparison. */
  variance_homogeneity?: AssumptionCheck | null
  /** #525b — the QQ diagnostic, per ROW because normality is a property of the
   *  model's residuals. Absent unless the request asked for it. */
  qq?: QQSummary | null
}

export interface GroupComparisonResponse {
  groups: string[]
  group_column_label: string
  rows: ComparisonRow[]
  bonferroni_warning: boolean
  bonferroni_threshold: number | null
  /** Why `rows` is empty — read through `lib/comparison-unavailable.ts`, never
   *  guessed at the render site. `null` when rows were produced; absent from a
   *  server that predates the field, which the reader treats as unknown. */
  unavailable_reason?: string | null
}

// API functions - Comparisons
export const comparisonsApi = {
  groupComparison: (projectId: number, data: {
    column_ids: number[]
    domain_ids: number[]
    grouping_column_id: number
    grouping_column_id_2?: number | null
    test_type: string
    include_effect_size_ci: boolean
    exclude_groups?: string[]
    nonparametric?: boolean
    /** #525b — OPT-IN. The QQ points are the only O(n) field in the response,
     *  so the four chart types that never draw them do not pay for them. */
    include_qq?: boolean
  }) =>
    api.post<GroupComparisonResponse>(`/projects/${projectId}/metrics/group-comparison`, data).then(res => res.data),
  /** Resolves to the blob AND the server's filename — see `namedBlob` (#743). */
  groupComparisonCsv: (projectId: number, params: {
    column_ids: number[]
    domain_ids: number[]
    grouping_column_id: number
    grouping_column_id_2?: number | null
    test_type: string
    exclude_groups?: string[]
    nonparametric?: boolean
  }) =>
    api.get(`/projects/${projectId}/metrics/group-comparison/csv`, {
      params: {
        column_ids: params.column_ids.join(','),
        domain_ids: params.domain_ids.join(','),
        grouping_column_id: params.grouping_column_id,
        grouping_column_id_2: params.grouping_column_id_2 ?? undefined,
        test_type: params.test_type,
        exclude_groups: params.exclude_groups?.length ? params.exclude_groups.join(',') : undefined,
        nonparametric: params.nonparametric || undefined,
      },
      responseType: 'blob',
      // #833 — the project-scale export budget, not the 30 s client default.
      // This is `EXPORT_TIMEOUT_MS`, already decided and measured for #820; it
      // is applied here rather than re-derived. Cost scales with rows x columns
      // and the client cannot know either before asking.
      timeout: EXPORT_TIMEOUT_MS,
    }).then(res => namedBlob(res, 'group_comparison.csv')),
}
