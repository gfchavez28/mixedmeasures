import api from './client'

// Data Quality types
export interface VariableMissingSummary {
  column_id: number
  variable_name: string
  full_label: string
  dataset_id: number
  dataset_name: string
  column_type: string
  n_total: number
  n_valid: number
  n_missing: number
  pct_missing: number
  n_empty: number
  n_na: number
}

export interface MissingSummaryResponse {
  variables: VariableMissingSummary[]
  total_rows: number
  total_cells: number
  total_missing: number
  overall_pct_missing: number
}

export interface PatternRow {
  pattern: boolean[]
  count: number
  pct: number
}

export interface MissingPatternsResponse {
  column_ids: number[]
  column_labels: string[]
  patterns: PatternRow[]
  total_rows: number
  n_unique_patterns: number
  truncated: boolean
}

export interface McarEligibility {
  eligible: boolean
  reason: string | null
  warning: string | null
}

export interface McarTestResult {
  chi2: number
  df: number
  p: number
  n: number
  n_patterns: number
  n_variables: number
  apa_string: string
  interpretation: string
}

export interface McarTestResponse {
  eligibility: McarEligibility
  result: McarTestResult | null
}

export interface DataQualityRequestBody {
  column_ids: number[]
  include_na_as_missing: boolean
  include_empty_as_missing: boolean
}

// API functions - Data Quality
export const dataQualityApi = {
  summary: (projectId: number, data: DataQualityRequestBody) =>
    api.post<MissingSummaryResponse>(`/projects/${projectId}/data-quality/summary`, data).then(r => r.data),

  patterns: (projectId: number, data: DataQualityRequestBody & { max_patterns?: number }) =>
    api.post<MissingPatternsResponse>(`/projects/${projectId}/data-quality/patterns`, data).then(r => r.data),

  mcarTest: (projectId: number, data: DataQualityRequestBody) =>
    api.post<McarTestResponse>(`/projects/${projectId}/data-quality/mcar-test`, data).then(r => r.data),

  summaryCsv: (projectId: number, params: {
    column_ids: number[]
    include_na_as_missing: boolean
    include_empty_as_missing: boolean
  }) =>
    api.get(`/projects/${projectId}/data-quality/summary/csv`, {
      params: {
        column_ids: params.column_ids.join(','),
        include_na_as_missing: params.include_na_as_missing,
        include_empty_as_missing: params.include_empty_as_missing,
      },
      responseType: 'blob',
    }).then(r => r.data as Blob),
}
