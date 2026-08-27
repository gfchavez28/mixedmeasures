import api from './client'

// Search types
export interface SegmentSearchResult {
  id: number
  // #569 RETIRED 2026-08-09 (the one-release beat ended at the cut after v1.3.0):
  // `conversation_id` — overloaded with the DOCUMENT id on doc hits — and
  // `source_type` are both GONE. `source_kind` + `source_id` is the honest pair and
  // the only way to identify a hit's source. Route via `lib/search-source.ts`;
  // never re-introduce an id field that means different things per kind.
  conversation_name: string // the SOURCE display name (conversation/document/observation)
  speaker_name: string | null
  is_facilitator: boolean
  start_time: number | null // clip hits: the clip's start (timecode subtitle)
  text: string
  sequence_order: number
  is_quoted: boolean
  source_kind: string // "conversation" | "document" | "observation"
  source_id: number | null // the id in source_kind's namespace
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
  // #569 RETIRED 2026-08-09 — see SegmentSearchResult above. `conversation_id` and
  // `source_type` are gone; `source_kind` + `source_id` identify the source.
  conversation_name: string // the SOURCE display name (conversation/document/observation)
  segment_id: number | null
  segment_text_preview: string | null
  content: string
  sequence_number: number
  source_kind: string // "conversation" | "document" | "observation"
  source_id: number | null // the id in source_kind's namespace
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
  /**
   * #834: the RECORD this text belongs to, and its dataset.
   *
   * `id` is the dataset_value_id and `row_identifier` is a human label, so
   * before these the client knew which text matched and had no way to address
   * the row — the hit could only navigate to the column. `dataset_name`
   * disambiguates identically-named open-text columns across datasets.
   */
  dataset_id: number
  dataset_name: string
  row_id: number
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
