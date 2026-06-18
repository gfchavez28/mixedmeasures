import api from './client'

// Comparison types
export interface GroupStat {
  group: string
  n: number
  mean: number
  sd: number
  median: number | null
  ci_lower: number | null
  ci_upper: number | null
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
}

export interface GroupComparisonResponse {
  groups: string[]
  group_column_label: string
  rows: ComparisonRow[]
  bonferroni_warning: boolean
  bonferroni_threshold: number | null
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
  }) =>
    api.post<GroupComparisonResponse>(`/projects/${projectId}/metrics/group-comparison`, data).then(res => res.data),
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
    }).then(res => res.data as Blob),
}
