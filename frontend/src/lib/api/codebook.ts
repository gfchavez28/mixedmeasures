import api from './client'

// ── Types ────────────────────────────────────────────────────────────────────

export interface CodebookCodeNode {
  id: number
  numeric_id: number
  name: string
  description: string | null
  color: string | null
  is_active: boolean
  is_universal: boolean
  segment_count: number
  source_count: number
  excerpt_count: number
  category_id: number | null
}

export interface CodebookCategoryNode {
  id: number
  name: string
  color: string | null
  display_order: number
  parent_id: number | null
  depth: number
  created_at: string | null
  code_count: number
  total_code_count: number
  total_segments: number
  total_sources: number
  children: CodebookCategoryNode[]
  codes: CodebookCodeNode[]
}

export interface CodebookTreeResponse {
  universal_codes: CodebookCodeNode[]
  tree: CodebookCategoryNode[]
  uncategorized_codes: CodebookCodeNode[]
}

export interface CodebookCooccurrenceNode {
  id: number
  name: string
  color: string | null
  segment_count: number
  source_count: number
  category_path: string[]
}

export interface CodebookCooccurrenceEdge {
  source: number
  target: number
  weight: number
}

export interface CodebookCooccurrenceResponse {
  nodes: CodebookCooccurrenceNode[]
  edges: CodebookCooccurrenceEdge[]
  max_weight: number
  hierarchy_level: number
  // #354: total non-universal codes in the project (respects include_inactive)
  // — denominator for the "Showing N of M codes" affordance. The network drops
  // codes with zero co-occurrence-eligible applications; this lets the UI
  // explain the discrepancy with the tree count.
  total_codes_in_project: number
}

// ── API ──────────────────────────────────────────────────────────────────────

export const codebookApi = {
  tree: (pid: number, params?: {
    conversation_ids?: string
    text_column_ids?: string
    exclude_facilitator?: boolean
    include_inactive?: boolean
    min_segments?: number
    max_segments?: number
  }) => api.get<CodebookTreeResponse>(`/projects/${pid}/codebook/tree`, { params })
    .then(r => r.data),

  cooccurrence: (pid: number, params?: {
    hierarchy_level?: number
    conversation_ids?: string
    text_column_ids?: string
    exclude_facilitator?: boolean
    include_inactive?: boolean
    min_segments?: number
    max_segments?: number
  }) => api.get<CodebookCooccurrenceResponse>(`/projects/${pid}/codebook/cooccurrence`, { params })
    .then(r => r.data),
}
