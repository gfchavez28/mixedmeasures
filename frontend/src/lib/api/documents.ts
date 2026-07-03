import api from './client'

export interface DocumentListItem {
  id: number
  name: string
  description: string | null
  source_format: string
  segmentation_mode: string
  segment_count: number
  coded_segment_count: number
  page_count: number | null
  created_at: string
  updated_at: string
}

export interface SegmentCodeResponse {
  id: number
  name: string
  color: string | null
  is_universal: boolean
  user_id: number | null  // coder who applied this code (Track J · J1)
}

export interface ExcerptInfo {
  has_whole_segment: boolean
  sub_segment_count: number
}

export interface DocumentSegmentResponse {
  id: number
  sequence_order: number
  text: string
  word_count: number | null
  page_number: number | null
  heading_level: number | null
  codes: SegmentCodeResponse[]
  has_note: boolean
  attached_notes: { id: number; sequence_number: number }[]
  excerpt_info: ExcerptInfo | null
  merged_into_id: number | null
  is_merge_result: number
  split_into_id: number | null
  is_split_result: number
}

export interface DocumentImagePosition {
  index: number
  after_sequence_order: number
}

export interface DocumentDetailResponse {
  id: number
  name: string
  description: string | null
  summary: string | null
  source_format: string
  segmentation_mode: string
  segment_count: number
  coded_segment_count: number
  page_count: number | null
  created_at: string
  updated_at: string
  segments: DocumentSegmentResponse[]
  image_positions: DocumentImagePosition[]
}

export interface DocumentImportResultItem {
  document_id: number | null
  name: string
  segment_count: number
  warnings: string[]
  error: string | null
}

export interface SegmentationPreviewSegment {
  sequence_order: number
  text: string
  page_number: number | null
  heading_level: number | null
  word_count: number
}

export interface SegmentationPreviewResponse {
  total_segments: number
  segments: SegmentationPreviewSegment[]
  warnings: string[]
}

export interface DocumentNote {
  id: number
  document_id: number
  segment_id: number | null
  content: string
  segment_sequence_order: number | null
  segment_text_snippet: string | null
  created_at: string
  updated_at: string
}

export const documentsApi = {
  list: (projectId: number) =>
    api.get<DocumentListItem[]>(`/projects/${projectId}/documents`).then(res => res.data),

  getDetail: (projectId: number, documentId: number) =>
    api.get<DocumentDetailResponse>(`/projects/${projectId}/documents/${documentId}`).then(res => res.data),

  uploadPreview: (projectId: number, file: File, segmentationMode: string) => {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('segmentation_mode', segmentationMode)
    return api.post<SegmentationPreviewResponse>(
      `/projects/${projectId}/documents/upload-preview`,
      formData,
      { headers: { 'Content-Type': 'multipart/form-data' } },
    ).then(res => res.data)
  },

  importDocument: (projectId: number, file: File, segmentationMode: string, name?: string) => {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('segmentation_mode', segmentationMode)
    if (name) formData.append('name', name)
    return api.post<DocumentImportResultItem>(
      `/projects/${projectId}/documents/import`,
      formData,
      { headers: { 'Content-Type': 'multipart/form-data' } },
    ).then(res => res.data)
  },

  update: (projectId: number, documentId: number, data: { name?: string; description?: string; summary?: string }) =>
    api.patch<DocumentListItem>(`/projects/${projectId}/documents/${documentId}`, data).then(res => res.data),

  remove: (projectId: number, documentId: number) =>
    api.delete(`/projects/${projectId}/documents/${documentId}`).then(res => res.data),

  updateSegment: (projectId: number, documentId: number, segmentId: number, data: { text: string }) =>
    api.patch(`/projects/${projectId}/documents/${documentId}/segments/${segmentId}`, data).then(res => res.data),

  createNote: (projectId: number, documentId: number, data: { segment_id: number; content: string }) =>
    api.post<DocumentNote>(`/projects/${projectId}/documents/${documentId}/notes`, data).then(res => res.data),

  listNotes: (projectId: number, documentId: number) =>
    api.get<DocumentNote[]>(`/projects/${projectId}/documents/${documentId}/notes`).then(res => res.data),

  getOriginalUrl: (projectId: number, documentId: number) =>
    `/api/projects/${projectId}/documents/${documentId}/original`,

  fetchOriginalText: (projectId: number, documentId: number) =>
    api.get<string>(`/projects/${projectId}/documents/${documentId}/original`, {
      responseType: 'text',
      transformResponse: [(data: string) => data],
    }).then(res => res.data),

  getImageUrl: (projectId: number, documentId: number, imageIndex: number) =>
    `/api/projects/${projectId}/documents/${documentId}/images/${imageIndex}`,

  deleteImage: (projectId: number, documentId: number, imageIndex: number) =>
    api.delete(`/projects/${projectId}/documents/${documentId}/images/${imageIndex}`).then(res => res.data),

  updateImagePosition: (projectId: number, documentId: number, imageIndex: number, afterSequenceOrder: number) =>
    api.patch(`/projects/${projectId}/documents/${documentId}/images/${imageIndex}`, {
      after_sequence_order: afterSequenceOrder,
    }).then(res => res.data),

  merge: (projectId: number, documentId: number, segmentIds: number[]) =>
    api.post<{ merged_segment: DocumentSegmentResponse; deleted_count: number }>(
      `/projects/${projectId}/documents/${documentId}/segments/merge`,
      { segment_ids: segmentIds },
    ).then(res => res.data),

  unmerge: (projectId: number, documentId: number, segmentId: number) =>
    api.post<{ restored_segments: DocumentSegmentResponse[]; restored_count: number }>(
      `/projects/${projectId}/documents/${documentId}/segments/${segmentId}/unmerge`,
    ).then(res => res.data),

  split: (projectId: number, documentId: number, ranges: { segment_id: number; start_offset: number; end_offset: number }[]) =>
    api.post<{ new_segments: DocumentSegmentResponse[]; deleted_segment_ids: number[] }>(
      `/projects/${projectId}/documents/${documentId}/segments/split`,
      { ranges },
    ).then(res => res.data),

  unsplit: (projectId: number, documentId: number, segmentId: number) =>
    api.post<{ restored_segment: DocumentSegmentResponse; deleted_count: number }>(
      `/projects/${projectId}/documents/${documentId}/segments/${segmentId}/unsplit`,
    ).then(res => res.data),
}
