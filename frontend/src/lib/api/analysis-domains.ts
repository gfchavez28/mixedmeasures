import api from './client'

// Analysis domain types
export interface DomainMemberInput {
  member_type: 'column'
  member_id: number
}

export interface DomainMemberInfo {
  id: number
  member_type: 'column'
  member_id: number
  label: string
  dataset_id: number | null
  dataset_name: string | null
  column_code: string | null
  column_type: string | null
  scale_points: number | null
  scale_labels: string[] | null
  equivalence_group_id: number | null
}

export interface AnalysisDomainResponse {
  id: number
  project_id: number
  name: string
  description: string | null
  color: string | null
  sequence_order: number | null
  origin: string
  member_count: number
  members: DomainMemberInfo[]
  created_at: string
  updated_at: string
}

export interface AnalysisDomainListResponse {
  domains: AnalysisDomainResponse[]
  total: number
}

export interface BulkDomainCreateResult {
  created: number
  domains: AnalysisDomainResponse[]
}

export interface DomainSuggestedItem {
  member_type: 'column'
  member_id: number
  label: string
  dataset_id: number | null
  dataset_name: string | null
  column_type: string | null
  reason: string | null
}

export interface DomainSuggestion {
  name: string
  members: DomainSuggestedItem[]
  /** Phase 4 (#297, #295): pre-computed equivalence pairings for cross-dataset
   * clusters. Each inner list = column IDs that should belong to one EG.
   * Empty for single-dataset suggestions OR when pairing was inconclusive
   * (in which case `unpaired === true`).
   */
  members_paired: number[][]
  /** True for cross-dataset clusters where auto-pair couldn't confidently
   * align columns. Frontend renders these greyed and prompts manual pairing. */
  unpaired: boolean
  /** e.g. "text_match:0.85" when paired; null when unpaired. */
  pairing_reason: string | null
}

export interface DomainSuggestResponse {
  suggestions: DomainSuggestion[]
}

/** Phase 4: inline equivalence-group spec on the bulk-create-domains payload. */
export interface EquivalenceGroupCreateInline {
  column_ids: number[]
  label?: string | null
}

/** Phase 4: each domain in a bulk-create payload may carry inline EGs that
 * are created in the same transaction as the domain itself. Used by Suggest
 * accept to scaffold paired EGs for cross-dataset clusters. */
export interface AnalysisDomainBulkCreateItem {
  name: string
  description?: string | null
  color?: string | null
  members?: DomainMemberInput[]
  equivalence_groups?: EquivalenceGroupCreateInline[]
}

// create-score-metric response shape (Tier 3 crosswalk, see
// backend/app/routers/analysis_domains.py::create_score_metric).
// `metric` is the ungrouped domain_aggregate MetricDefinition;
// `computed` is False when the metric exists but the compute pass failed
// (retryable via the same endpoint; the frontend surfaces this as a
// "degraded" state on the Σ badge).
export interface CreateScoreMetricResponse {
  metric: {
    id: number
    name: string
    metric_type: string
    input_source_type: string
    input_source_id: number
    grouping_column_id: number | null
    grouping_column_id_2: number | null
    stale: boolean
    origin: string
    origin_context: string | null
  }
  computed: boolean
}

// API functions - Analysis Domains
export const domainsApi = {
  list: (projectId: number) =>
    api.get<AnalysisDomainListResponse>(`/projects/${projectId}/analysis-domains`).then(res => res.data),
  create: (projectId: number, data: { name: string; description?: string | null; color?: string | null; members?: DomainMemberInput[] }) =>
    api.post<AnalysisDomainResponse>(`/projects/${projectId}/analysis-domains`, data).then(res => res.data),
  update: (projectId: number, domainId: number, data: { name?: string; description?: string | null; color?: string | null }) =>
    api.patch<AnalysisDomainResponse>(`/projects/${projectId}/analysis-domains/${domainId}`, data).then(res => res.data),
  delete: (projectId: number, domainId: number) =>
    api.delete(`/projects/${projectId}/analysis-domains/${domainId}`).then(res => res.data),
  addMembers: (projectId: number, domainId: number, members: DomainMemberInput[]) =>
    api.post<AnalysisDomainResponse>(`/projects/${projectId}/analysis-domains/${domainId}/members`, { members }).then(res => res.data),
  removeMembers: (projectId: number, domainId: number, members: DomainMemberInput[]) =>
    api.post<AnalysisDomainResponse>(`/projects/${projectId}/analysis-domains/${domainId}/members/remove`, { members }).then(res => res.data),
  suggest: (projectId: number) =>
    api.get<DomainSuggestResponse>(`/projects/${projectId}/analysis-domains/suggest`).then(res => res.data),
  bulkCreate: (projectId: number, domains: AnalysisDomainBulkCreateItem[]) =>
    api.post<BulkDomainCreateResult>(`/projects/${projectId}/analysis-domains/bulk`, { domains }).then(res => res.data),
  reorder: (projectId: number, domainIds: number[]) =>
    api.post(`/projects/${projectId}/analysis-domains/reorder`, { domain_ids: domainIds }).then(res => res.data),
  reorderMembers: (projectId: number, domainId: number, memberIds: number[]) =>
    api.post(`/projects/${projectId}/analysis-domains/${domainId}/members/reorder`, { member_ids: memberIds }).then(res => res.data),
  createScoreMetric: (projectId: number, domainId: number) =>
    api.post<CreateScoreMetricResponse>(`/projects/${projectId}/analysis-domains/${domainId}/create-score-metric`).then(res => res.data),
}
