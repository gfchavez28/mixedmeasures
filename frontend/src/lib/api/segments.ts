import api from './client'

// ── Text edits and their quotes (#1319) ──────────────────────────────────────
// Mirrors `schemas/segment.py::TextEditPlanResponse`. Offsets are CODE POINTS
// (#687) and every quote carries its own words, so a client never slices.

/** What a text edit does to one char-range quote — the planner's four outcomes:
 *  followed automatically, or one of the three D5 shows before saving. */
export type TextEditOutcome = 'silent' | 'edge' | 'straddle' | 'gone'

export interface TextEditQuote {
  excerpt_id: number
  outcome: TextEditOutcome
  old_start: number
  old_end: number
  new_start: number | null
  new_end: number | null
  old_text: string
  new_text: string | null
  has_note: boolean
  /** Apply report only: this edit deleted the quote. */
  removed: boolean
  /** Apply report only: the request placed it (`excerpt_offsets`). */
  explicit: boolean
}

/** The preview's plan, or what an apply did. `text` is the text as STORED. */
export interface TextEditPlan {
  text: string
  quotes: TextEditQuote[]
  needs_confirmation: boolean
  /** Excerpt-id groups that would share one span if every flagged quote were kept. */
  collisions: number[][]
  /** The changed stretch was too long to follow word by word. */
  capped: boolean
}

export interface ExcerptOffsetsPayload {
  excerpt_id: number
  start_offset: number
  end_offset: number
}

/** The request's answer for the quotes a text edit cannot follow on its own. */
export interface TextEditAnswer {
  remove_excerpt_ids?: number[]
  excerpt_offsets?: ExcerptOffsetsPayload[]
}

// Segment types
export interface SegmentNoteInfo {
  id: number
  sequence_number: number
}

export interface SegmentExcerptInfo {
  id: number
  start_offset: number | null
  end_offset: number | null
  has_note: boolean
  note_id: number | null
  note_preview: string | null
}

// Per-application coder attribution (Track J · J1). Sibling to the bare
// applied_codes ID array, which stays for the optimistic-patch path.
export interface AppliedCodeDetail {
  code_id: number
  user_id: number | null
  attribution: string | null
  is_universal: boolean
  /**
   * #35 — this coder's rating on the code's declared scale, or null for UNRATED.
   *
   * ⚠️ Never coerce a null here to 0 anywhere downstream: on a scale whose range
   * includes zero, 0 is a legal and meaningful rating.
   *
   * REQUIRED since #868 (a): every payload builder carries it (the server declares
   * the field on every detail), and an optional type let a surface fabricate a
   * detail without it and render "not rated" over a rating it never received.
   */
  magnitude: number | null
  /**
   * #35 — the rating a MERGED copy of this same application carried when it
   * differed from ours (the merge kept ours and flagged the difference). Null =
   * no unresolved conflict; the coder clears it by rating again.
   */
  magnitude_conflict: number | null
}

export interface Segment {
  id: number
  conversation_id: number
  speaker_id: number | null
  speaker_name: string | null
  is_facilitator: boolean
  speaker_color_index: number
  speaker_color: string | null
  sequence_order: number
  start_time: number | null
  end_time: number | null
  text: string
  group_id: number | null
  excerpts: SegmentExcerptInfo[]
  applied_codes: number[]
  applied_code_details: AppliedCodeDetail[]
  attached_notes: SegmentNoteInfo[]
  is_merged: boolean  // True if this segment was created by merging (can be unmerged)
  is_split: boolean  // True if this segment was created by splitting (can be rejoined)
  created_at: string
}

// API functions - Segments
export const segmentsApi = {
  list: (conversationId: number) =>
    api.get<{
      segments: Segment[]
      total: number
      coded_count: number
      participant_total: number
      participant_coded: number
    }>(`/conversations/${conversationId}/segments`).then(res => res.data),
  get: (conversationId: number, id: number) =>
    api.get<Segment>(`/conversations/${conversationId}/segments/${id}`).then(res => res.data),
  updateSpeakerRole: (conversationId: number, segmentId: number, isFacilitator: boolean) =>
    api.patch<Segment>(`/conversations/${conversationId}/segments/${segmentId}/speaker`, { is_facilitator: isFacilitator }).then(res => res.data),
  createGroup: (conversationId: number, segmentIds: number[]) =>
    api.post(`/conversations/${conversationId}/segments/group`, { segment_ids: segmentIds }).then(res => res.data),
  deleteGroup: (conversationId: number, groupId: number) =>
    api.delete(`/conversations/${conversationId}/segments/group/${groupId}`).then(res => res.data),
  merge: (conversationId: number, segmentIds: number[]) =>
    api.post<{ merged_segment: Segment; deleted_count: number }>(
      `/conversations/${conversationId}/segments/merge`,
      { segment_ids: segmentIds }
    ).then(res => res.data),
  unmerge: (conversationId: number, segmentId: number) =>
    api.post<{ restored_segments: Segment[]; restored_count: number }>(
      `/conversations/${conversationId}/segments/${segmentId}/unmerge`
    ).then(res => res.data),
  /** A TEXT edit carries the turn's quotes (#1319): send the answer the preview's
   *  dialog produced, or the server refuses (409) an edit that moves a quote it was
   *  not told about. `quote_rebase` is null for a speaker-only change. */
  updateSegment: (
    conversationId: number,
    segmentId: number,
    data: { text?: string; speaker_id?: number } & TextEditAnswer,
  ) =>
    api.patch<Segment & { quote_rebase: TextEditPlan | null }>(
      `/conversations/${conversationId}/segments/${segmentId}`, data,
    ).then(res => res.data),
  /** #1319 — what saving `text` would do to the turn's quotes. Writes nothing. */
  previewTextEdit: (conversationId: number, segmentId: number, text: string) =>
    api.post<TextEditPlan>(
      `/conversations/${conversationId}/segments/${segmentId}/edit-preview`, { text },
    ).then(res => res.data),
  split: (conversationId: number, ranges: { segment_id: number; start_offset: number; end_offset: number }[]) =>
    api.post<{ new_segments: Segment[]; deleted_segment_ids: number[] ; quote_notes_stayed?: number }>(
      `/conversations/${conversationId}/segments/split`,
      { ranges }
    ).then(res => res.data),
  unsplit: (conversationId: number, segmentId: number) =>
    api.post<{ restored_segment: Segment; deleted_count: number }>(
      `/conversations/${conversationId}/segments/${segmentId}/unsplit`
    ).then(res => res.data),
}
