import api from './client'

// Equivalence group types
export interface EquivalenceGroupColumnDefInfo {
  id: number
  name: string
  recode_type: string
  is_primary: boolean
}

export interface EquivalenceGroupColumnInfo {
  id: number
  dataset_id: number
  dataset_name: string
  column_code: string | null
  column_text: string
  column_type: string
  scale_labels: string[] | null
  scale_points: number | null
  recode_definitions: EquivalenceGroupColumnDefInfo[]
}

export interface EquivalenceGroupResponse {
  id: number
  project_id: number
  label: string
  description: string | null
  origin: string
  columns: EquivalenceGroupColumnInfo[]
  created_at: string
  updated_at: string
}

export interface EquivalenceGroupListResponse {
  groups: EquivalenceGroupResponse[]
  total: number
}

export interface BulkCreateResult {
  created: number
  groups: EquivalenceGroupResponse[]
}

export interface SuggestedGroupColumn {
  id: number
  dataset_id: number
  dataset_name: string
  column_code: string | null
  column_text: string
  column_type: string
  similarity_score: number | null
}

export interface SuggestedGroup {
  label: string
  match_type: 'exact_text' | 'code_match' | 'similar_text'
  type_mismatch: boolean
  similarity_score: number | null
  columns: SuggestedGroupColumn[]
}

export interface EquivalenceSuggestResponse {
  suggestions: SuggestedGroup[]
}

export interface ColumnMatchResult {
  anchor_column_id: number
  target_column_id: number
  target_column_text: string
  target_column_code: string | null
  target_dataset_id: number
  target_dataset_name: string
  target_column_type: string
  similarity: number
  already_linked: boolean
  /** True when the target is another anchor the user explicitly picked from a
   * different dataset. These bypass the fuzzy threshold and are pre-checked. */
  user_selected: boolean
}

export interface FindMatchesResponse {
  matches: ColumnMatchResult[]
}

export interface ColumnSwap {
  column_id_a: number
  column_id_b: number
}

export interface EquivalenceGroupSwapResponse {
  updated_groups: EquivalenceGroupResponse[]
  recomputed_metric_ids: number[]
}

/** Path A (#323): `remove_columns` returns the post-mutation group OR
 * `dissolved=true` when the removal emptied the group and the backend
 * auto-deleted it in the same transaction. The frontend reads `dissolved`
 * directly and patches caches accordingly. */
export interface EquivalenceGroupRemoveColumnsResponse {
  group: EquivalenceGroupResponse | null
  dissolved: boolean
}

// API functions - Equivalence Groups
export const equivalenceApi = {
  list: (projectId: number) =>
    api.get<EquivalenceGroupListResponse>(`/projects/${projectId}/equivalence-groups`).then(res => res.data),
  create: (projectId: number, data: { label: string; description?: string | null; column_ids?: number[] }) =>
    api.post<EquivalenceGroupResponse>(`/projects/${projectId}/equivalence-groups`, data).then(res => res.data),
  bulkCreate: (projectId: number, groups: Array<{ label: string; description?: string | null; column_ids: number[] }>) =>
    api.post<BulkCreateResult>(`/projects/${projectId}/equivalence-groups/bulk`, { groups }).then(res => res.data),
  update: (projectId: number, groupId: number, data: { label?: string; description?: string | null }) =>
    api.patch<EquivalenceGroupResponse>(`/projects/${projectId}/equivalence-groups/${groupId}`, data).then(res => res.data),
  delete: (projectId: number, groupId: number) =>
    api.delete(`/projects/${projectId}/equivalence-groups/${groupId}`).then(res => res.data),
  addColumns: (projectId: number, groupId: number, columnIds: number[]) =>
    api.post<EquivalenceGroupResponse>(`/projects/${projectId}/equivalence-groups/${groupId}/columns`, { column_ids: columnIds }).then(res => res.data),
  removeColumns: (projectId: number, groupId: number, columnIds: number[]) =>
    api.post<EquivalenceGroupRemoveColumnsResponse>(`/projects/${projectId}/equivalence-groups/${groupId}/columns/remove`, { column_ids: columnIds }).then(res => res.data),
  suggest: (projectId: number) =>
    api.get<EquivalenceSuggestResponse>(`/projects/${projectId}/equivalence-groups/suggest`).then(res => res.data),
  reorder: (projectId: number, groupIds: number[]) =>
    api.post(`/projects/${projectId}/equivalence-groups/reorder`, { group_ids: groupIds }).then(res => res.data),
  merge: (projectId: number, targetGroupId: number, sourceGroupId: number) =>
    api.post<EquivalenceGroupResponse>(`/projects/${projectId}/equivalence-groups/${targetGroupId}/merge/${sourceGroupId}`).then(res => res.data),
  findMatches: (projectId: number, columnIds: number[], minSimilarity?: number) =>
    api.post<FindMatchesResponse>(`/projects/${projectId}/equivalence-groups/find-matches`, { column_ids: columnIds, ...(minSimilarity != null ? { min_similarity: minSimilarity } : {}) }).then(res => res.data),
  /** Tier 3 crosswalk drag-to-swap. Atomically swaps the equivalence_group_id
   * of each pair. See backend routers/equivalence.py::swap_columns — three-phase
   * null-intermediate pattern with post-swap #290 validator (foot-gun).
   * Rate limited 60/minute. May raise structured 409/400 errors:
   *   { error: "type_mismatch" | "cross_dataset" | "not_linked" | "cross_dataset_unpaired", ... }
   */
  swap: (projectId: number, swaps: ColumnSwap[]) =>
    api.post<EquivalenceGroupSwapResponse>(`/projects/${projectId}/equivalence-groups/swap`, { swaps }).then(res => res.data),
}
