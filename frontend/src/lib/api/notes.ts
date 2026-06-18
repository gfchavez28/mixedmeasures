import api from './client'

// Note types (for segment-attached notes)
export interface Note {
  id: number
  conversation_id: number
  segment_id: number | null
  excerpt_id: number | null
  content: string
  sequence_number: number
  is_archived: boolean
  created_at: string
  updated_at: string
}

// All-Notes hierarchy types
export interface AllNotesConvNote {
  id: number
  content: string
  sequence_number: number
  segment_id: number | null
  segment_text: string | null
  created_at: string
}

export interface AllNotesSpeaker {
  speaker_id: number | null
  speaker_name: string
  notes: AllNotesConvNote[]
}

export interface AllNotesConversation {
  conversation_id: number
  conversation_name: string
  general_notes: AllNotesConvNote[]
  speakers: AllNotesSpeaker[]
}

export interface AllNotesCommentNote {
  id: number
  content: string
  sequence_number: number
  dataset_value_id: number
  source_text: string | null
  created_at: string
}

export interface AllNotesRow {
  dataset_row_id: number
  row_label: string
  notes: AllNotesCommentNote[]
}

export interface AllNotesColumn {
  column_id: number
  column_name: string | null
  column_text: string
  rows: AllNotesRow[]
}

export interface AllNotesDocNote {
  id: number
  content: string
  sequence_number: number
  segment_id: number | null
  segment_text: string | null
  created_at: string
}

export interface AllNotesDocument {
  document_id: number
  document_name: string
  notes: AllNotesDocNote[]
}

export interface AllNotesResponse {
  conversations: AllNotesConversation[]
  texts: AllNotesColumn[]
  documents: AllNotesDocument[]
}

// API functions - Notes
export const notesApi = {
  listForConversation: (conversationId: number, includeArchived = false) =>
    api.get<{ notes: Note[]; total: number }>(`/conversations/${conversationId}/notes`, {
      params: { include_archived: includeArchived },
    }).then(res => res.data),
  create: (conversationId: number, data: { content: string; segment_id?: number; excerpt_id?: number }) =>
    api.post<Note>(`/conversations/${conversationId}/notes`, data).then(res => res.data),
  update: (projectId: number, noteId: number, data: { content?: string; segment_id?: number }) =>
    api.patch<Note>(`/projects/${projectId}/notes/${noteId}`, data).then(res => res.data),
  archive: (projectId: number, noteId: number, permanent = false) =>
    api.delete(`/projects/${projectId}/notes/${noteId}`, { params: { permanent } }).then(res => res.data),

  restore: (projectId: number, noteId: number) =>
    api.patch<Note>(`/projects/${projectId}/notes/${noteId}`, { is_archived: false }).then(res => res.data),
}

// API functions - All Notes
export const allNotesApi = {
  list: (projectId: number, search?: string, includeArchived = false) =>
    api.get<AllNotesResponse>(`/projects/${projectId}/all-notes`, {
      params: { ...(search ? { search } : {}), include_archived: includeArchived },
    }).then(res => res.data),
}
