import api from './client'

/**
 * Code sets — a mutually exclusive group of codes read as ONE variable (row 48).
 *
 * 🔴 The OPPOSITE relation to `code-equivalence`, which it otherwise mirrors:
 * an equivalence group collapses synonyms to one effective code, a set keeps
 * alternatives distinct and a unit takes exactly one of them.
 */

/** One VALUE the set's variable can take. */
export interface CodeSetMember {
  id: number
  numeric_id: number
  name: string
  description: string | null
  color: string | null
  is_active: boolean
  is_universal: boolean
}

/**
 * A code whose application counts in the set, and the value it reads as
 * (#1028). Every member is one — reading as itself unless grouped — and so is a
 * code OUTSIDE the set grouped INTO one of its values: "Pos" grouped with
 * "Positive" counts as choosing "Positive", and choosing another value clears it.
 */
export interface CodeSetClaimant {
  code_id: number
  value_id: number
}

export interface CodeSet {
  id: number
  project_id: number
  label: string
  description: string | null
  /**
   * 🔴 Whether a unit with no value chosen is MISSING DATA (true) or took the
   * real value "none of these" (false). Not cosmetic — it changes the
   * denominator of the set's α.
   */
  exhaustive: boolean
  members: CodeSetMember[]
  /** `lib/code-set-basis.ts::SetBasis` for this set's `exhaustive`. */
  set_basis: string
  /**
   * Members whose selections would silently leave the set, as sentences. Empty
   * is the normal state — a non-empty list means a member is grouped with an
   * OUTSIDE code as one effective code, so choosing it records something else.
   */
  composition_warnings: string[]
  /**
   * Every code whose application counts in this set. REQUIRED: deciding what a
   * passage holds in the set from `members` alone misses a synonym, and the
   * server clears by this list (`services/code_sets.py::set_claimants`).
   */
  claimants: CodeSetClaimant[]
  created_at: string
  updated_at: string
}

export interface CodeSetListResponse {
  sets: CodeSet[]
  total: number
}

export interface CodeSetSelectionResponse {
  set_id: number
  /** The value now selected, or null when the selection was cleared. */
  code_id: number | null
  /** Applications removed to make the selection exclusive. */
  removed: number
}

export const codeSetsApi = {
  list: (projectId: number) =>
    api.get<CodeSetListResponse>(`/projects/${projectId}/code-sets`).then(r => r.data),

  create: (projectId: number, data: {
    label: string
    description?: string | null
    exhaustive?: boolean
    code_ids?: number[]
  }) => api.post<CodeSet>(`/projects/${projectId}/code-sets`, data).then(r => r.data),

  update: (projectId: number, setId: number, data: {
    label?: string
    description?: string | null
    exhaustive?: boolean
  }) => api.patch<CodeSet>(`/projects/${projectId}/code-sets/${setId}`, data).then(r => r.data),

  remove: (projectId: number, setId: number) =>
    api.delete<{ deleted: boolean; released_codes: number }>(
      `/projects/${projectId}/code-sets/${setId}`,
    ).then(r => r.data),

  addCodes: (projectId: number, setId: number, codeIds: number[]) =>
    api.post<CodeSet>(`/projects/${projectId}/code-sets/${setId}/codes`, {
      code_ids: codeIds,
    }).then(r => r.data),

  removeCodes: (projectId: number, setId: number, codeIds: number[]) =>
    api.post<{ code_set: CodeSet | null; dissolved: boolean }>(
      `/projects/${projectId}/code-sets/${setId}/codes/remove`,
      { code_ids: codeIds },
    ).then(r => r.data),

  /**
   * Choose ONE value of a set on a SEGMENT, or clear it with `codeId = null`.
   *
   * 🔴 One request, not a remove followed by an apply. The swap is atomic at the
   * server precisely so a failure between the two halves cannot leave an
   * exhaustive set with no selection — a state the interface says is impossible.
   */
  selectOnSegment: (segmentId: number, setId: number, codeId: number | null) =>
    api.post<CodeSetSelectionResponse>(
      `/segments/${segmentId}/code-sets/${setId}/selection`,
      { code_id: codeId },
    ).then(r => r.data),

  /**
   * The text-coding sibling. Differs in the TARGET COLUMN and nothing else —
   * this router keys its coding endpoints on the cell, so the id rides the body.
   */
  selectOnText: (
    projectId: number, setId: number, datasetValueId: number, codeId: number | null,
  ) =>
    api.post<CodeSetSelectionResponse>(
      `/projects/${projectId}/text-coding/code-sets/${setId}/selection`,
      { dataset_value_id: datasetValueId, code_id: codeId },
    ).then(r => r.data),
}
