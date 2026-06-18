import api from './client'

// Code Analysis types
export interface CodeFrequencyItem {
  code_id: number
  code_name: string
  code_color: string | null
  is_universal: boolean
  category_id: number | null
  category_name: string | null
  category_color: string | null
  segment_count: number
  segment_percentage: number
  conversation_count: number
  conversation_percentage: number
  participant_count: number
  participant_percentage: number
  text_count: number
  text_percentage: number
  row_count: number
  row_percentage: number
}

export interface CodeFrequencySummary {
  frequencies: CodeFrequencyItem[]
  total_coded_segments: number
  total_conversations: number
  total_participants: number
  total_codes_active: number
  unlinked_speaker_count: number
  total_coded_texts: number
  total_rows: number
  source: string
}

export interface ContextSegment {
  id: number
  sequence_order: number
  speaker_name: string | null
  speaker_color_index: number
  speaker_color: string | null
  is_facilitator: boolean
  text: string
  start_time: number | null
}

export interface CodedSegmentWithContext {
  id: number
  sequence_order: number
  speaker_name: string | null
  speaker_color_index: number
  speaker_color: string | null
  is_facilitator: boolean
  text: string
  start_time: number | null
  is_quoted: boolean
  applied_code_ids: number[]
  preceding_context: ContextSegment[]
  following_context: ContextSegment[]
  participant_id: number | null
  participant_name: string | null
}

export interface ConversationSegmentGroup {
  conversation_id: number
  conversation_name: string
  segment_count: number
  segments: CodedSegmentWithContext[]
}

export interface DocumentSegmentGroup {
  document_id: number
  document_name: string
  segment_count: number
  segments: CodedSegmentWithContext[]
}

export interface CodeSegmentsWithContextResponse {
  code_id: number
  code_name: string
  code_color: string | null
  category_name: string | null
  total_segments: number
  has_more: boolean
  conversations: ConversationSegmentGroup[]
  documents: DocumentSegmentGroup[]
}

export interface DemographicFilterValue {
  value: string
  participant_ids: number[]
  count: number
}

export interface DemographicFilter {
  subtype: string
  label: string
  values: DemographicFilterValue[]
}

export interface ConversationOption {
  id: number
  name: string
}

export interface DemographicFilterOptionsResponse {
  filters: DemographicFilter[]
  conversations: ConversationOption[]
}

export interface CooccurrenceCodeInfo {
  id: number
  name: string
  color: string | null
  category_name: string | null
  category_color?: string | null
  is_universal: boolean
}

export interface CooccurrenceMatrixResponse {
  codes: CooccurrenceCodeInfo[]
  matrix: number[][]
  max_cooccurrence: number
  total_coded_segments: number
  total_coded_texts: number
  source: string
}

// Coded texts (QualitativeAnalysisView Examples tab)
export interface CodedTextInfo {
  dataset_value_id: number
  value_text: string
  word_count: number
  row_identifier: string | null
  dataset_name: string
  column_name: string
  applied_code_ids: number[]
}

export interface DatasetTextGroup {
  dataset_id: number
  dataset_name: string
  text_count: number
  texts: CodedTextInfo[]
}

export interface CodeTextsResponse {
  code_id: number
  code_name: string
  code_color: string | null
  category_name: string | null
  total_texts: number
  has_more: boolean
  datasets: DatasetTextGroup[]
}

export interface CodeAnalysisFilterParams {
  code_ids?: string
  exclude_facilitator?: boolean
  conversation_ids?: string
  participant_ids?: string
  text_column_ids?: string
  document_ids?: string
  source?: 'conversations' | 'text' | 'all'
  level?: 'segment' | 'source'
}

// Source Frequencies
export interface SourceFrequenciesRequest {
  code_ids?: number[] | null
  conversation_ids?: number[] | null
  text_column_ids?: number[] | null
  document_ids?: number[] | null
  exclude_facilitator?: boolean
  participant_ids?: number[] | null
  group_by_subtype?: string | null
  aggregation?: 'code' | 'category'
}

export interface CodeCountEntry {
  count: number
  word_count: number
}

export interface SourceGroupData {
  total_segments: number
  total_word_count: number
  coded_segments: number
  code_counts: Record<string, CodeCountEntry>
}

export interface SourceEntry {
  source_type: 'conversation' | 'text_column' | 'document'
  source_id: number
  source_label: string
  dataset_id: number | null
  dataset_name: string | null
  total_segments: number
  total_word_count: number
  coded_segments: number
  import_order: number | null
  code_counts: Record<string, CodeCountEntry> | null
  groups: Record<string, SourceGroupData> | null
}

