import api from './client'
import { downloadFromApi } from './download'

// Metric types
export type MetricType = 'frequency_distribution' | 'proportion' | 'mean' | 'domain_aggregate'
export type InputSourceType = 'dataset_column' | 'dataset_domain'
export type GroupingMode = 'column' | 'dataset'

export interface ComputedResultResponse {
  id: number
  group_value: string | null
  result_data: Record<string, unknown>
  valid_n: number
  total_n: number
  computed_at: string
}

export interface MetricDefinitionResponse {
  id: number
  project_id: number
  name: string
  description: string | null
  metric_type: MetricType
  config: Record<string, unknown>
  input_source_type: InputSourceType
  input_source_id: number
  input_source_label: string | null
  grouping_column_id: number | null
  grouping_column_id_2: number | null
  grouping_mode: GroupingMode | null
  exclude_values: string[] | null
  sequence_order: number
  origin: string
  origin_context: string | null
  stale: boolean
  result_type: string
  results: ComputedResultResponse[]
  last_accessed_at: string | null
  created_at: string
  updated_at: string
}

export interface MetricDefinitionSummaryResponse {
  id: number
  project_id: number
  name: string
  description: string | null
  metric_type: MetricType
  config: Record<string, unknown>
  input_source_type: InputSourceType
  input_source_id: number
  input_source_label: string | null
  grouping_column_id: number | null
  grouping_column_id_2: number | null
  grouping_mode: GroupingMode | null
  exclude_values: string[] | null
  sequence_order: number
  origin: string
  origin_context: string | null
  stale: boolean
  result_type: string
  latest_computed_at: string | null
  total_valid_n: number | null
  result_count: number
  /** #506: non-null-group results only (excludes the None/missing bucket) */
  real_group_count: number
  last_accessed_at: string | null
  created_at: string
  updated_at: string
}

export interface MetricListResponse {
  metrics: MetricDefinitionSummaryResponse[]
  total: number
}

export interface ComputeAllResponse {
  computed: number
  errors: Array<{ metric_id: number; name: string; error: string }>
}

// Quick-compute types
export interface QuickComputeSource {
  source_type: 'dataset_column' | 'dataset_domain'
  source_id: number
}

export interface QuickComputeRequest {
  sources: QuickComputeSource[]
  metric_type: string
  config: Record<string, unknown>
  grouping_column_id: number | null
  grouping_column_id_2: number | null
  grouping_mode: GroupingMode | null
  exclude_values: string[] | null
  decompose?: boolean
}

export interface QuickComputeResponse {
  metrics: MetricDefinitionResponse[]
  computed_count: number
  reused_count: number
}

// Analysis questions types
export interface AnalysisColumnItem {
  id: number
  dataset_id: number
  dataset_name: string
  column_code: string | null
  column_name: string | null
  column_text: string
  column_type: string
  scale_labels: string[] | null
  equivalence_group_id: number | null
  domain_ids: number[]
}

export interface AnalysisDatasetGroup {
  id: number
  name: string
  columns: AnalysisColumnItem[]
}

export interface AnalysisDomainItem {
  id: number
  name: string
  member_count: number
  datasets: string[]
}

export interface AnalysisDemographicItem {
  id: number
  column_name: string | null
  column_text: string
  dataset_id: number
  dataset_name: string
  subtype: string | null
}

export interface AnalysisColumnsResponse {
  datasets: AnalysisDatasetGroup[]
  domains: AnalysisDomainItem[]
  demographics: AnalysisDemographicItem[]
}

// Cross-tabulation types
export interface AnalysisCrossTabCell {
  count: number
  row_pct: number
  col_pct: number
  total_pct: number
}

export interface ChiSquareResult {
  statistic: number
  p_value: number
  df: number
  cramers_v: number
}

export interface AnalysisCrossTabResponse {
  row_values: string[]
  col_values: string[]
  matrix: AnalysisCrossTabCell[][]
  row_totals: number[]
  col_totals: number[]
  n_shared: number
  row_column_label: string
  col_column_label: string
  chi_square: ChiSquareResult | null
}

// Record matrix types
export interface MatrixColumnInfo {
  metric_id: number
  label: string
  metric_type: string
}

export interface MatrixRowItem {
  dataset_row_id: number
  row_identifier: string | null
  dataset_name: string | null
  scores: Record<string, number | null>
}

export interface RowMatrixResponse {
  columns: MatrixColumnInfo[]
  rows: MatrixRowItem[]
}

// API functions - Metrics
export const metricsApi = {
  list: (projectId: number) =>
    api.get<MetricListResponse>(`/projects/${projectId}/metrics`).then(res => res.data),
  computeAll: (projectId: number, staleOnly = false) =>
    api.post<ComputeAllResponse>(`/projects/${projectId}/metrics/compute-all`, { stale_only: staleOnly }).then(res => res.data),
  create: (projectId: number, data: {
    name: string
    metric_type: string
    config: Record<string, unknown>
    input_source_type: string
    input_source_id: number
    description?: string | null
    grouping_column_id?: number | null
    exclude_values?: string[] | null
    sequence_order?: number
  }) =>
    api.post<MetricDefinitionResponse>(`/projects/${projectId}/metrics`, data).then(res => res.data),
  update: (projectId: number, metricId: number, data: Record<string, unknown>) =>
    api.patch<MetricDefinitionResponse>(`/projects/${projectId}/metrics/${metricId}`, data).then(res => res.data),
  delete: (projectId: number, metricId: number) =>
    api.delete(`/projects/${projectId}/metrics/${metricId}`).then(res => res.data),
  bulkCreate: (projectId: number, data: { metrics: Array<{
    name: string
    metric_type: string
    config: Record<string, unknown>
    input_source_type: string
    input_source_id: number
    description?: string | null
    grouping_column_id?: number | null
    exclude_values?: string[] | null
  }> }) =>
    api.post<{ created: number; metrics: MetricDefinitionResponse[] }>(`/projects/${projectId}/metrics/bulk`, data).then(res => res.data),
  reorder: (projectId: number, metricIds: number[]) =>
    api.post(`/projects/${projectId}/metrics/reorder`, { metric_ids: metricIds }).then(res => res.data),
  quickCompute: (projectId: number, data: QuickComputeRequest, signal?: AbortSignal) =>
    api.post<QuickComputeResponse>(`/projects/${projectId}/metrics/quick-compute`, data, { signal }).then(res => res.data),
  analysisColumns: (projectId: number) =>
    api.get<AnalysisColumnsResponse>(`/projects/${projectId}/metrics/analysis-columns`).then(res => res.data),
  crossTabulation: (projectId: number, data: {
    row_column_id: number
    col_column_id: number
    include_chi_square?: boolean
  }) =>
    api.post<AnalysisCrossTabResponse>(`/projects/${projectId}/metrics/cross-tabulation`, data).then(res => res.data),
  rowMatrix: (projectId: number, metricIds?: number[], format: 'json' | 'csv' = 'json') => {
    const paramStr = metricIds?.length ? `?metric_ids=${metricIds.join(',')}` : ''
    if (format === 'csv') {
      return downloadFromApi(`/projects/${projectId}/metrics/row-matrix/csv${paramStr}`, 'row_matrix.csv')
    }
    return api.get<RowMatrixResponse>(`/projects/${projectId}/metrics/row-matrix`, {
      params: metricIds?.length ? { metric_ids: metricIds.join(',') } : undefined,
    }).then(res => res.data)
  },
}
