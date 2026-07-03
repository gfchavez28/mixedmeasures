import api from './client'

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
  updateSegment: (conversationId: number, segmentId: number, data: { text?: string; speaker_id?: number }) =>
    api.patch<Segment>(`/conversations/${conversationId}/segments/${segmentId}`, data).then(res => res.data),
  split: (conversationId: number, ranges: { segment_id: number; start_offset: number; end_offset: number }[]) =>
    api.post<{ new_segments: Segment[]; deleted_segment_ids: number[] }>(
      `/conversations/${conversationId}/segments/split`,
      { ranges }
    ).then(res => res.data),
  unsplit: (conversationId: number, segmentId: number) =>
    api.post<{ restored_segment: Segment; deleted_count: number }>(
      `/conversations/${conversationId}/segments/${segmentId}/unsplit`
    ).then(res => res.data),
}
