import api from './client'
import type { LinkableRow } from './participants'

// Dataset types
export interface DatasetColumnPreview {
  column_name: string
  column_index: number
  sample_values: string[]
  unique_count: number
  empty_count: number
  empty_percent: number
  na_count: number
  all_numeric: boolean
  avg_text_length: number
  suggested_type: string
  suggested_scale_name: string | null
  suggested_scale_labels: string[] | null
  suggested_scale_unmatched: string[] | null
  suggested_column_code: string | null
  suggested_group_code: string | null
  suggested_column_text: string
  suggested_column_name: string | null
  suggested_demographic_subtype: string | null
  numeric_format: string | null
  numeric_min: number | null
  numeric_max: number | null
}

export interface DatasetPreviewResponse {
  total_rows: number
  columns: DatasetColumnPreview[]
}

export interface DatasetColumnConfig {
  column_index: number
  skip: boolean
  column_type: string
  column_text: string
  column_code: string | null
  column_name: string | null
  group_code: string | null
  group_label: string | null
  scale_labels: string[] | null
  demographic_subtype?: string | null
}

export interface DatasetImportConfig {
  name: string
  description: string | null
  source: string | null
  column_configs: DatasetColumnConfig[]
}

export interface DatasetImportResponse {
  dataset_id: number
  columns_created: number
  rows_created: number
  values_created: number
}

export interface Dataset {
  id: number
  name: string
  description: string | null
  source: string | null
  /** User-customizable hex color (`#RRGGBB`) for dataset visual identity.
   * Null falls back to the auto-assigned palette color. */
  color: string | null
  created_at: string
  column_count: number
  row_count: number
  open_ended_count: number
}

export interface DatasetList {
  datasets: Dataset[]
  total: number
}

export interface RecodeDefinition {
  id: number
  column_id: number
  name: string
  recode_type: 'scale_map' | 'category_group' | 'reverse'
  output_type: 'numeric' | 'categorical'
  mapping: Record<string, number | string>
  exclude_values: string[] | null
  is_primary: boolean
  is_auto_detected: boolean
  source_definition_id: number | null
  sequence_order: number
  created_at: string
  updated_at: string
  unmapped_values: string[]
}

export interface RecodeDefinitionSummary {
  id: number
  name: string
  recode_type: 'scale_map' | 'category_group' | 'reverse'
  output_type: 'numeric' | 'categorical'
  mapping: Record<string, number | string>
  exclude_values: string[] | null
  is_primary: boolean
  is_auto_detected: boolean
  source_definition_id: number | null
}

export interface ValueFrequency {
  value_text: string
  count: number
  is_na: boolean
}

export interface ColumnFrequenciesResponse {
  column_id: number
  frequencies: ValueFrequency[]
  total: number
}

export interface CopyToResponse {
  created: number
  skipped: number
  skipped_columns: number[]
}

export interface DatasetColumn {
  id: number
  column_code: string | null
  column_name: string | null
  group_code: string | null
  group_label: string | null
  column_text: string
  column_type: string
  sequence_order: number
  scale_labels: string[] | null
  scale_points: number | null
  numeric_min: number | null
  numeric_max: number | null
  numeric_format: string | null
  source: string
  expression?: string | null
  depends_on_column_ids?: number[] | null
  stale?: boolean | null
  demographic_subtype?: string | null
  recode_definitions?: RecodeDefinitionSummary[]
  equivalence_group_id?: number | null
  equivalence_group_label?: string | null
  /** #353: per-column opt-out for the participant detail panel. Default true
   * for new + existing columns (set by Alembic migration server_default='1').
   * Set false to keep a sensitive column out of linked-participant profiles. */
  show_in_participant_profile?: boolean
}

export interface ComputedColumnCreate {
  column_text: string
  column_code?: string | null
  expression: string
  column_type?: string
}

export interface ComputedColumnUpdate {
  expression: string
  column_type?: string | null
}

