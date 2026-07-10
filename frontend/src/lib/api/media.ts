import api from './client'
import { mediaUploadTimeoutMs } from '../media-constants'

export interface MediaUploadResponse {
  media_filename: string
  media_format: string
  media_type: string
  media_duration_seconds: number | null
  media_offset_seconds: number
  media_is_vbr: boolean | null
}

export const mediaApi = {
  upload: (projectId: number, conversationId: number, file: File) => {
    const formData = new FormData()
    formData.append('file', file)
    return api.post<MediaUploadResponse>(
      `/projects/${projectId}/conversations/${conversationId}/media`,
      formData,
      // Size-scaled timeout — the client's default 30s abort would kill any
      // multi-GB upload, while a flat disable would let a stalled connection
      // hang forever. Gives a large file hours, a small stalled one ~2min.
      // The backend streams to a bounded-memory temp file and caps size.
      { headers: { 'Content-Type': 'multipart/form-data' }, timeout: mediaUploadTimeoutMs(file.size) }
    ).then(res => res.data)
  },

  getStreamUrl: (projectId: number, conversationId: number) =>
    `/api/projects/${projectId}/conversations/${conversationId}/media/stream`,

  remove: (projectId: number, conversationId: number) =>
    api.delete(`/projects/${projectId}/conversations/${conversationId}/media`).then(res => res.data),

  updateOffset: (projectId: number, conversationId: number, offsetSeconds: number) =>
    api.patch(
      `/projects/${projectId}/conversations/${conversationId}/media/offset`,
      { offset_seconds: offsetSeconds }
    ).then(res => res.data),
}
