/**
 * Shared TypeScript types for the Tier 3 crosswalk view.
 *
 * Path A (#325) unifies "additional members" with rows. Every domain member
 * renders as a row. EG-keyed members render as multi-cell rows (existing
 * `EgRowData`). Members without an EG render as synthetic single-cell rows
 * (`UnlinkedRowData`) — one cell in the source dataset, empty placeholders
 * in sibling datasets. Empty cells in synthetic rows function as
 * "promote-to-paired" drop targets (drop a sibling-dataset cell here ⇒ a new
 * EG containing both cells is created, both stay in the target domain).
 *
 * The `RowData` discriminated union (`kind: 'eg' | 'unlinked'`) replaces
 * the prior split between `BracketData.rows` and `BracketData.unlinked_count` /
 * `CrosswalkGrid.unlinkedByDomain`. Consumers switch on `kind` to disambiguate.
 *
 * Orphan equivalence groups (EGs not referenced by any domain) cannot exist
 * in the new model — every removal path either keeps the column inside a
 * variable group (as a synthetic single-cell row) or sends it to the
 * Unassigned panel. There is no third bucket. See #331.
 *
 * All types derive from the existing API response shapes in `@/lib/api`
 * (`AnalysisDomainResponse`, `ProjectColumnInfo`, `EquivalenceGroupResponse`)
 * so the crosswalk data layer stays in sync with server changes without
 * parallel type maintenance.
 */

import type {
  AnalysisDomainResponse,
  DomainMemberInfo,
  EquivalenceGroupResponse,
  ProjectColumnInfo,
} from '@/lib/api'

// ─── Cell — one column in one dataset column of a crosswalk row ─────────────

/** A cell is a single dataset column rendered inside a crosswalk row. It's
 * always tied to a real `DatasetColumn` via `column_id`. For `kind: 'eg'`
 * rows, `equivalence_group_id` matches the row. For `kind: 'unlinked'`
 * synthetic rows, `equivalence_group_id` is null.
 */
export interface CellData {
  column_id: number
  dataset_id: number
  dataset_name: string
  column_code: string | null
  column_text: string
  column_type: string
  scale_points: number | null
  /** Phase 4.5: full label list for mismatch v2 detection. v1 used a
   * scale_points proxy that caught point-count differences but missed the
   * insidious case where 5pt agree-disagree and 5pt frequency labels share
   * a count but mean different things. Null when the column has no defined
   * scale (e.g. open_text). */
  scale_labels: string[] | null
  /** Set when the column has a primary reverse recode — drives the ⟲ badge */
  is_reverse_scored: boolean
  /** Phase 4.4 (TypePickerPopover pre-flight): if >0, the column has recode
   * definitions and bulk_type_update will 409. The popover surfaces a
   * Recode Workbench link instead of the type swatch list. Sourced from
   * `ProjectColumnInfo.recode_def_count` in buildGrid. */
  recode_def_count: number
  /** The equivalence row this cell belongs to (equivalence group ID).
   * Null for cells inside synthetic single-cell rows.
   */
  equivalence_group_id: number | null
}

/** Empty cell placeholder — rendered as em-dash. In `kind: 'eg'` rows: a
 * dataset has no column in this row. In `kind: 'unlinked'` rows: a sibling
 * dataset that doesn't have the synthetic row's column. The latter accepts
 * "promote-to-paired" drops (drop a sibling-dataset cell here ⇒ create EG).
 */
export interface EmptyCellData {
  dataset_id: number
  dataset_name: string
}

// ─── Row — discriminated union (Path A, #325) ──────────────────────────────

interface BaseRow {
  /** Label derived from the cell text(s). For EG rows: lowest-ID cell's
   * column_text. For unlinked rows: the sole cell's column_text.
   */
  auto_label: string
  /** Cells keyed by dataset_id. Empty slots render as EmptyCellData.
   * For EG rows: any dataset can populate. For unlinked rows: exactly one
   * dataset is populated; the rest are empty placeholders.
   */
  cells_by_dataset: Map<number, CellData | EmptyCellData>
}