export interface ComputedPreviewRow {
  row_id: number
  source_values: Record<string, string | null>
  result_text: string | null
  result_numeric: number | null
}

export interface ComputedPreviewResponse {
  valid: boolean
  error?: string | null
  warnings: string[]
  preview_rows: ComputedPreviewRow[]
  r_expression?: string | null
}

export interface DomainScoreColumn {
  domain_id: number
  domain_name: string
  domain_color: string | null
  metric_id: number
  stale: boolean
  /** #292: true when the domain's members span 2+ datasets but this view
   * only shows the current dataset's subset. The frontend renders
   * "{domain_name} — {subset_dataset_name} subset" + a tooltip in this case. */
  is_cross_dataset_subset: boolean
  subset_dataset_name: string | null
  member_dataset_count: number
  scores: Record<string, number | null>
}

export interface DomainScoresResponse {
  domain_scores: DomainScoreColumn[]
}

export interface DatasetValueCell {
  id: number
  value_text: string | null
  value_numeric: number | null
}

export interface DatasetDataRow {
  id: number
  participant_id: number | null
  participant_display_name: string | null
  row_identifier: string | null
  submitted_at: string | null
  values: Record<string, DatasetValueCell>
}

export interface DatasetDataResponse {
  dataset: Dataset
  columns: DatasetColumn[]
  rows: DatasetDataRow[]
}

export interface LinkParticipantResponse {
  response_id: number
  participant_id: number | null
  participant_display_name: string | null
  row_identifier: string | null
}

export interface BulkLinkResultItem {
  response_id: number
  participant_id: number | null
  participant_display_name: string | null
}

export interface BulkLinkSkippedItem {
  response_id: number
  reason: string
}

export interface BulkLinkResponse {
  linked: BulkLinkResultItem[]
  unlinked: BulkLinkResultItem[]
  skipped: BulkLinkSkippedItem[]
}

// Manual column types
export interface ManualColumnCreate {
  column_text: string
  column_type: string
  column_code?: string | null
  group_code?: string | null
  group_label?: string | null
  scale_labels?: string[] | null
  scale_values?: number[] | null
  numeric_min?: number | null
  numeric_max?: number | null
  numeric_format?: string | null
  demographic_subtype?: string | null
}

export interface ManualColumnUpdate {
  column_text?: string
  column_type?: string
  column_code?: string | null
  group_code?: string | null
  group_label?: string | null
  scale_labels?: string[] | null
  scale_values?: number[] | null
  numeric_min?: number | null
  numeric_max?: number | null
  numeric_format?: string | null
  demographic_subtype?: string | null
}

export interface ValueUpdate {
  value_text: string | null
}

export interface ValueCellResponse {
  id: number
  row_id: number
  column_id: number
  value_text: string | null
  value_numeric: number | null
}

// Append import types
export interface AppendMatchedColumn {
  csv_column_name: string
  csv_column_index: number
  column_id: number
  column_code: string | null
  column_text: string
  column_type: string
  match_method: 'code' | 'text'
}

export interface AppendUnmatchedCsvColumn {
  csv_column_name: string
  csv_column_index: number
}

export interface AppendUnmatchedColumn {
  column_id: number
  column_code: string | null
  column_text: string
}

export interface AppendPreviewRow {
  csv_row_index: number
  values: Record<string, string>
  is_duplicate: boolean
}

export interface DatasetAppendPreviewResponse {
  matched_columns: AppendMatchedColumn[]
  unmatched_csv_columns: AppendUnmatchedCsvColumn[]
  unmatched_columns: AppendUnmatchedColumn[]
  total_rows: number
  duplicate_count: number
  preview_rows: AppendPreviewRow[]
  next_row_id: string
  row_pad_width: number
}

export interface DatasetAppendResponse {
  rows_created: number
  values_created: number
  duplicates_skipped: number
  batch_id: string
  next_row_id: string
}

