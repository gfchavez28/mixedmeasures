/**
 * Crosswalk API namespace — Path A's atomic move-members endpoint.
 *
 * `move-members` is the canonical primitive behind drag-to-bracket and
 * drag-to-unassigned (Tier 3 redesign #328). It atomically updates BOTH
 * the equivalence-group link AND analysis-domain membership in one
 * transaction, with post-mutation validators (#290 cross-dataset pairing,
 * #289 1:1-per-dataset) and source-EG auto-dissolve (#323).
 */
import api from './client'
import type { AnalysisDomainResponse } from './analysis-domains'

export type MoveMembersTargetMode = 'existing_eg' | 'new_eg' | 'strip'

export interface MoveMembersRequest {
  column_ids: number[]
  source_domain_id: number | null
  target_domain_id: number | null
  target_mode: MoveMembersTargetMode
  /** Required if target_mode === 'existing_eg' */
  target_eg_id?: number | null
  /** Required if target_mode === 'new_eg' */
  target_eg_label?: string | null
}

export interface MoveMembersResponse {
  source_domain: AnalysisDomainResponse | null
  target_domain: AnalysisDomainResponse | null
  dissolved_eg_ids: number[]
  recomputed_metric_ids: number[]
}

export const crosswalkApi = {
  moveMembers: (projectId: number, request: MoveMembersRequest) =>
    api
      .post<MoveMembersResponse>(
        `/projects/${projectId}/crosswalk/move-members`,
        request,
      )
      .then((res) => res.data),
}
