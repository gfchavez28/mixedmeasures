import { EXPORT_TIMEOUT_MS } from './download'
import api from './client'
import { liftCoderIds } from './coder-scope-query'  // #1615

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
  /** #1615 D295 — the rating variables left out while blind (the server's own count). */
  withheld_rating_variables?: number
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
  /** #1615 D295 — as on `MissingSummaryResponse`. */
  withheld_rating_variables?: number
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
  /** Which estimates produced the statistic — read via `lib/mcar-basis.ts` (#707b). */
  mcar_estimator?: string | null
}

export interface McarTestResponse {
  eligibility: McarEligibility
  result: McarTestResult | null
}

export interface DataQualityRequestBody {
  column_ids: number[]
  include_na_as_missing: boolean
  include_empty_as_missing: boolean
  /** #1615 — the viewer alone while blind (`lib/analysis-scope.ts`); absent = every coder. */
  coder_ids?: number[] | null
}

// API functions - Data Quality
export const dataQualityApi = {
  // #1615: each route reads the scope from the query string (`liftCoderIds`).
  summary: (projectId: number, data: DataQualityRequestBody) => {
    const [body, params] = liftCoderIds(data)
    return api.post<MissingSummaryResponse>(`/projects/${projectId}/data-quality/summary`, body, { params }).then(r => r.data)
  },

  patterns: (projectId: number, data: DataQualityRequestBody & { max_patterns?: number }) => {
    const [body, params] = liftCoderIds(data)
    return api.post<MissingPatternsResponse>(`/projects/${projectId}/data-quality/patterns`, body, { params }).then(r => r.data)
  },

  mcarTest: (projectId: number, data: DataQualityRequestBody) => {
    const [body, params] = liftCoderIds(data)
    return api.post<McarTestResponse>(`/projects/${projectId}/data-quality/mcar-test`, body, { params }).then(r => r.data)
  },

  summaryCsv: (projectId: number, params: {
    column_ids: number[]
    include_na_as_missing: boolean
    include_empty_as_missing: boolean
    /** #1615 — the viewer alone while blind (`AnalysisScope.coderScope`); absent = every coder. */
    coderScope?: string
  }) =>
    api.get(`/projects/${projectId}/data-quality/summary/csv`, {
      params: {
        column_ids: params.column_ids.join(','),
        include_na_as_missing: params.include_na_as_missing,
        include_empty_as_missing: params.include_empty_as_missing,
        coder_ids: params.coderScope || undefined,
      },
      responseType: 'blob',
      // #833 — the project-scale export budget, not the 30 s client default.
      // This is `EXPORT_TIMEOUT_MS`, already decided and measured for #820; it
      // is applied here rather than re-derived. Cost scales with rows x columns
      // and the client cannot know either before asking.
      timeout: EXPORT_TIMEOUT_MS,
    }).then(r => r.data as Blob),
}
