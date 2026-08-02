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
  /** Absolute TIMELINE seconds — the time-range shape (observation clips only,
   * slab 5a/D29). Never clip-relative: a clip boundary edit must not re-anchor
   * the quote. Both-or-neither with `end_time`, and mutually exclusive with the
   * char offsets — read the shape through `lib/excerpt-shape.ts`, never a bare
   * `start_offset === null` (that predicate matches TWO shapes now). */
  start_time: number | null
  end_time: number | null
  excerpt_text: string
  conversation_id: number | null
  conversation_name: string | null
  observation_id: number | null
  observation_name: string | null
  speaker_name: string | null
  segment_timestamp: number | null
  note: ExcerptNoteInfo | null
  has_note: boolean
  created_at: string
}

/** The create payload, named rather than re-inlined — slab 5b widened it for
 * the time shape, and three call sites had each carried their own copy. */
export interface ExcerptCreatePayload {
  segment_id?: number
  dataset_value_id?: number
  start_offset?: number | null
  end_offset?: number | null
  start_time?: number | null
  end_time?: number | null
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
  /** char-shape only — deliberately NOT overloaded to mean "time-range"
   * (the #569 type-overloading lesson). Renderers branch on the shape helpers. */
  is_sub_segment: boolean
  start_offset: number | null
  end_offset: number | null
  start_time: number | null
  end_time: number | null
  /** The SEGMENT's own span — a different question from the two above, which
   * are the EXCERPT's. A whole-clip quote has no range of its own, so this is
   * the only timecode a clip card can show for one. */
  segment_start_time: number | null
  segment_end_time: number | null
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
  observation_id: number | null
  observation_name: string | null
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
  total_observation_excerpts: number
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
  /** Single create — 400s on a shape/containment failure and 409s on a
   * duplicate. Use THIS (never `bulkCreate`) whenever the researcher must hear
   * why a quote was refused: bulk counts the same failures into `skipped_count`
   * inside a 200, so the reason never reaches the UI (§8j.6.3). */
  create: (projectId: number, data: ExcerptCreatePayload) =>
    api.post<ExcerptResponse>(`/projects/${projectId}/excerpts`, data).then(res => res.data),
  bulkCreate: (projectId: number, items: ExcerptCreatePayload[]) =>
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
