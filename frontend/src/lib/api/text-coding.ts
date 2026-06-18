import api from './client'
import { downloadFromApi } from './download'

// Text Coding types
export interface TextQueryParams {
  column_ids: string
  dataset_ids?: string
  hide_empty?: boolean
  record_id?: number
  search?: string
  sort_by?: string
  random_seed?: number
  quoted_only?: boolean
}

export interface TextCodingResponse {
  dataset_value_id: number
  dataset_id: number
  dataset_name: string
  dataset_row_id: number
  row_identifier: string | null
  participant_id: number | null
  participant_name: string | null
  column_id: number
  column_name: string | null
  column_text: string
  column_sequence_order: number
  value_text: string | null
  word_count: number
  is_quoted: boolean
  excerpt_id: number | null
  applied_code_ids: number[]
  note_count: number
}

export interface TextCodingListResponse {
  texts: TextCodingResponse[]
  total_texts: number
  non_empty_texts: number
  coded_texts: number
  total_rows: number
  coded_rows: number
}

export interface TextCodingRecord {
  dataset_row_id: number
  row_identifier: string | null
  participant_id: number | null
  participant_name: string | null
  dataset_id: number
  dataset_name: string
  text_count: number
  coded_text_count: number
  linked_conversation_ids: number[]
}

export interface RecordsListResponse {
  records: TextCodingRecord[]
  total: number
}

export interface RecordContext {
  row_identifier: string | null
  participant_id: number | null
  dataset_id: number
  dataset_name: string
  linked_conversations: { id: number; name: string }[]
  demographics: { column_id: number; column_name: string | null; value: string | null }[]
  texts: { column_id: number; column_name: string | null; value: string | null; sequence_order: number }[]
  other_columns: { column_id: number; column_name: string | null; value: string | null; column_type: string; sequence_order: number }[]
  column_positions: { column_id: number; column_name: string | null; sequence_order: number; column_type: string }[]
}

export interface TextCodingColumn {
  column_id: number
  dataset_id: number
  dataset_name: string
  column_name: string | null
  column_text: string
  column_type: string
  sequence_order: number
  total_rows: number
  non_empty_rows: number
  coded_rows: number
}

export interface CodingProgress {
  by_column: { column_id: number; column_name: string | null; coded: number; total: number }[]
  overall_texts: { coded: number; total: number }
  overall_records: { coded: number; total: number }
}

export interface TextCodingViewConfig {
  view_mode: string
  focal_column_ids: number[]
  dataset_filter_ids: number[] | null
  random_seed: number | null
  context_visibility: Record<string, boolean>
  hide_empty: boolean
  starred_value_ids: number[]
  treat_as_empty: string[]
}

// API functions - Text Coding
export const textCodingApi = {
  // Data
  columns: (pid: number) =>
    api.get<{ columns: TextCodingColumn[] }>(`/projects/${pid}/text-coding/text-columns`).then(r => r.data),
  list: (pid: number, params: TextQueryParams) =>
    api.get<TextCodingListResponse>(`/projects/${pid}/text-coding/texts`, { params }).then(r => r.data),
  records: (pid: number, params: { column_ids: string; dataset_ids?: string; hide_empty?: boolean }) =>
    api.get<RecordsListResponse>(`/projects/${pid}/text-coding/records`, { params }).then(r => r.data),
  recordContext: (pid: number, rowId: number) =>
    api.get<RecordContext>(`/projects/${pid}/text-coding/record-context/${rowId}`).then(r => r.data),
  progress: (pid: number, params?: { column_ids?: string }) =>
    api.get<CodingProgress>(`/projects/${pid}/text-coding/coding-progress`, { params }).then(r => r.data),

  // Coding
  applyCode: (pid: number, data: { dataset_value_id: number; code_id: number }) =>
    api.post(`/projects/${pid}/text-coding/code`, data).then(r => r.data),
  removeCode: (pid: number, params: { dataset_value_id: number; code_id: number }) =>
    api.delete(`/projects/${pid}/text-coding/code`, { params }).then(r => r.data),
  bulkCode: (pid: number, data: { dataset_value_ids: number[]; code_id: number }) =>
    api.post(`/projects/${pid}/text-coding/bulk-code`, data).then(r => r.data),
  bulkRemoveCode: (pid: number, data: { dataset_value_ids: number[]; code_id: number }) =>
    api.post(`/projects/${pid}/text-coding/bulk-remove-code`, data).then(r => r.data),

  // Notes
  listNotes: (pid: number, params: { dataset_value_id?: number; column_ids?: string }) =>
    api.get(`/projects/${pid}/text-coding/notes`, { params }).then(r => r.data),
  createNote: (pid: number, data: { dataset_value_id: number; content: string }) =>
    api.post(`/projects/${pid}/text-coding/notes`, data).then(r => r.data),
  updateNote: (pid: number, noteId: number, data: { content?: string }) =>
    api.patch(`/projects/${pid}/text-coding/notes/${noteId}`, data).then(r => r.data),
  deleteNote: (pid: number, noteId: number) =>
    api.delete(`/projects/${pid}/text-coding/notes/${noteId}`).then(r => r.data),

  // Config
  getConfig: (pid: number) =>
    api.get<TextCodingViewConfig>(`/projects/${pid}/text-coding/config`).then(r => r.data),
  updateConfig: (pid: number, data: Partial<TextCodingViewConfig>) =>
    api.patch<TextCodingViewConfig>(`/projects/${pid}/text-coding/config`, data).then(r => r.data),

  // Export
  exportCoded: (pid: number, params?: { coded_only?: boolean; column_ids?: string }) => {
    const searchParams = new URLSearchParams()
    if (params?.coded_only) searchParams.append('coded_only', 'true')
    if (params?.column_ids) searchParams.append('column_ids', params.column_ids)
    const qs = searchParams.toString()
    return downloadFromApi(`/projects/${pid}/text-coding/export${qs ? '?' + qs : ''}`, 'text-coding.csv')
  },
}