/** EG-keyed row: a multi-cell equivalence row spanning all active datasets.
 * Each dataset contributes at most one cell (1:1-per-dataset, #289). */
export interface EgRowData extends BaseRow {
  kind: 'eg'
  equivalence_group_id: number
  /** Derived from cells — true if any cell reports a mismatched scale_points
   * (different numeric anchors across datasets). Drives the amber
   * scale-labels mismatch warning icon in the row gutter.
   */
  has_scale_labels_mismatch: boolean
}

/** Synthetic single-cell row: a domain member without an equivalence group
 * link. Renders one populated cell in the source dataset; sibling datasets
 * render EmptyCellData placeholders (which double as promote-to-paired drop
 * targets — see #325). Replaces pre-Path-A `UnlinkedMember`. */
export interface UnlinkedRowData extends BaseRow {
  kind: 'unlinked'
  /** AnalysisDomainMember.id — used for member reorder / removal */
  member_id: number
  /** The single populated cell's column_id */
  column_id: number
}

export type RowData = EgRowData | UnlinkedRowData

// ─── Bracket — one variable group (AnalysisDomain) containing rows ──────────

/** A bracket wraps an analysis domain. After Path A (#325), every domain
 * member is a row in `rows` — there's no separate "additional members"
 * subsection.
 */
export interface BracketData {
  domain_id: number
  name: string
  description: string | null
  color: string | null
  sequence_order: number | null
  /** Ordered by AnalysisDomainMember.sequence_order. Mix of EG rows and
   * synthetic single-cell rows; `kind` disambiguates.
   */
  rows: RowData[]
  /** True if the bracket's EG-keyed rows span 2+ datasets. Drives the
   * cross-dataset badge and the #290 unpaired-member validation surface.
   * Path A (#325): unlinked rows are always single-dataset by definition;
   * `is_cross_dataset` is computed from EG rows only.
   */
  is_cross_dataset: boolean
  /** Distinct datasets contributing variables to this bracket. Drives the
   * "N variables · M datasets" label that replaced the structural "N rows"
   * count. Equal to `datasetsInDomain.size` for any rendered bracket; equal
   * to 1 for a pure single-dataset composite, ≥2 for cross-dataset
   * harmonization, 0 only for an empty bracket. */
  dataset_count: number
  /** Ungrouped domain_aggregate metric backing the Σ ("scale score") badge. */
  scale_score_metric_id: number | null
  /** Four states drive the Σ badge rendering in Bracket.tsx:
   *   - 'ok':      badge visible, fresh scores
   *   - 'stale':   badge visible with amber dot overlay
   *   - 'missing': no badge; context menu shows "Create scale score manually"
   *   - 'failed':  no badge; degraded-state recovery via Create retry
   */
  scale_score_metric_state: 'ok' | 'stale' | 'failed' | 'missing'
}

// ─── Grid — single-slice return shape of buildGrid (Path A revised) ────────

/** The top-level structural output of `buildGrid`. Every variable group
 * row lives inside `brackets`. There is no orphan / ungrouped section —
 * a column is either inside a variable group (visible as a row) or in the
 * Unassigned panel.
 */
export interface CrosswalkGrid {
  brackets: BracketData[]
}

// ─── Unassigned columns — the panel's per-dataset groupings ────────────────

/** A column that doesn't belong to any equivalence group yet. Rendered in
 * the UnassignedPanel with multi-select checkbox support for bulk assign.
 */
export interface UnassignedColumn {
  column_id: number
  dataset_id: number
  dataset_name: string
  column_code: string | null
  column_text: string
  column_type: string
}

/** Per-dataset grouping of unassigned columns inside the panel. */
export interface UnassignedGroup {
  dataset_id: number
  dataset_name: string
  columns: UnassignedColumn[]
}

// ─── Re-exports for convenience ─────────────────────────────────────────────

export type {
  AnalysisDomainResponse,
  DomainMemberInfo,
  EquivalenceGroupResponse,
  ProjectColumnInfo,
}
