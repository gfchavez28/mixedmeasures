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
// Track J · J2 slab 3b — `layer_scope` selects the coder layer. 🔴 The type is
// single-sourced in `lib/coding-layers.ts` (#989): it was restated as an inline
// union here and at FIVE more places in `code-analysis.ts`, so adding the machine
// layer meant finding every one of them. Re-exported so existing importers of
// `LayerScope` from this module are unchanged.
export type { LayerScope } from '@/lib/coding-layers'
import type { LayerScope } from '@/lib/coding-layers'

/**
 * #1615 — `ratings_follow_coder_ids` is sent ONLY while blind mode withholds (D273, D102's
 * shape): the panel's `coder_ids` is also a lead's coder FILTER, so the server treats it as the
 * blind scope only with the flag, and then refuses a filter, cross-tab or density grouping on a
 * variable worked out from participant scores (409, with the sentence the panel prints).
 */
export interface RatingsFollowCoderIds { ratings_follow_coder_ids?: boolean }

export const textAnalysisApi = {
  filteredFrequencies: (pid: number, data: { column_ids: number[]; filters: SubgroupFilter[]; include_overall: boolean; coder_ids?: number[] | null; layer_scope?: LayerScope } & RatingsFollowCoderIds) =>
    api.post<FilteredFrequenciesResponse>(`/projects/${pid}/text-analysis/filtered-frequencies`, data).then(r => r.data),

  crossTabulation: (pid: number, data: { text_column_ids: number[]; cross_column_id: number; code_ids?: number[]; coder_ids?: number[] | null; layer_scope?: LayerScope } & RatingsFollowCoderIds) =>
    api.post<CrossTabulationResponse>(`/projects/${pid}/text-analysis/cross-tabulation`, data).then(r => r.data),

  codeDensity: (pid: number, params: { column_ids: string; group_by_column_id?: number; coder_ids?: string; layer_scope?: LayerScope } & RatingsFollowCoderIds) =>
    api.get<CodeDensityResponse>(`/projects/${pid}/text-analysis/code-density`, { params }).then(r => r.data),

  responseLength: (pid: number, params: { column_ids: string; coder_ids?: string; layer_scope?: LayerScope }) =>
    api.get<ResponseLengthResponse>(`/projects/${pid}/text-analysis/response-length-by-code`, { params }).then(r => r.data),

  /**
   * 🔴 #1534 (1.5.9): the route reads `filters_json`. This sent `filters` from the day it was
   * written (2026-02-19), FastAPI dropped it without a word, and no release's Cross-analysis
   * CSV ever applied the panel's filters. `request-contract.test.ts` (D110) now holds every
   * request's names to the routes' declared ones.
   */
  exportCrossAnalysis: (pid: number, params: { column_ids: string; filters_json?: string; coder_ids?: string; layer_scope?: LayerScope } & RatingsFollowCoderIds) => {
    const searchParams = new URLSearchParams()
    searchParams.append('column_ids', params.column_ids)
    if (params.filters_json) searchParams.append('filters_json', params.filters_json)
    if (params.coder_ids) searchParams.append('coder_ids', params.coder_ids)
    if (params.layer_scope) searchParams.append('layer_scope', params.layer_scope)
    if (params.ratings_follow_coder_ids) searchParams.append('ratings_follow_coder_ids', 'true')  // #1615
    const qs = searchParams.toString()
    return downloadFromApi(`/projects/${pid}/text-analysis/export?${qs}`, 'text-analysis.csv')
  },
}
