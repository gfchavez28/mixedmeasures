import api from './client'
import { datasetUploadTimeoutMs } from '../dataset-import-formats'
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
  /** #28: SPSS .sav only — the codes an ordinal scale's labels actually carry
   *  (may be 0-based or gapped), parallel to suggested_scale_labels. Null for
   *  every other format, which keeps the positional 1..N encoding. */
  suggested_scale_values: number[] | null
  suggested_scale_unmatched: string[] | null
  /** #596: SPSS's own user-missing declaration for this variable (.sav only;
   *  null for every other format). The import does NOT depend on this — it
   *  injects the same rules server-side — but the wizard needs it to show what
   *  SPSS declared. */
  suggested_missing_values?: MissingValueRule[] | null
  /** #575: the complete sorted distinct numeric values for a likely scale (all
   *  numeric + bounded cardinality), so the value-labels editor can seed every
   *  code (sample_values is capped at 5). Null for non-scale columns. */
  distinct_numeric_values: number[] | null
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
  /** .xlsx uploads only (#523): workbook sheet names for the sheet picker. */
  sheet_names?: string[] | null
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
  /** #28: parallel to scale_labels; preserves an SPSS scale's own codes. */
  scale_values?: number[] | null
  /** #592: declared missing rules for this column, carried through the wizard.
   *  Import persists them and judges every cell against them, so a declared
   *  sentinel lands with value_numeric NULL rather than feeding means. */
  missing_values?: MissingValueRule[] | null
  /** #575: the cells are numeric CODES and scale_labels/scale_values declare a
   *  code→label dictionary to substitute at import (wizard-authored value labels).
   *  Import-config only; the resulting column is byte-identical to a .sav one. */
  cells_are_codes?: boolean
  demographic_subtype?: string | null
}

export interface DatasetImportConfig {
  name: string
  description: string | null
  source: string | null
  column_configs: DatasetColumnConfig[]
  /** .xlsx uploads only (#523): which worksheet to import (omit = first sheet). */
  sheet_name?: string | null
  /** #414: column_index of the identifier column to link rows to Participants
   *  by. Omit/null = no linking. Index 0 is valid — check `!= null`. */
  participant_link_column_index?: number | null
}

/** #414: what import-time / append / retro participant linking did. */
export interface ParticipantLinkReport {
  linked: number
  created: number
  matched: number
  skipped_missing: number
  skipped_duplicate: number
  skipped_conflict: number
  already_linked: number
  duplicate_values: string[]
}

export interface DatasetImportResponse {
  dataset_id: number
  columns_created: number
  rows_created: number
  values_created: number
  // #415: values recognized as missing (N/A / refusal labels), excluded from
  // analysis per #381/#384. Disclosed on the import results screen.
  recognized_missing_count: number
  recognized_missing_labels: string[]
  /** #575: per cells-are-codes column, the observed codes with no declared label
   *  (kept numeric, never nulled), keyed by column_index. */
  value_label_unlabeled?: Record<number, number[]>
  /** #414: present iff the request asked for participant linking. */
  participant_link_report?: ParticipantLinkReport | null
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
  /**
   * #602: the authoritative reflection offset for this mapping on this column —
   * the SAME field, and the same server-side rule, that `RecodeDefinitionSummary`
   * carries on `/data`. Populated for EVERY definition type, not just `reverse`:
   * the Recode Workbench's reverse editor previews a DRAFT copied from a
   * `scale_map` source, and the number that draft must show is the one the save
   * will produce — i.e. this offset on the SOURCE's row.
   *
   * Never re-derive it from `mapping`. The client cannot see the recognized-N/A
   * rule or the column's missing declaration, so a local `min + max` previewed
   * "Never → 99" on a mapping the save (correctly) scored 5.
   */
  reverse_offset?: number | null
}

/**
 * #592: one declared missing-value rule. Two shapes, exactly one of which
 * applies — a discrete value (optionally labelled) or a numeric range.
 *
 * A range's `label` is display metadata only; it is never matched against a
 * cell, because a range covers many codes while a label substitutes for one.
 * Ranges are numeric-only (SPSS parity); a discrete `value` is a STRING because
 * the cell space is text, and string missing values are legal (.sav carries
 * them, #541b). `lo`/`hi` may each be null = unbounded (SPSS's LO/HI THRU).
 */
export type MissingValueRule =
  | { value: string; label?: string }
  | { lo: number | null; hi: number | null; label?: string }