// Project-wide column types
export interface ProjectColumnInfo {
  id: number
  dataset_id: number
  dataset_name: string
  /** User-customizable hex color denormalized from `Dataset.color`. Null
   * means "use the auto-assigned palette color". Allows the crosswalk to
   * resolve dataset visual identity without a second query. */
  dataset_color: string | null
  column_code: string | null
  column_name: string | null
  column_text: string
  column_type: string
  scale_points: number | null
  /** Phase 4.5: full label list for mismatch v2 detection. Same shape as
   * DatasetColumn.scale_labels — null when the column has no defined scale. */
  scale_labels: string[] | null
  /** Phase 4.4: count of recode definitions on this column. Drives the
   * TypePickerPopover pre-flight gate (>0 ⇒ block type changes, link to
   * Recode Workbench). 0 when column has no recodes. */
  recode_def_count: number
  equivalence_group_id: number | null
  equivalence_group_label: string | null
}

export interface ProjectColumnListResponse {
  columns: ProjectColumnInfo[]
  total: number
}

// API functions - Datasets
export const datasetsApi = {
  preview: (projectId: number, file: File, encoding = 'utf-8') => {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('encoding', encoding)
    return api.post<DatasetPreviewResponse>(
      `/projects/${projectId}/datasets/preview`, formData,
      { headers: { 'Content-Type': 'multipart/form-data' } },
    ).then(res => res.data)
  },
  import: (projectId: number, file: File, config: DatasetImportConfig) => {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('import_config', JSON.stringify(config))
    formData.append('encoding', 'utf-8')
    return api.post<DatasetImportResponse>(
      `/projects/${projectId}/datasets/import`, formData,
      { headers: { 'Content-Type': 'multipart/form-data' } },
    ).then(res => res.data)
  },
  list: (projectId: number) =>
    api.get<DatasetList>(`/projects/${projectId}/datasets/`).then(res => res.data),
  get: (projectId: number, datasetId: number) =>
    api.get<Dataset>(`/projects/${projectId}/datasets/${datasetId}`).then(res => res.data),
  update: (projectId: number, datasetId: number, data: Partial<Pick<Dataset, 'name' | 'description' | 'color'>>) =>
    api.patch<Dataset>(`/projects/${projectId}/datasets/${datasetId}`, data).then(res => res.data),
  listColumns: (projectId: number, datasetId: number) =>
    api.get(`/projects/${projectId}/datasets/${datasetId}/columns`).then(res => res.data),
  listRows: (projectId: number, datasetId: number) =>
    api.get(`/projects/${projectId}/datasets/${datasetId}/rows`).then(res => res.data),
  getData: (projectId: number, datasetId: number) =>
    api.get<DatasetDataResponse>(`/projects/${projectId}/datasets/${datasetId}/data`).then(res => res.data),
  linkParticipant: (projectId: number, datasetId: number, rowId: number, participantId: number | null) =>
    api.patch<LinkParticipantResponse>(
      `/projects/${projectId}/datasets/${datasetId}/rows/${rowId}/link-participant`,
      { participant_id: participantId }
    ).then(res => res.data),
  bulkLinkParticipants: (projectId: number, datasetId: number, links: Array<{ response_id: number; participant_id: number | null }>) =>
    api.post<BulkLinkResponse>(
      `/projects/${projectId}/datasets/${datasetId}/rows/bulk-link-participants`,
      { links }
    ).then(res => res.data),
  createManualColumn: (projectId: number, datasetId: number, data: ManualColumnCreate) =>
    api.post<DatasetColumn>(
      `/projects/${projectId}/datasets/${datasetId}/columns/manual`,
      data
    ).then(res => res.data),
  updateManualColumn: (projectId: number, datasetId: number, columnId: number, data: ManualColumnUpdate) =>
    api.patch<DatasetColumn>(
      `/projects/${projectId}/datasets/${datasetId}/columns/${columnId}/manual`,
      data
    ).then(res => res.data),
  deleteManualColumn: (projectId: number, datasetId: number, columnId: number) =>
    api.delete(
      `/projects/${projectId}/datasets/${datasetId}/columns/${columnId}/manual`
    ).then(res => res.data),
  createComputedColumn: (projectId: number, datasetId: number, data: ComputedColumnCreate) =>
    api.post<DatasetColumn>(
      `/projects/${projectId}/datasets/${datasetId}/columns/computed`, data
    ).then(res => res.data),
  updateComputedColumn: (projectId: number, datasetId: number, columnId: number, data: ComputedColumnUpdate) =>
    api.patch<DatasetColumn>(
      `/projects/${projectId}/datasets/${datasetId}/columns/${columnId}/computed`, data
    ).then(res => res.data),
  deleteComputedColumn: (projectId: number, datasetId: number, columnId: number) =>
    api.delete(
      `/projects/${projectId}/datasets/${datasetId}/columns/${columnId}/computed`
    ).then(res => res.data),
  recomputeColumn: (projectId: number, datasetId: number, columnId: number) =>
    api.post(
      `/projects/${projectId}/datasets/${datasetId}/columns/${columnId}/recompute`
    ).then(res => res.data),
  previewComputedColumn: (projectId: number, datasetId: number, data: ComputedColumnCreate) =>
    api.post<ComputedPreviewResponse>(
      `/projects/${projectId}/datasets/${datasetId}/columns/computed/preview`, data
    ).then(res => res.data),
  getDomainScores: (projectId: number, datasetId: number) =>
    api.get<DomainScoresResponse>(
      `/projects/${projectId}/datasets/${datasetId}/domain-scores`
    ).then(res => res.data),
  updateValue: (projectId: number, datasetId: number, valueId: number, data: ValueUpdate) =>
    api.patch<ValueCellResponse>(
      `/projects/${projectId}/datasets/${datasetId}/values/${valueId}`,
      data
    ).then(res => res.data),
  appendPreview: (projectId: number, datasetId: number, file: File, encoding = 'utf-8') => {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('encoding', encoding)
    return api.post<DatasetAppendPreviewResponse>(
      `/projects/${projectId}/datasets/${datasetId}/append-preview`, formData,
      { headers: { 'Content-Type': 'multipart/form-data' } },
    ).then(res => res.data)
  },
  appendImport: (projectId: number, datasetId: number, file: File, config: {
    column_mapping: Array<{ csv_column_index: number; column_id: number }>
    skip_duplicates: boolean
    row_start_id?: string | null
  }, encoding = 'utf-8') => {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('import_config', JSON.stringify(config))
    formData.append('encoding', encoding)
    return api.post<DatasetAppendResponse>(
      `/projects/${projectId}/datasets/${datasetId}/append-import`, formData,
      { headers: { 'Content-Type': 'multipart/form-data' } },
    ).then(res => res.data)
  },
  reorderColumns: (projectId: number, datasetId: number, orderedColumnIds: number[]) =>
    api.post(
      `/projects/${projectId}/datasets/${datasetId}/columns/reorder`,
      { ordered_column_ids: orderedColumnIds }
    ).then(res => res.data),
  delete: (projectId: number, datasetId: number) =>
    api.delete(`/projects/${projectId}/datasets/${datasetId}`).then(res => res.data),
  deleteRow: (projectId: number, datasetId: number, rowId: number) =>
    api.delete(`/projects/${projectId}/datasets/${datasetId}/rows/${rowId}`).then(res => res.data),
  allColumns: (projectId: number, params?: { ungrouped?: boolean; dataset_id?: number; search?: string }) =>
    api.get<ProjectColumnListResponse>(`/projects/${projectId}/datasets/columns`, { params }).then(res => res.data),
  linkableRows: (projectId: number, datasetId: number) =>
    api.get<{ rows: LinkableRow[] }>(
      `/projects/${projectId}/datasets/${datasetId}/linkable-rows`
    ).then(res => res.data),
  updateColumnSubtype: (projectId: number, datasetId: number, columnId: number, demographicSubtype: string | null) =>
    api.patch(
      `/projects/${projectId}/datasets/${datasetId}/columns/${columnId}/subtype`,
      { demographic_subtype: demographicSubtype }
    ).then(res => res.data),
  updateColumnHeader: (projectId: number, datasetId: number, columnId: number, data: { column_name?: string | null; column_text?: string | null; show_in_participant_profile?: boolean }) =>
    api.patch<DatasetColumn>(
      `/projects/${projectId}/datasets/${datasetId}/columns/${columnId}/header`,
      data
    ).then(res => res.data),
}

