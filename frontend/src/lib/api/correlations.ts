import api from './client'

// Correlation types
export interface CorrelationCell {
  r: number
  p: number
  n: number
}

export interface CorrelationMatrixResponse {
  labels: string[]
  full_labels: string[]
  matrix: CorrelationCell[][]
  adjusted_alpha: number | null
  num_comparisons: number
}

export interface RegressionResult {
  slope: number
  intercept: number
  r_squared: number
  r: number
  p: number
}

export interface ScatterDataResponse {
  x_label: string
  y_label: string
  x: number[]
  y: number[]
  record_ids: number[]
  groups: string[] | null
  n: number
  regression: RegressionResult
  group_regressions: Record<string, RegressionResult> | null
}

export interface ScatterPair {
  x_index: number
  y_index: number
  x_label: string
  y_label: string
  x: number[]
  y: number[]
  record_ids: number[]
  groups: string[] | null
  n: number
  regression: RegressionResult
}

export interface ScatterMatrixResponse {
  labels: string[]
  full_labels: string[]
  pairs: ScatterPair[]
  truncated: boolean
}

// API functions - Correlations
export const correlationsApi = {
  correlationMatrix: (projectId: number, data: {
    column_ids: number[]
    domain_ids: number[]
    correlation_type: string
    bonferroni: boolean
  }) =>
    api.post<CorrelationMatrixResponse>(`/projects/${projectId}/metrics/correlation-matrix`, data).then(res => res.data),
  scatterMatrix: (projectId: number, data: {
    column_ids: number[]
    domain_ids: number[]
    id_type: string
    group_column_id?: number | null
    max_variables?: number
  }) =>
    api.post<ScatterMatrixResponse>(`/projects/${projectId}/metrics/scatter-matrix`, data).then(res => res.data),
  correlationMatrixCsv: (projectId: number, params: {
    column_ids: number[]
    domain_ids: number[]
    correlation_type: string
    bonferroni: boolean
  }) =>
    api.get(`/projects/${projectId}/metrics/correlation-matrix/csv`, {
      params: {
        column_ids: params.column_ids.join(','),
        domain_ids: params.domain_ids.join(','),
        correlation_type: params.correlation_type,
        bonferroni: params.bonferroni,
      },
      responseType: 'blob',
    }).then(res => res.data as Blob),
  scatterDataCsv: (projectId: number, params: {
    column_ids: number[]
    domain_ids: number[]
    id_type: string
    group_column_id?: number | null
  }) =>
    api.get(`/projects/${projectId}/metrics/scatter-data/csv`, {
      params: {
        column_ids: params.column_ids.join(','),
        domain_ids: params.domain_ids.join(','),
        id_type: params.id_type,
        group_column_id: params.group_column_id ?? undefined,
      },
      responseType: 'blob',
    }).then(res => res.data as Blob),
}
