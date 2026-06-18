import api from './client'

export interface AudioUploadResponse {
  media_filename: string
  media_format: string
  media_type: string
  media_duration_seconds: number | null
  media_offset_seconds: number
  media_is_vbr: boolean | null
}

export const audioApi = {
  upload: (projectId: number, conversationId: number, file: File) => {
    const formData = new FormData()
    formData.append('file', file)
    return api.post<AudioUploadResponse>(
      `/projects/${projectId}/conversations/${conversationId}/audio`,
      formData,
      { headers: { 'Content-Type': 'multipart/form-data' } }
    ).then(res => res.data)
  },

  getStreamUrl: (projectId: number, conversationId: number) =>
    `/api/projects/${projectId}/conversations/${conversationId}/audio/stream`,

  remove: (projectId: number, conversationId: number) =>
    api.delete(`/projects/${projectId}/conversations/${conversationId}/audio`).then(res => res.data),

  updateOffset: (projectId: number, conversationId: number, offsetSeconds: number) =>
    api.patch(
      `/projects/${projectId}/conversations/${conversationId}/audio/offset`,
      { offset_seconds: offsetSeconds }
    ).then(res => res.data),
}