// API functions - Recode
export const recodeApi = {
  list: (projectId: number, datasetId: number, columnId: number) =>
    api.get<RecodeDefinition[]>(
      `/projects/${projectId}/datasets/${datasetId}/columns/${columnId}/recodes`
    ).then(res => res.data),

  create: (projectId: number, datasetId: number, columnId: number, data: {
    name: string
    recode_type: string
    output_type: string
    mapping: Record<string, number | string>
    exclude_values?: string[] | null
    source_definition_id?: number | null
  }) =>
    api.post<RecodeDefinition>(
      `/projects/${projectId}/datasets/${datasetId}/columns/${columnId}/recodes`,
      data
    ).then(res => res.data),

  update: (projectId: number, datasetId: number, columnId: number, definitionId: number, data: {
    name?: string
    recode_type?: string
    output_type?: string
    mapping?: Record<string, number | string>
    exclude_values?: string[] | null
    is_primary?: boolean
  }) =>
    api.patch<RecodeDefinition>(
      `/projects/${projectId}/datasets/${datasetId}/columns/${columnId}/recodes/${definitionId}`,
      data
    ).then(res => res.data),

  delete: (projectId: number, datasetId: number, columnId: number, definitionId: number) =>
    api.delete(
      `/projects/${projectId}/datasets/${datasetId}/columns/${columnId}/recodes/${definitionId}`
    ).then(res => res.data),

  setPrimary: (projectId: number, datasetId: number, columnId: number, definitionId: number) =>
    api.post<RecodeDefinition>(
      `/projects/${projectId}/datasets/${datasetId}/columns/${columnId}/recodes/${definitionId}/set-primary`
    ).then(res => res.data),

  copyTo: (projectId: number, datasetId: number, columnId: number, definitionId: number, targetColumnIds: number[]) =>
    api.post<CopyToResponse>(
      `/projects/${projectId}/datasets/${datasetId}/columns/${columnId}/recodes/${definitionId}/copy-to`,
      { target_column_ids: targetColumnIds }
    ).then(res => res.data),

  getFrequencies: (projectId: number, datasetId: number, columnId: number) =>
    api.get<ColumnFrequenciesResponse>(
      `/projects/${projectId}/datasets/${datasetId}/columns/${columnId}/frequencies`
    ).then(res => res.data),

  bulkTypeUpdate: (projectId: number, datasetId: number, columnIds: number[], columnType: string) =>
    api.patch(
      `/projects/${projectId}/datasets/${datasetId}/columns/bulk-type`,
      { column_ids: columnIds, column_type: columnType }
    ).then(res => res.data),

  // Tier 3 crosswalk: return the set of column IDs in this project that
  // have any primary reverse recode. Consumed by the crosswalk's
  // ['reverse-columns', projectId] query to render the ⟲ badge on cells.
  // Phase 6.2 wires RecodeWorkbench mutations to invalidate this query.
  listReverseScoredColumns: (projectId: number): Promise<{ column_ids: number[] }> =>
    api.get<{ column_ids: number[] }>(
      `/projects/${projectId}/reverse-scored-columns`
    ).then(res => res.data),
}
