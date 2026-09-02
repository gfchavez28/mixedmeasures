import api from './client'
import type { MagnitudeScale } from '../magnitude'

// Code types
export interface Code {
  id: number
  project_id: number
  numeric_id: number
  name: string
  description: string | null
  color: string | null
  is_universal: boolean
  is_active: boolean
  created_at: string
  updated_at: string
  usage_count: number
  category_id: number | null
  category_name: string | null
  category_color: string | null
  category_order: number | null
  /**
   * #35 — the declared rating instrument, or null when this code carries none.
   *
   * Rides every code payload so a chip can position a value within its own range
   * without a second request: the normalized track is meaningless without
   * min/max, and a client that had to fetch them separately would render an
   * un-normalized bar in the gap.
   */
  magnitude_scale?: MagnitudeScale | null
}

export interface CodeCategory {
  id: number
  project_id: number
  name: string
  color: string | null
  display_order: number
  created_at: string
  code_count: number
  codes?: Code[]
  parent_id?: number | null
}

// API functions - Codes
export const codesApi = {
  list: (projectId: number, includeInactive = false) =>
    api.get<{ codes: Code[]; total: number }>(`/projects/${projectId}/codes`, {
      params: { include_inactive: includeInactive },
    }).then(res => res.data),
  get: (projectId: number, id: number) =>
    api.get<Code>(`/projects/${projectId}/codes/${id}`).then(res => res.data),
  create: (projectId: number, data: { name: string; description?: string; color?: string; category_id?: number }) =>
    api.post<Code>(`/projects/${projectId}/codes`, data).then(res => res.data),
  update: (projectId: number, id: number, data: Partial<Code>) =>
    api.patch<Code>(`/projects/${projectId}/codes/${id}`, data).then(res => res.data),
  /**
   * #35 — declare, replace, or clear this code's rating scale.
   *
   * ⚠️ A PUT because the declaration is replaced WHOLE. A PATCH would invite
   * "change only the max", which is precisely the edit that can strand existing
   * ratings without the caller stating the new range — the server refuses that
   * by count, and a partial payload would make the refusal unattributable.
   *
   * ⚠️ `null` CLEARS. The server keeps the ratings; they simply stop being
   * interpretable until a scale returns.
   */
  setMagnitudeScale: (projectId: number, id: number, scale: MagnitudeScale | null) =>
    api.put<Code>(`/projects/${projectId}/codes/${id}/magnitude-scale`, { scale }).then(res => res.data),
  reorderInCategory: (projectId: number, categoryId: number | null, orderedCodeIds: number[]) =>
    api.post(`/projects/${projectId}/codes/reorder-in-category`, {
      category_id: categoryId,
      ordered_code_ids: orderedCodeIds,
    }).then(res => res.data),
  bulkMove: (projectId: number, codeIds: number[], targetCategoryId: number | null) =>
    api.post<{ moved: number }>(`/projects/${projectId}/codes/bulk-move`, {
      code_ids: codeIds,
      target_category_id: targetCategoryId,
    }).then(res => res.data),
  merge: (projectId: number, sourceCodeId: number, targetCodeId: number, deleteSource = false) =>
    api.post<{ merged: number; skipped: number; source_action: string }>(
      `/projects/${projectId}/codes/${sourceCodeId}/merge/${targetCodeId}`,
      null,
      { params: { delete_source: deleteSource } },
    ).then(res => res.data),
}

// Category operation response types
export interface CategoryMergeResponse {
  merged_codes: number
  reparented_categories: number
  merged_memos: number
}

export interface CategoryBulkMoveResponse {
  moved: number
}

// API functions - Categories
export const categoriesApi = {
  list: (projectId: number, includeCodes = false) =>
    api.get<{ categories: CodeCategory[]; total: number }>(`/projects/${projectId}/categories`, {
      params: { include_codes: includeCodes },
    }).then(res => res.data),
  create: (projectId: number, data: { name: string; color?: string; parent_id?: number | null }) =>
    api.post<CodeCategory>(`/projects/${projectId}/categories`, data).then(res => res.data),
  update: (projectId: number, id: number, data: { name?: string; color?: string; display_order?: number; parent_id?: number | null }) =>
    api.patch<CodeCategory>(`/projects/${projectId}/categories/${id}`, data).then(res => res.data),
  delete: (projectId: number, id: number) =>
    api.delete(`/projects/${projectId}/categories/${id}`).then(res => res.data),
  reorder: (projectId: number, orderedIds: number[]) =>
    api.post(`/projects/${projectId}/categories/reorder`, { ordered_ids: orderedIds }).then(res => res.data),
  merge: (projectId: number, sourceIds: number[], targetId: number) =>
    api.post<CategoryMergeResponse>(`/projects/${projectId}/categories/merge`, {
      source_ids: sourceIds,
      target_id: targetId,
    }).then(res => res.data),
  bulkMove: (projectId: number, categoryIds: number[], targetParentId: number | null) =>
    api.post<CategoryBulkMoveResponse>(`/projects/${projectId}/categories/bulk-move`, {
      category_ids: categoryIds,
      target_parent_id: targetParentId,
    }).then(res => res.data),
  groupInto: (projectId: number, data: { name: string; color?: string; category_ids?: number[]; code_ids?: number[] }) =>
    api.post<CodeCategory>(`/projects/${projectId}/categories/group`, data).then(res => res.data),
}
