import api from './client'

// Participant types
export interface LinkedSpeakerInfo {
  speaker_id: number
  speaker_name: string
  is_facilitator: boolean
  conversation_names: string[]
  color_index: number
  color: string | null
}

export interface DatasetRowInfo {
  id: number
  dataset_name: string
  dataset_id: number
  row_identifier: string | null
  submitted_at: string | null
}

export interface Participant {
  id: number
  project_id: number
  identifier: string
  display_name: string | null
  role: string | null
  demographics: string | null
  role_auto_filled_from: string | null
  created_at: string
  updated_at: string
  linked_speakers: LinkedSpeakerInfo[]
  dataset_rows: DatasetRowInfo[]
}

export interface LinkedDemographicValue {
  column_id: number
  column_text: string
  demographic_subtype: string | null
  value: string | null
  dataset_name: string
  dataset_id: number
  /** #353: column type drives type-aware rendering in the participant detail
   * panel (numerics right-aligned, multi-select as chips, ordinals as labels).
   * Null on legacy responses; frontend falls back to plain-string render. */
  column_type: string | null
}

export interface ParticipantDetail extends Participant {
  linked_demographics: LinkedDemographicValue[]
}

export interface LinkableRow {
  row_id: number
  row_identifier: string | null
  linked_participant_name: string | null
  demographic_values: Array<{ label: string; value: string | null }>
  /** #418: up to 3 identifying text-ish values for the row label. */
  display_values: string[]
  /** #418: every value_text in the row, space-joined + lowercased, for search. */
  search_text: string
}

// API functions - Participants
export const participantsApi = {
  list: (projectId: number) =>
    api.get<{ participants: Participant[]; total: number }>(`/projects/${projectId}/participants`).then(res => res.data),
  get: (projectId: number, participantId: number) =>
    api.get<Participant>(`/projects/${projectId}/participants/${participantId}`).then(res => res.data),
  getDetail: (projectId: number, participantId: number) =>
    api.get<ParticipantDetail>(`/projects/${projectId}/participants/${participantId}`).then(res => res.data),
  create: (projectId: number, data: { identifier: string; display_name?: string; role?: string; demographics?: string }) =>
    api.post<Participant>(`/projects/${projectId}/participants`, data).then(res => res.data),
  update: (projectId: number, participantId: number, data: { identifier?: string; display_name?: string; role?: string; demographics?: string }) =>
    api.patch<Participant>(`/projects/${projectId}/participants/${participantId}`, data).then(res => res.data),
  delete: (projectId: number, participantId: number) =>
    api.delete(`/projects/${projectId}/participants/${participantId}`).then(res => res.data),
  linkDatasetRow: (projectId: number, participantId: number, datasetId: number, rowId: number) =>
    api.post<ParticipantDetail>(`/projects/${projectId}/participants/${participantId}/link-dataset-row`,
      { dataset_id: datasetId, row_id: rowId }).then(res => res.data),
  unlinkDatasetRow: (projectId: number, participantId: number, rowId: number) =>
    api.post<ParticipantDetail>(`/projects/${projectId}/participants/${participantId}/unlink-dataset-row`,
      { row_id: rowId }).then(res => res.data),
}
