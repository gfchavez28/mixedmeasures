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
// Track J · J2 slab 3b — `layer_scope` ('human' default | 'consensus') selects the coder layer.
export type LayerScope = 'human' | 'consensus'

export const textAnalysisApi = {
  filteredFrequencies: (pid: number, data: { column_ids: number[]; filters: SubgroupFilter[]; include_overall: boolean; coder_ids?: number[] | null; layer_scope?: LayerScope }) =>
    api.post<FilteredFrequenciesResponse>(`/projects/${pid}/text-analysis/filtered-frequencies`, data).then(r => r.data),

  crossTabulation: (pid: number, data: { text_column_ids: number[]; cross_column_id: number; code_ids?: number[]; coder_ids?: number[] | null; layer_scope?: LayerScope }) =>
    api.post<CrossTabulationResponse>(`/projects/${pid}/text-analysis/cross-tabulation`, data).then(r => r.data),

  codeDensity: (pid: number, params: { column_ids: string; group_by_column_id?: number; coder_ids?: string; layer_scope?: LayerScope }) =>
    api.get<CodeDensityResponse>(`/projects/${pid}/text-analysis/code-density`, { params }).then(r => r.data),

  responseLength: (pid: number, params: { column_ids: string; coder_ids?: string; layer_scope?: LayerScope }) =>
    api.get<ResponseLengthResponse>(`/projects/${pid}/text-analysis/response-length-by-code`, { params }).then(r => r.data),

  exportCrossAnalysis: (pid: number, params: { column_ids: string; filters?: string; cross_column_id?: number; coder_ids?: string; layer_scope?: LayerScope }) => {
    const searchParams = new URLSearchParams()
    searchParams.append('column_ids', params.column_ids)
    if (params.filters) searchParams.append('filters', params.filters)
    if (params.cross_column_id) searchParams.append('cross_column_id', String(params.cross_column_id))
    if (params.coder_ids) searchParams.append('coder_ids', params.coder_ids)
    if (params.layer_scope) searchParams.append('layer_scope', params.layer_scope)
    const qs = searchParams.toString()
    return downloadFromApi(`/projects/${pid}/text-analysis/export?${qs}`, 'text-analysis.csv')
  },
}
