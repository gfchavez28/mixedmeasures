import api from './client'

// Search types
export interface SegmentSearchResult {
  id: number
  // #569 deprecation pair: conversation_id is overloaded with the document id on
  // doc hits (one-release beat) and null on observation hits; source_type is the
  // deprecated alias of source_kind. New consumers read source_kind + source_id.
  conversation_id: number | null
  conversation_name: string
  speaker_name: string | null
  is_facilitator: boolean
  start_time: number | null // clip hits: the clip's start (timecode subtitle)
  text: string
  sequence_order: number
  is_quoted: boolean
  source_type?: string // deprecated alias of source_kind
  source_kind?: string // "conversation" | "document" | "observation"
  source_id?: number | null // the id in source_kind's namespace — the honest pair
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
  // Nullable since 4b (#569): observation notes carry null; conv/doc hits keep
  // the (doc-overloaded) id one release. New consumers read source_kind + source_id.
  conversation_id: number | null
  conversation_name: string
  segment_id: number | null
  segment_text_preview: string | null
  content: string
  sequence_number: number
  source_type?: string // deprecated alias of source_kind
  source_kind?: string // "conversation" | "document" | "observation"
  source_id?: number | null // the id in source_kind's namespace — the honest pair
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

export interface ObservationSearchResult {
  // Observation NAME hit (the 4th name block, slab 4b). UI consumption = 4e.
  id: number
  name: string
  segment_count: number // visible clip count
  has_media: boolean
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
  observations?: SearchResults<ObservationSearchResult>
  text?: SearchResults<TextSearchResult>
  canvases?: SearchResults<CanvasSearchResult>
}

export type SearchEntityType = 'segments' | 'codes' | 'conversations' | 'notes' | 'memos' | 'documents' | 'observations' | 'text' | 'canvases'

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