export interface ApplyValueLabelsResult {
  column_id: number
  updated: number
  unlabeled_codes: number[]
  /** Pairs dropped because the column already declares that code missing (C4:
   *  a missing code is never a scale point). Surface these — silently absorbing
   *  them is how a researcher loses a label they thought they set. */
  missing_skipped?: number[]
  /** #584: definitions this relabel left mapping NOTHING. Substituting labels
   *  into `value_text` re-keys the column, so any definition still keyed on the
   *  old cell text stops matching — measured, four of five on a realistic
   *  column, not just a linked reverse. Reported, never silently re-derived:
   *  re-deriving changes stored numbers a researcher may already have reported. */
  staled_definitions?: RecodeDependentInfo[]
}

/** #584 step 2 — one dependent's re-derive plan row. */
export interface RederivePlanItem {
  definition_id: number
  name: string
  column_id: number
  is_primary: boolean
  /** 'ready' | 'no_change' | 'blocked'. `blocked` is a refusal, not a warning. */
  status: string
  changed_keys: string[]
  detail: string
}

export interface RederiveResult {
  updated: number[]
  skipped: number[]
  changed_values: number
}

/** #584's death arm — one mapping key the re-key would rewrite. */
export interface RekeyRename {
  old: string
  new: string
}

/** #584's death arm — one relabel-killed definition's re-key plan row. */
export interface RekeyPlanItem {
  definition_id: number
  name: string
  recode_type: string
  is_primary: boolean
  /** 'ready' | 'blocked'. There is no 'no_change' arm — every row here is a
   *  definition that already matches nothing. */
  status: string
  renames: RekeyRename[]
  /** Keys with no code to translate through — why a blocked row is blocked. */
  unresolved_keys: string[]
  detail: string
}

export interface RekeyResult {
  updated: number[]
  renamed_keys: number
}

/** A recode definition affected by a change to something it depends on (#584).
 *  `reason` says which relationship put it here: `provenance` = it names the
 *  edited definition as its source and has DRIFTED (it still maps every cell);
 *  `unmapped` = the column was re-keyed under it and it now maps nothing. */
export interface RecodeDependentInfo {
  id: number
  name: string
  recode_type: string
  column_id: number
  is_primary: boolean
  reason: 'provenance' | 'unmapped'
}

export interface MissingValuesResult {
  column_id: number
  missing_values: MissingValueRule[] | null
  /** Cells whose value_numeric was cleared. */
  nulled_rows: number
  /** Cells whose text was substituted to a rule's label ("99" → "Refused"). */
  labelled_rows: number
  /** Scale points removed because their code is now declared missing (C4). */
  stripped_scale_points: number
  /** Cells that became substantive again (un-declare / narrowed rules). */
  recovered_rows: number
  recovered_values: string[]
  /** Recovered texts the column's recode could not map back to a code — they
   *  stay text-only, for the researcher to map or label. */
  recovered_unmapped: string[]
  /** Rules that matched NO value in this column (#823a). Server-side, because
   *  the case that motivates it is invisible on screen: HTML collapses interior
   *  whitespace, so a sentinel stored with two spaces reads and types as one. */
  unmatched_rules: string[]
}

