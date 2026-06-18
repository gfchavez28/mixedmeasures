import api from './client'

// Excerpt types
export interface ExcerptNoteInfo {
  id: number
  content: string
  created_at: string
}

export interface ExcerptResponse {
  id: number
  segment_id: number | null
  dataset_value_id: number | null
  start_offset: number | null
  end_offset: number | null
  excerpt_text: string
  conversation_id: number | null
  conversation_name: string | null
  speaker_name: string | null
  segment_timestamp: number | null
  note: ExcerptNoteInfo | null
  has_note: boolean
  created_at: string
}

export interface ExcerptDetailResponse extends ExcerptResponse {
  context_before: string | null
  context_after: string | null
  segment_text: string | null
}

export interface QuotedExcerptCode {
  id: number
  name: string
  color: string | null
  category_id: number | null
  category_name: string | null
  category_color: string | null
}

export interface QuotedExcerptItem {
  excerpt_id: number
  source_type: 'segment' | 'text'
  segment_id: number | null
  dataset_value_id: number | null
  text: string
  full_segment_text: string
  is_sub_segment: boolean
  start_offset: number | null
  end_offset: number | null
  speaker_name: string | null
  speaker_is_facilitator: boolean
  participant_id: number | null
  participant_name: string | null
  source_name: string
  sequence_order: number | null
  conversation_id: number | null
  conversation_date: string | null
  conversation_sort_key: number | null
  document_id: number | null
  document_name: string | null
  dataset_id: number | null
  dataset_name: string | null
  column_id: number | null
  column_name: string | null
  applied_code_ids: number[]
  applied_codes: QuotedExcerptCode[]
  excerpt_note: string | null
  context_before: string | null
  context_before_speaker: string | null
  created_at: string
}

export interface QuotedExcerptsResponse {
  excerpts: QuotedExcerptItem[]
  total_excerpts: number
  total_conversation_excerpts: number
  total_comment_excerpts: number
  total_document_excerpts: number
}

export interface QuotedExcerptsParams {
  source?: string
  code_ids?: string
  conversation_ids?: string
  text_column_ids?: string
  document_ids?: string
  exclude_facilitator?: boolean
  participant_ids?: string
}

// API functions - Excerpts
export const excerptsApi = {
  list: (projectId: number, params?: { conversation_id?: number; has_note?: boolean; search?: string; speaker?: string }) =>
    api.get<{ excerpts: ExcerptResponse[]; total: number }>(`/projects/${projectId}/excerpts`, { params }).then(res => res.data),
  create: (projectId: number, data: { segment_id?: number; dataset_value_id?: number; start_offset?: number | null; end_offset?: number | null }) =>
    api.post<ExcerptResponse>(`/projects/${projectId}/excerpts`, data).then(res => res.data),
  bulkCreate: (projectId: number, items: { segment_id?: number; dataset_value_id?: number; start_offset?: number | null; end_offset?: number | null }[]) =>
    api.post<{ created_count: number; skipped_count: number }>(`/projects/${projectId}/excerpts/bulk`, { items }).then(res => res.data),
  delete: (projectId: number, excerptId: number) =>
    api.delete(`/projects/${projectId}/excerpts/${excerptId}`).then(res => res.data),
  get: (projectId: number, excerptId: number) =>
    api.get<ExcerptDetailResponse>(`/projects/${projectId}/excerpts/${excerptId}`).then(res => res.data),
  listQuoted: (projectId: number, params?: QuotedExcerptsParams) =>
    api.get<QuotedExcerptsResponse>(`/projects/${projectId}/excerpts/starred`, { params }).then(res => res.data),
  exportCsv: (projectId: number) =>
    api.get(`/projects/${projectId}/excerpts/export`, { responseType: 'blob' }).then(res => {
      const blob = new Blob([res.data], { type: 'text/csv' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'excerpts.csv'
      a.click()
      URL.revokeObjectURL(url)
    }),
}
