import api from './client'

// Project types
export interface Project {
  id: number
  name: string
  description: string | null
  status: 'active' | 'archived'
  created_at: string
  updated_at: string
  /** #422(c): most-recent activity (MAX audit timestamp, floored by updated_at). The
   *  Dashboard sorts + labels by this so "Nd ago" reflects real recent work, not just
   *  name/status edits. Server-sorted most-recent-first; null on non-list responses. */
  last_activity_at?: string | null
  conversation_count: number
  code_count: number
  dataset_count: number
  document_count: number
  participant_count: number
  /** Track J · Group A (#1): distinct real coders who have coded in this project
   *  (includes archived; excludes system coders). Surfaced on the card when > 1. */
  coder_count: number
  category_level_names: Record<string, string> | null
  /** Track J · J3-1: stable cross-instance identity (round-trip / future merge). */
  project_uuid: string | null
  /** Track J · J3-1: "Freeze Codebook" soft-lock. null = unfrozen; an ISO timestamp = frozen-at. */
  codebook_frozen_at: string | null
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
  /** Track J · J3-1: toggle the codebook freeze soft-lock. */
  setCodebookFreeze: (id: number, frozen: boolean) =>
    api.post<Project>(`/projects/${id}/codebook/freeze`, { frozen }).then(res => res.data),
}
