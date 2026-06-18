import api from './client'

// Speaker types
export interface Speaker {
  id: number
  name: string
  is_facilitator: boolean
  color_index: number
  color: string | null
}

// API functions - Speakers
export const speakersApi = {
  list: (projectId: number) =>
    api.get<Speaker[]>(`/projects/${projectId}/speakers`).then(res => res.data),

  updateColor: (projectId: number, speakerId: number, color: string | null) =>
    api.patch<Speaker>(`/projects/${projectId}/speakers/${speakerId}`, { color }).then(res => res.data),
}
