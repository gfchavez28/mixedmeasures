import api from './client'
import { downloadFromApi } from './download'

// Text Analysis types
export interface SubgroupFilter {
  column_id: number
  operator: string
  values?: string[]
  value?: string
}

export interface CodeFrequencyBrief {
  code_id: number
  code_name: string
  code_color: string | null
  count: number
  percentage: number
}

export interface FrequencySet {
  row_count: number
  text_count: number
  frequencies: CodeFrequencyBrief[]
}

export interface FilteredFrequenciesResponse {
  filtered: FrequencySet
  overall: FrequencySet | null
  filter_description: string
  filter_scope: { filtered_datasets: string[]; unfiltered_datasets: string[] }
}

export interface CrossTabRow {
  code_id: number
  code_name: string
  code_color: string | null
  counts: Record<string, number>
  percentages: Record<string, number>
  row_total: number
}

export interface CrossTabulationResponse {
  cross_column_name: string
  response_values: string[]
  matrix: CrossTabRow[]
  column_totals: Record<string, number>
  total_coded_texts: number
}

export interface CodeDensityGroup {
  group_value: string
  avg_codes_per_text: number
  text_count: number
}

export interface CodeDensityResponse {
  groups: CodeDensityGroup[]
  overall: CodeDensityGroup
}

export interface ResponseLengthCode {
  code_id: number
  code_name: string
  code_color: string | null
  avg_words: number
  text_count: number
}

export interface ResponseLengthResponse {
  codes: ResponseLengthCode[]
  uncoded: { avg_words: number; text_count: number }
}

// API functions - Text Analysis
export const textAnalysisApi = {
  filteredFrequencies: (pid: number, data: { column_ids: number[]; filters: SubgroupFilter[]; include_overall: boolean }) =>
    api.post<FilteredFrequenciesResponse>(`/projects/${pid}/text-analysis/filtered-frequencies`, data).then(r => r.data),

  crossTabulation: (pid: number, data: { text_column_ids: number[]; cross_column_id: number; code_ids?: number[] }) =>
    api.post<CrossTabulationResponse>(`/projects/${pid}/text-analysis/cross-tabulation`, data).then(r => r.data),

  codeDensity: (pid: number, params: { column_ids: string; group_by_column_id?: number }) =>
    api.get<CodeDensityResponse>(`/projects/${pid}/text-analysis/code-density`, { params }).then(r => r.data),

  responseLength: (pid: number, params: { column_ids: string }) =>
    api.get<ResponseLengthResponse>(`/projects/${pid}/text-analysis/response-length-by-code`, { params }).then(r => r.data),

  exportCrossAnalysis: (pid: number, params: { column_ids: string; filters?: string; cross_column_id?: number }) => {
    const searchParams = new URLSearchParams()
    searchParams.append('column_ids', params.column_ids)
    if (params.filters) searchParams.append('filters', params.filters)
    if (params.cross_column_id) searchParams.append('cross_column_id', String(params.cross_column_id))
    const qs = searchParams.toString()
    return downloadFromApi(`/projects/${pid}/text-analysis/export?${qs}`, 'text-analysis.csv')
  },
}
