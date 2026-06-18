import api from './client'

// Memo types (analytical reflections)
export interface Memo {
  id: number
  project_id: number
  numeric_id: number  // Human-friendly ID (M-1, M-2, etc.)
  entity_type: 'project' | 'conversation' | 'document' | 'code' | 'code_category' | 'analysis' | 'dataset' | 'dataset_row' | 'dataset_column' | 'canvas'
  entity_id: number
  title: string | null
  content: string
  is_archived: boolean
  created_at: string
  updated_at: string
}

// API functions - Memos
export const memosApi = {
  list: (projectId: number, entityType?: string, entityId?: number, includeArchived = false) =>
    api.get<{ memos: Memo[]; total: number }>(`/projects/${projectId}/memos`, {
      params: { entity_type: entityType, entity_id: entityId, include_archived: includeArchived },
    }).then(res => res.data),

  create: (projectId: number, data: {
    entity_type: string;
    entity_id: number;
    title?: string;
    content?: string;
  }) => api.post<Memo>(`/projects/${projectId}/memos`, data).then(res => res.data),

  get: (projectId: number, memoId: number) =>
    api.get<Memo>(`/projects/${projectId}/memos/${memoId}`).then(res => res.data),

  update: (projectId: number, memoId: number, data: { title?: string; content?: string }) =>
    api.patch<Memo>(`/projects/${projectId}/memos/${memoId}`, data).then(res => res.data),

  archive: (projectId: number, memoId: number) =>
    api.delete(`/projects/${projectId}/memos/${memoId}`).then(res => res.data),

  permanentDelete: (projectId: number, memoId: number) =>
    api.delete(`/projects/${projectId}/memos/${memoId}`, { params: { permanent: true } }).then(res => res.data),

  restore: (projectId: number, memoId: number) =>
    api.patch<Memo>(`/projects/${projectId}/memos/${memoId}`, { is_archived: false }).then(res => res.data),
}
