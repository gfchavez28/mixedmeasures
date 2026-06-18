import api from './client'

// Conversation types (formerly Interview)
export interface Conversation {
  id: number
  project_id: number
  name: string
  subject_id: string | null
  conversation_date: string | null
  status: 'imported' | 'in_progress' | 'completed'
  summary: string | null
  created_at: string
  updated_at: string
  segment_count: number
  coded_segment_count: number
  speaker_count: number
  code_count: number
  // Media fields (E3 audio playback)
  media_filename: string | null
  media_format: string | null
  media_type: 'audio' | 'video' | null
  media_duration_seconds: number | null
  media_offset_seconds: number
  media_is_vbr: boolean | null
  has_audio: boolean
}

/** #356: import endpoint returns the imported conversation + any import-time
 * warnings (e.g. backward timestamps). Read endpoints continue to return bare
 * Conversation — warnings only surface at import time. */
export interface ConversationImportResponse {
  conversation: Conversation
  warnings: string[]
}

// API functions - Conversations
export const conversationsApi = {
  list: (projectId: number) =>
    api.get<{ conversations: Conversation[]; total: number }>(`/projects/${projectId}/conversations`).then(res => res.data),
  get: (projectId: number, id: number) =>
    api.get<Conversation>(`/projects/${projectId}/conversations/${id}`).then(res => res.data),
  preview: (projectId: number, file: File, encoding = 'utf-8') => {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('encoding', encoding)
    return api.post<{
      headers: string[]
      sample_rows: Record<string, string>[]
      total_rows: number
      unique_speakers: string[]
      detected_columns: Record<string, string>
      unique_values_by_column: Record<string, string[]>
    }>(`/projects/${projectId}/conversations/preview`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then(res => res.data)
  },
  import: (projectId: number, file: File, config: object) => {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('import_config', JSON.stringify(config))
    return api.post<ConversationImportResponse>(`/projects/${projectId}/conversations/import`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then(res => res.data)
  },
  update: (projectId: number, id: number, data: Partial<Conversation>) =>
    api.patch<Conversation>(`/projects/${projectId}/conversations/${id}`, data).then(res => res.data),
  delete: (projectId: number, id: number) =>
    api.delete(`/projects/${projectId}/conversations/${id}`).then(res => res.data),
}