export interface SourceFrequenciesTotals {
  total_segments: number
  total_word_count: number
  coded_segments: number
  total_sources: number
  total_conversations: number
  total_documents: number
  total_text_columns: number
}

export interface CodeInfo {
  id: number
  name: string
  color: string | null
  category_id: number | null
  category_name: string | null
  category_color?: string | null
  is_universal: boolean
  numeric_id: number
}

export interface SourceFrequenciesResponse {
  codes: CodeInfo[]
  sources: SourceEntry[]
  totals: SourceFrequenciesTotals
  group_by: string | null
}

// Demographic Comparison
export interface DemographicComparisonRequest {
  code_ids?: number[] | null
  group_by_subtype: string
  conversation_ids?: number[] | null
  text_column_ids?: number[] | null
  exclude_facilitator?: boolean
  participant_ids?: number[] | null
}

export interface GroupTotal {
  total_segments: number
  total_word_count: number
}

export interface GroupCodeStats {
  count: number
  proportion: number
}

export interface StatTestResult {
  method: string
  statistic: number | null
  p_value: number
  significant: boolean
  effect_size: number | null
  effect_size_label: string | null
}

export interface CodeComparisonEntry {
  code_id: number
  code_name: string
  category_name: string | null
  by_group: Record<string, GroupCodeStats>
  delta_proportion: number | null
  test: StatTestResult | null
}

export interface DemographicComparisonResponse {
  groups: string[]
  group_totals: Record<string, GroupTotal>
  codes: CodeComparisonEntry[]
}

// Saturation
export interface SaturationPoint {
  source_index: number
  source_label: string
  source_type: string
  cumulative_unique_codes: number
  new_codes_this_source: number
  new_code_names: string[]
}

export interface SaturationResponse {
  points: SaturationPoint[]
  total_unique_codes: number
  total_sources: number
  category_level: boolean
}

// Text columns
export interface TextColumnInfo {
  column_id: number
  column_name: string | null
  column_text: string
  dataset_id: number
  dataset_name: string
  coded_count: number
}

// API functions - Code Analysis
export const codeAnalysisApi = {
  frequencies: (projectId: number, params?: CodeAnalysisFilterParams) =>
    api.get<CodeFrequencySummary>(`/projects/${projectId}/code-analysis/frequencies`, { params }).then(r => r.data),

  segmentsWithContext: (projectId: number, codeId: number, params?: CodeAnalysisFilterParams & {
    context_size?: number
    limit?: number
    offset?: number
  }) =>
    api.get<CodeSegmentsWithContextResponse>(
      `/projects/${projectId}/code-analysis/codes/${codeId}/segments`, { params }
    ).then(r => r.data),

  demographicFilters: (projectId: number) =>
    api.get<DemographicFilterOptionsResponse>(`/projects/${projectId}/code-analysis/demographic-filters`).then(r => r.data),

  textsWithContext: (projectId: number, codeId: number, params?: {
    participant_ids?: string
    text_column_ids?: string
    limit?: number
    offset?: number
  }) =>
    api.get<CodeTextsResponse>(
      `/projects/${projectId}/code-analysis/codes/${codeId}/texts`, { params }
    ).then(r => r.data),

  cooccurrence: (projectId: number, params?: CodeAnalysisFilterParams) =>
    api.get<CooccurrenceMatrixResponse>(`/projects/${projectId}/code-analysis/cooccurrence`, { params }).then(r => r.data),

  sourceFrequencies: (projectId: number, data: SourceFrequenciesRequest) =>
    api.post<SourceFrequenciesResponse>(`/projects/${projectId}/code-analysis/source-frequencies`, data)
      .then(r => r.data),

  demographicComparison: (projectId: number, data: DemographicComparisonRequest) =>
    api.post<DemographicComparisonResponse>(`/projects/${projectId}/code-analysis/demographic-comparison`, data)
      .then(r => r.data),

  saturation: (projectId: number, params?: { exclude_facilitator?: boolean; category_level?: boolean; conversation_ids?: string; document_ids?: string }) =>
    api.get<SaturationResponse>(`/projects/${projectId}/code-analysis/saturation`, { params })
      .then(r => r.data),

  textColumnsWithCoding: (projectId: number) =>
    api.get<TextColumnInfo[]>(`/projects/${projectId}/code-analysis/text-columns`)
      .then(r => r.data),
}
