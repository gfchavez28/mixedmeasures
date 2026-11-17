import api from './client'
import { namedBlob, EXPORT_TIMEOUT_MS } from './download'
import { liftCoderIds } from './coder-scope-query'  // #1615

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
  /** #525b — Levene only. Groups in the COMPARISON but not in the TEST, named
   *  rather than silently absorbed: empty ones, and (since #1329, D51) ones
   *  holding a single value, which every test of the row leaves out. */
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
  /** #1549 (b): the groups of one this plot LEFT OUT, by name — the parametric tests'
   *  rule, so it diagnoses the model they fit (`lib/untested-groups.ts::qqLeftOutNote`). */
  singleton_groups: string[]
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
  /** #1326 STAT-12 (D58) — how THIS p was computed when the data chose the
   *  method (Mann–Whitney: exact or normal approximation). Read only through
   *  `lib/p-method.ts`; `null` or absent for a test whose p has one method. */
  p_method?: string | null
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
  /** #1329 (D51) — groups this row shows that every test of it leaves out (too
   *  few values for the test). Said through `lib/untested-groups.ts`, never
   *  re-derived from the sizes. Absent from a server that predates it. */
  untested_groups?: string[]
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
  /** #1168 R7 — variable groups whose stored per-record scale scores predate a
   *  change to their members' cells. The comparison READ them, as stored; the
   *  page names them beside the recompute (`StaleScaleScoresNotice`). `[]` when
   *  fresh or when the request used variables, not groups. */
  stale_domain_ids: number[]
  /** #1615 D295 — how many rating variables the server left out while blind (its own count;
   *  the page says it through `lib/blind-rating-columns.ts::withheldDoorNotice`). */
  withheld_rating_variables?: number
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
    /** #1615 — the viewer alone while blind (`lib/analysis-scope.ts`); absent = every coder. */
    coder_ids?: number[] | null
  }) => {
    const [body, params] = liftCoderIds(data)  // #1615: the route reads the scope from the query
    return api.post<GroupComparisonResponse>(`/projects/${projectId}/metrics/group-comparison`, body, { params }).then(res => res.data)
  },
  /** Resolves to the blob AND the server's filename — see `namedBlob` (#743). */
  groupComparisonCsv: (projectId: number, params: {
    column_ids: number[]
    domain_ids: number[]
    grouping_column_id: number
    grouping_column_id_2?: number | null
    test_type: string
    exclude_groups?: string[]
    nonparametric?: boolean
    /** #1615 — the viewer alone while blind (`AnalysisScope.coderScope`); absent = every coder. */
    coderScope?: string
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
        coder_ids: params.coderScope || undefined,
      },
      responseType: 'blob',
      // #833 — the project-scale export budget, not the 30 s client default.
      // This is `EXPORT_TIMEOUT_MS`, already decided and measured for #820; it
      // is applied here rather than re-derived. Cost scales with rows x columns
      // and the client cannot know either before asking.
      timeout: EXPORT_TIMEOUT_MS,
    }).then(res => namedBlob(res, 'group_comparison.csv')),
}
