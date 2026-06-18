import api from './client'

// Search types
export interface SegmentSearchResult {
  id: number
  conversation_id: number
  conversation_name: string
  speaker_name: string | null
  is_facilitator: boolean
  start_time: number | null
  text: string
  sequence_order: number
  is_quoted: boolean
  source_type?: string // "conversation" or "document"
}

export interface CodeSearchResult {
  id: number
  numeric_id: number
  name: string
  description: string | null
  usage_count: number
  is_active: boolean
}

export interface ConversationSearchResult {
  id: number
  name: string
  subject_id: string | null
  conversation_date: string | null
  status: string
  summary: string | null
  segment_count: number
}

export interface NoteSearchResult {
  id: number
  conversation_id: number
  conversation_name: string
  segment_id: number | null
  segment_text_preview: string | null
  content: string
  sequence_number: number
  source_type?: string // "conversation" or "document"
}

export interface MemoSearchResult {
  id: number
  numeric_id: number
  entity_type: string
  entity_id: number
  entity_name: string | null
  title: string | null
  content: string
}

export interface DocumentSearchResult {
  id: number
  name: string
  segment_count: number
  source_format: string | null
}

export interface TextSearchResult {
  id: number // dataset_value_id
  value_text: string
  column_name: string
  column_id: number
  row_identifier: string | null
  is_quoted: boolean
  applied_code_count: number
}

export interface SearchResults<T> {
  count: number
  items: T[]
}

export interface CanvasSearchResult {
  id: number
  canvas_id: number
  canvas_name: string
  match_type: 'theme' | 'theme_content'
  match_text: string
  theme_id: number | null
  theme_name: string | null
}

export interface SearchResponse {
  query: string
  segments?: SearchResults<SegmentSearchResult>
  codes?: SearchResults<CodeSearchResult>
  conversations?: SearchResults<ConversationSearchResult>
  notes?: SearchResults<NoteSearchResult>
  memos?: SearchResults<MemoSearchResult>
  documents?: SearchResults<DocumentSearchResult>
  text?: SearchResults<TextSearchResult>
  canvases?: SearchResults<CanvasSearchResult>
}

export type SearchEntityType = 'segments' | 'codes' | 'conversations' | 'notes' | 'memos' | 'documents' | 'text' | 'canvases'

// API functions - Search
export const searchApi = {
  search: (
    projectId: number,
    query: string,
    types: SearchEntityType[] = ['segments', 'codes'],
    limit = 5,
    quoted?: boolean
  ) =>
    api.get<SearchResponse>(`/projects/${projectId}/search`, {
      params: { q: query, types: types.join(','), limit, ...(quoted !== undefined ? { quoted } : {}) },
    }).then(res => res.data),

  searchFullType: (projectId: number, query: string, type: SearchEntityType, quoted?: boolean) =>
    api.get<SearchResponse>(`/projects/${projectId}/search`, {
      params: { q: query, types: type, full_type: type, ...(quoted !== undefined ? { quoted } : {}) },
    }).then(res => res.data),
}
