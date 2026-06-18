import api from './client'

// Scratchpad types
export interface ScratchpadEntry {
  id: number
  project_id: number
  numeric_id: number
  content: string
  context_hint: string | null
  resolved: boolean
  resolved_into_type: string | null
  resolved_into_id: number | null
  created_at: string
  updated_at: string
}

// API functions - Scratchpad
export const scratchpadApi = {
  list: (projectId: number, resolved?: boolean) =>
    api.get<{ entries: ScratchpadEntry[]; total: number }>(`/projects/${projectId}/scratchpad`, {
      params: { resolved },
    }).then(res => res.data),

  create: (projectId: number, data: { content: string; context_hint?: string }) =>
    api.post<ScratchpadEntry>(`/projects/${projectId}/scratchpad`, data).then(res => res.data),

  update: (projectId: number, entryId: number, data: { content?: string; resolved?: boolean }) =>
    api.patch<ScratchpadEntry>(`/projects/${projectId}/scratchpad/${entryId}`, data).then(res => res.data),

  delete: (projectId: number, entryId: number) =>
    api.delete(`/projects/${projectId}/scratchpad/${entryId}`).then(res => res.data),

  convert: (projectId: number, entryId: number, data: { target_type: string; entity_type: string; entity_id: number }) =>
    api.post<ScratchpadEntry>(`/projects/${projectId}/scratchpad/${entryId}/convert`, data).then(res => res.data),
}
