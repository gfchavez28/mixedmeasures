import api from './client'
import type { MagnitudeScale } from '../magnitude'

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
  // #501: typed source identities ("conv:1", "col:13", "doc:2") — lets the
  // peek multi-select UNION sources instead of double-counting shared ones.
  source_keys?: string[]
  /** #869 (b): the code's declared rating scale, so the merge dialog can say
   * before a merge when two codes' scales differ. Null when it has none. */
  magnitude_scale?: MagnitudeScale | null
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
}