/** #798 — per-column outcomes from a bulk missing declaration. */
export interface BulkMissingValuesResult {
  applied: MissingValuesResult[]
  skipped: Array<{ column_id: number; column_label: string; reason: string }>
  /** Cells nulled across EVERY applied column — the figure the disclosure must
   *  quote on a bulk apply (#823b). The per-column `nulled_rows` understated it
   *  34x on the GSS corpus: 32,276 reported against a true 1,099,939. */
  nulled_rows_total: number
  /** Rules that matched nothing on every applied column (#823a) — the
   *  intersection, not the union; see the backend schema for why. */
  unmatched_everywhere: string[]
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
  /**
   * #600: THE reflection offset for a `reverse` definition, computed server-side
   * over the mapping's NON-null-set values (a missing or excluded key is not a
   * scale point and must not set the endpoint). Display `offset - code` with
   * this — never re-derive it from `mapping`, which cannot see the
   * recognized-N/A rule or the column's missing declaration and would drift from
   * what `value_numeric` holds (#578). ⚠️ Since #602 this is populated for every
   * definition type (a `scale_map`'s offset is what the reverse editor's draft
   * preview needs), so its presence does NOT mean "this def is a reverse" —
   * branch on `recode_type`, as `EditableCell` does. Null when the mapping has
   * no numeric scale points, and absent on payloads that don't send it (see
   * `reflectReverseValue`).
   */
  reverse_offset?: number | null
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

export interface PrimaryRecodeSummary {
  id: number
  name: string
  recode_type: string
  /**
   * The mapping sends a numeric key somewhere other than itself — a flip or a
   * collapse. ⚠️ A SHAPE test, blind to a hand-flip keyed on LABELS; it
   * describes the rule, it is NOT a safety verdict. The authority is the
   * backend's `code_identity_violation` (#793).
   */
  remaps_codes: boolean
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
  /** #576: parallel to scale_labels — the numeric code each label carries. */
  scale_values?: number[] | null
  /** #592: the column's declared missing rules, already parsed by the backend.
   *  `null` = no declaration, so the recognized-N/A defaults apply; `[]` = the
   *  researcher declared that NOTHING is missing. Rides BOTH column response
   *  schemas deliberately — /data is the only payload the editor reads, and a
   *  field on one sibling but not the other is the #586 bug class. */
  missing_values?: MissingValueRule[] | null
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
  /**
   * The rule driving this column's `value_numeric`, or null when none.
   *
   * ⚠️ Unlike `recode_definitions` — which rides ONLY the `/data` payload —
   * this is on every column response the backend builds, so `null` always
   * means "no primary" and never "this endpoint did not look".
   */
  primary_recode?: PrimaryRecodeSummary | null
  equivalence_group_id?: number | null
  equivalence_group_label?: string | null
  /**
   * Decision B provenance — the variable this one was derived FROM, and the
   * name of the rule that produced it.
   *
   * ⚠️ The two degrade INDEPENDENTLY and both readings are meaningful. Deleting
   * the source column nulls the FK (ON DELETE SET NULL) while `derived_via`
   * survives, so "derived by <rule>, source since deleted" stays sayable — a UI
   * that renders the pair only when BOTH are present throws that away.
   *
   * ⚠️ The LABEL is deliberately not on the wire: `columnDisplayLabel` is the
   * single source for naming a column (#575), and the Variables view already
   * holds every column of the dataset. Resolve it there.
   */
  derived_from_column_id?: number | null
  derived_via?: string | null
  /** #353: per-column opt-out for the participant detail panel. Default true
   * for new + existing columns (set by Alembic migration server_default='1').
   * Set false to keep a sensitive column out of linked-participant profiles. */
  show_in_participant_profile?: boolean
}

/** Whether the source's dictionary can be carried onto a derived variable. */
export interface DeriveLabelCarryPlan {
  available: boolean
  /** Populated whenever `available` is false, and the UI MUST render it — the
   *  four unavailable states send the researcher to four different places. */
  reason: string | null
  pairs: [number, string][]
}

export interface DerivePlan {
  output_type: 'numeric' | 'categorical'
  column_type: string
  mapped: [string, string][]
  unmapped_values: string[]
  missing_values_carried: string[]
  labels: DeriveLabelCarryPlan
  suggested_name: string
}

export interface DeriveColumnResult {
  created_column_id: number
  values_written: number
  unmapped_values: string[]
  missing_values_carried: string[]
  labels_carried: boolean
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

/** Where a row sits in the grid's ordering, and which page holds it (#834). */
export interface DatasetRowPosition {
  row_id: number
  /** 0-based over the WHOLE dataset, not the page — display as `index + 1`. */
  index: number
  /** The page start for `limit` — the value the grid's query key carries. */
  offset: number
  limit: number
  total_rows: number
}

export interface DatasetDataResponse {
  dataset: Dataset
  /** One PAGE of rows. For a record count read `total_rows`, never `rows.length` (#800). */
  columns: DatasetColumn[]
  rows: DatasetDataRow[]
  total_rows: number
  offset: number
  limit: number
  /**
   * participant_id -> row_identifier, DATASET-scoped (not page-scoped).
   * Backs the picker's already-linked guard; deriving it from the loaded page
   * would offer a participant already linked on another page.
   */
  linked_participants: Record<string, string>
}

/** Mirrors backend `routers/dataset.py::DATASET_PAGE_SIZE`. */
export const DATASET_PAGE_SIZE = 200

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
  /** .xlsx uploads only (#523). */
  sheet_names?: string[] | null
  /** #414 (DEC-7): offered when the dataset has exactly one identifier column
   *  and this file matched it. */
  participant_link_column?: { column_id: number; column_text: string } | null
}

export interface DatasetAppendResponse {
  rows_created: number
  values_created: number
  duplicates_skipped: number
  batch_id: string
  next_row_id: string
  /** #414: present iff the request asked for participant linking. */
  participant_link_report?: ParticipantLinkReport | null
  /** #575: appended values on a value-labelled column that didn't map to a
   *  numeric code (unknown labels/typos or undeclared codes) — stored as text
   *  with value_numeric NULL. */
  unmapped_values?: string[]
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
  preview: (projectId: number, file: File, encoding = 'utf-8', sheetName?: string) => {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('encoding', encoding)
    if (sheetName) formData.append('sheet_name', sheetName)
    return api.post<DatasetPreviewResponse>(
      `/projects/${projectId}/datasets/preview`, formData,
      { headers: { 'Content-Type': 'multipart/form-data' },
        // #796: without this the client's 30s default aborts any real
        // dataset — the parse is server-side and scales with cells.
        timeout: datasetUploadTimeoutMs(file.size) },
    ).then(res => res.data)
  },
  import: (projectId: number, file: File, config: DatasetImportConfig) => {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('import_config', JSON.stringify(config))
    formData.append('encoding', 'utf-8')
    return api.post<DatasetImportResponse>(
      `/projects/${projectId}/datasets/import`, formData,
      { headers: { 'Content-Type': 'multipart/form-data' },
        // #796: without this the client's 30s default aborts any real
        // dataset — the parse is server-side and scales with cells.
        timeout: datasetUploadTimeoutMs(file.size) },
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
  getData: (projectId: number, datasetId: number, page?: { limit?: number; offset?: number }) =>
    api.get<DatasetDataResponse>(`/projects/${projectId}/datasets/${datasetId}/data`, {
      params: { limit: page?.limit ?? DATASET_PAGE_SIZE, offset: page?.offset ?? 0 },
    }).then(res => res.data),
  /**
   * Where a row sits in the grid's ordering, and which page holds it (#834).
   *
   * ⚠️ `limit` must match the page size the grid will then request, or the
   * returned `offset` addresses a boundary the grid does not use.
   */
  rowPosition: (projectId: number, datasetId: number, rowId: number, limit: number = DATASET_PAGE_SIZE) =>
    api.get<DatasetRowPosition>(
      `/projects/${projectId}/datasets/${datasetId}/rows/${rowId}/position`,
      { params: { limit } },
    ).then(res => res.data),
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
  appendPreview: (projectId: number, datasetId: number, file: File, encoding = 'utf-8', sheetName?: string) => {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('encoding', encoding)
    if (sheetName) formData.append('sheet_name', sheetName)
    return api.post<DatasetAppendPreviewResponse>(
      `/projects/${projectId}/datasets/${datasetId}/append-preview`, formData,
      { headers: { 'Content-Type': 'multipart/form-data' },
        // #796: without this the client's 30s default aborts any real
        // dataset — the parse is server-side and scales with cells.
        timeout: datasetUploadTimeoutMs(file.size) },
    ).then(res => res.data)
  },
  linkByColumn: (projectId: number, datasetId: number, columnId: number) =>
    api.post<ParticipantLinkReport>(
      `/projects/${projectId}/datasets/${datasetId}/link-by-column`,
      { column_id: columnId }
    ).then(res => res.data),
  appendImport: (projectId: number, datasetId: number, file: File, config: {
    column_mapping: Array<{ csv_column_index: number; column_id: number }>
    skip_duplicates: boolean
    row_start_id?: string | null
    sheet_name?: string | null
    /** #414 (DEC-7): identifier column id to link the NEW rows by. */
    participant_link_column_id?: number | null
  }, encoding = 'utf-8') => {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('import_config', JSON.stringify(config))
    formData.append('encoding', encoding)
    return api.post<DatasetAppendResponse>(
      `/projects/${projectId}/datasets/${datasetId}/append-import`, formData,
      { headers: { 'Content-Type': 'multipart/form-data' },
        // #796: without this the client's 30s default aborts any real
        // dataset — the parse is server-side and scales with cells.
        timeout: datasetUploadTimeoutMs(file.size) },
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
  /** #584: definitions that name this one as their source. Fetched ON DEMAND at
   *  the moment of an edit or delete, because the point is to warn BEFORE the
   *  change — and because a dependent may live on a DIFFERENT column, which a
   *  per-column definition list cannot see. */
  dependents: (projectId: number, datasetId: number, columnId: number, definitionId: number) =>
    api.get<RecodeDependentInfo[]>(
      `/projects/${projectId}/datasets/${datasetId}/columns/${columnId}/recodes/${definitionId}/dependents`
    ).then(res => res.data),

  /** #584 step 2: what re-deriving would do. Read-only — the researcher sees
   *  WHICH values move on WHICH definitions before confirming a change to
   *  stored numbers. */
  rederivePlan: (projectId: number, datasetId: number, columnId: number, definitionId: number) =>
    api.get<RederivePlanItem[]>(
      `/projects/${projectId}/datasets/${datasetId}/columns/${columnId}/recodes/${definitionId}/re-derive/plan`
    ).then(res => res.data),

  /** #584 step 2: the confirm. ALL OR NOTHING — a blocked dependent 409s the
   *  whole batch rather than being skipped. */
  rederive: (projectId: number, datasetId: number, columnId: number, definitionId: number,
             definitionIds: number[]) =>
    api.post<RederiveResult>(
      `/projects/${projectId}/datasets/${datasetId}/columns/${columnId}/recodes/${definitionId}/re-derive`,
      { definition_ids: definitionIds }
    ).then(res => res.data),

  /** #584's death arm: what re-keying this COLUMN's relabel-killed definitions
   *  would do. Column-scoped, not definition-scoped — a relabel kills every
   *  definition keyed on the old cell text, which the provenance lookup above
   *  cannot see (measured: it finds one of four). An empty array is the
   *  ordinary answer. */
  rekeyPlan: (projectId: number, datasetId: number, columnId: number) =>
    api.get<RekeyPlanItem[]>(
      `/projects/${projectId}/datasets/${datasetId}/columns/${columnId}/re-key/plan`
    ).then(res => res.data),

  /** #584's death arm: the confirm. ALL OR NOTHING — a blocked definition 409s
   *  the whole batch rather than being skipped. */
  rekey: (projectId: number, datasetId: number, columnId: number, definitionIds: number[]) =>
    api.post<RekeyResult>(
      `/projects/${projectId}/datasets/${datasetId}/columns/${columnId}/re-key`,
      { definition_ids: definitionIds }
    ).then(res => res.data),

  setPrimary: (projectId: number, datasetId: number, columnId: number, definitionId: number) =>
    api.post<RecodeDefinition>(
      `/projects/${projectId}/datasets/${datasetId}/columns/${columnId}/recodes/${definitionId}/set-primary`
    ).then(res => res.data),

  /** Decision B — what deriving this rule into a NEW variable would do.
   *  Read-only, and served by the same function the create uses, so the preview
   *  cannot disagree with the operation. */
  derivePlan: (projectId: number, datasetId: number, columnId: number, definitionId: number) =>
    api.get<DerivePlan>(
      `/projects/${projectId}/datasets/${datasetId}/columns/${columnId}/recodes/${definitionId}/derive-plan`
    ).then(res => res.data),

  deriveColumn: (
    projectId: number, datasetId: number, columnId: number, definitionId: number,
    body: { column_text: string; carry_labels: boolean },
  ) =>
    api.post<DeriveColumnResult>(
      `/projects/${projectId}/datasets/${datasetId}/columns/${columnId}/recodes/${definitionId}/derive-column`,
      body
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

  // #576/#577: declare a code→label dictionary for a numbers-only column.
  // `column_type` omitted / null = keep the column's current type (C5) — the
  // dialog must not force a type just because labels were edited.
  applyValueLabels: (
    projectId: number, datasetId: number, columnId: number,
    data: { labels: { value: number; label: string }[]; column_type?: string | null },
  ) =>
    api.post<ApplyValueLabelsResult>(
      `/projects/${projectId}/datasets/${datasetId}/columns/${columnId}/value-labels`,
      data
    ).then(res => res.data),

  // #592: declare which of a column's values are NOT real answers.
  // `rules: null` un-declares (the recognized-N/A defaults apply again);
  // `rules: []` declares that nothing is missing. Touches no scale metadata and
  // never the column type, so it is the only path for a missing-only
  // declaration on a continuous column (e.g. -99 THRU -1 on `age`).
  /**
   * #798: apply ONE missing vocabulary to many columns.
   *
   * Real survey data carries one sentinel set across every variable — GSS's
   * five `.x:` codes span all 41 of its columns — while `setMissingValues` is
   * column-at-a-time. Outcomes are PER COLUMN: a column whose own data makes a
   * rule label ambiguous (#606) is skipped and named, and the rest still apply.
   */
  bulkSetMissingValues: (
    projectId: number, datasetId: number, columnIds: number[],
    rules: MissingValueRule[] | null,
  ) =>
    api.post<BulkMissingValuesResult>(
      `/projects/${projectId}/datasets/${datasetId}/columns/bulk-missing-values`,
      { column_ids: columnIds, rules },
    ).then(res => res.data),
  setMissingValues: (
    projectId: number, datasetId: number, columnId: number,
    rules: MissingValueRule[] | null,
  ) =>
    api.put<MissingValuesResult>(
      `/projects/${projectId}/datasets/${datasetId}/columns/${columnId}/missing-values`,
      { rules }
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
