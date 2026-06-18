import api from './client'

// Project types
export interface Project {
  id: number
  name: string
  description: string | null
  status: 'active' | 'archived'
  created_at: string
  updated_at: string
  conversation_count: number
  code_count: number
  dataset_count: number
  document_count: number
  participant_count: number
  category_level_names: Record<string, string> | null
}

export interface RecentConversation {
  id: number
  name: string
  updated_at: string
  segment_count: number
  coded_segment_count: number
}

export interface RecentDataset {
  id: number
  name: string
  created_at: string
  row_count: number
  column_count: number
}

export interface RecentDocument {
  id: number
  name: string
  updated_at: string
  segment_count: number
  coded_segment_count: number
}

export interface ProjectSummary {
  conversations: number
  datasets: number
  documents: number
  participants: number
  codes: number
  categories: number
  coded_segments: number
  document_segments: number
  materials: number
  statistical_tests: number
  memos: number
  total_records: number
  total_variables: number
  open_ended_columns: number
  notes_count: number
  canvas_count: number
  recent_conversations: RecentConversation[]
  recent_datasets: RecentDataset[]
  recent_documents: RecentDocument[]
}

// API functions - Projects
export const projectsApi = {
  list: () => api.get<{ projects: Project[]; total: number }>('/projects').then(res => res.data),
  get: (id: number) => api.get<Project>(`/projects/${id}`).then(res => res.data),
  summary: (id: number) => api.get<ProjectSummary>(`/projects/${id}/summary`).then(res => res.data),
  create: (data: { name: string; description?: string }) =>
    api.post<Project>('/projects', data).then(res => res.data),
  update: (id: number, data: Partial<Project>) =>
    api.patch<Project>(`/projects/${id}`, data).then(res => res.data),
  delete: (id: number) => api.delete(`/projects/${id}`).then(res => res.data),
}
