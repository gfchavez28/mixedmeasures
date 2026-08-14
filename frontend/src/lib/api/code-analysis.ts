import api from './client'

// Code Analysis types
export interface CodeFrequencyItem {
  code_id: number
  code_name: string
  code_color: string | null
  is_universal: boolean
  category_id: number | null
  category_name: string | null
  category_color: string | null
  segment_count: number
  segment_percentage: number
  conversation_count: number
  conversation_percentage: number
  // Emitted since Observations; the client type omitted both for a year, which
  // is why the summary table could only model two source kinds (#679).
  document_count: number
  document_percentage: number
  observation_count: number
  observation_percentage: number
  participant_count: number
  participant_percentage: number
  text_count: number
  text_percentage: number
  row_count: number
  row_percentage: number
}

export interface CodeFrequencySummary {
  frequencies: CodeFrequencyItem[]
  total_coded_segments: number
  total_conversations: number
  total_participants: number
  total_codes_active: number
  unlinked_speaker_count: number
  total_coded_texts: number
  total_rows: number
  source: string
}

export interface ContextSegment {
  id: number
  sequence_order: number
  speaker_name: string | null
  speaker_color_index: number
  speaker_color: string | null
  is_facilitator: boolean
  text: string
  start_time: number | null
}

/** A sub-clip quote's span, in absolute timeline seconds (slab 5c/D29). */
export interface QuoteRange {
  start_time: number
  end_time: number
}

export interface CodedSegmentWithContext {
  id: number
  sequence_order: number
  speaker_name: string | null
  speaker_color_index: number
  speaker_color: string | null
  is_facilitator: boolean
  text: string
  start_time: number | null
  /** Observation clips only (D25): start_time+end_time = the timecode RANGE; conv/doc rows carry null. */
  end_time: number | null
  is_quoted: boolean
  /** Observation clips only (slab 5c): the SUB-CLIP quote ranges on this clip.
   * A whole-clip quote contributes nothing here — it has no range of its own,
   * and `is_quoted` already carries it. */
  quote_ranges: QuoteRange[]
  applied_code_ids: number[]
  preceding_context: ContextSegment[]
  following_context: ContextSegment[]
  participant_id: number | null
  participant_name: string | null
}

export interface ConversationSegmentGroup {
  conversation_id: number
  conversation_name: string
  segment_count: number
  segments: CodedSegmentWithContext[]
}

export interface DocumentSegmentGroup {
  document_id: number
  document_name: string
  segment_count: number
  segments: CodedSegmentWithContext[]
}

export interface ObservationSegmentGroup {
  observation_id: number
  observation_name: string
  /** The recording's length — the occurrence strip's denominator. Nullable:
   * pre-#574 .mov/.webm rows hold NULL, so consumers degrade to max clip end. */
  media_duration_seconds: number | null
  segment_count: number
  segments: CodedSegmentWithContext[]
}

export interface CodeSegmentsWithContextResponse {
  code_id: number
  code_name: string
  code_color: string | null
  category_name: string | null
  total_segments: number
  has_more: boolean
  conversations: ConversationSegmentGroup[]
  documents: DocumentSegmentGroup[]
  observations: ObservationSegmentGroup[]
}

export interface DemographicFilterValue {
  value: string
  participant_ids: number[]
  count: number
}

export interface DemographicFilter {
  subtype: string
  label: string
  values: DemographicFilterValue[]
}

export interface ConversationOption {
  id: number
  name: string
}

export interface DemographicFilterOptionsResponse {
  filters: DemographicFilter[]
  conversations: ConversationOption[]
}

export interface CooccurrenceCodeInfo {
  id: number
  name: string
  color: string | null
  category_name: string | null
  category_color?: string | null
  is_universal: boolean
}

export interface CooccurrenceMatrixResponse {
  codes: CooccurrenceCodeInfo[]
  matrix: number[][]
  max_cooccurrence: number
  total_coded_segments: number
  total_coded_texts: number
  source: string
}

// Coded texts (QualitativeAnalysisView Examples tab)
export interface CodedTextInfo {
  dataset_value_id: number
  value_text: string
  word_count: number
  row_identifier: string | null
  dataset_name: string
  column_name: string
  applied_code_ids: number[]
}

export interface DatasetTextGroup {
  dataset_id: number
  dataset_name: string
  text_count: number
  texts: CodedTextInfo[]
}

export interface CodeTextsResponse {
  code_id: number
  code_name: string
  code_color: string | null
  category_name: string | null
  total_texts: number
  has_more: boolean
  datasets: DatasetTextGroup[]
}

export interface CodeAnalysisFilterParams {
  code_ids?: string
  exclude_facilitator?: boolean
  conversation_ids?: string
  participant_ids?: string
  text_column_ids?: string
  document_ids?: string
  observation_ids?: string
  source?: 'conversations' | 'text' | 'all'
  level?: 'segment' | 'source'
  /** Track J · J1 item 4 — comma-separated coder (user) IDs; omit = all coders. */
  coder_ids?: string
  /** Track J · J2-5 — analysis coding layer: 'human' (default) or 'consensus'. */
  layer_scope?: 'human' | 'consensus'
}

// Source Frequencies
export interface SourceFrequenciesRequest {
  code_ids?: number[] | null
  conversation_ids?: number[] | null
  text_column_ids?: number[] | null
  document_ids?: number[] | null
  observation_ids?: number[] | null
  exclude_facilitator?: boolean
  participant_ids?: number[] | null
  group_by_subtype?: string | null
  aggregation?: 'code' | 'category'
  /** Track J · J1 item 4 — coder (user) IDs to include; null/omit = all coders. */
  coder_ids?: number[] | null
  /** Track J · J2-5 — analysis coding layer: 'human' (default) or 'consensus'. */
  layer_scope?: 'human' | 'consensus' | null
}

export interface CodeCountEntry {
  count: number
  word_count: number
}

export interface SourceGroupData {
  total_segments: number
  total_word_count: number
  coded_segments: number
  code_counts: Record<string, CodeCountEntry>
}

/**
 * The kinds of source a code can be applied in — THE enumeration (#679).
 *
 * Declared once, here, because this is the type a new backend source kind must
 * touch: it is the shape of the wire. Every consumer that renders per-kind
 * columns, labels or icons should key a `Record<SourceKind, …>` off this, so a
 * fifth kind is a compile error at each consumer rather than a silently missing
 * column (which is exactly what #679 was — a table modelling two kinds while
 * the payload carried four).
 */
export type SourceKind = 'conversation' | 'text_column' | 'document' | 'observation'

export interface SourceEntry {
  source_type: SourceKind
  source_id: number
  source_label: string
  dataset_id: number | null
  dataset_name: string | null
  total_segments: number
  total_word_count: number
  coded_segments: number
  import_order: number | null
  code_counts: Record<string, CodeCountEntry> | null
  groups: Record<string, SourceGroupData> | null
}

export interface SourceFrequenciesTotals {
  total_segments: number
  total_word_count: number
  coded_segments: number
  total_sources: number
  total_conversations: number
  total_documents: number
  total_observations: number
  total_text_columns: number
  /**
   * #749 — `coded_segments` above pools transcript segments AND coded texts.
   * These split it, so a "% of coded texts" is never divided by a total that
   * also counted segments.
   */
  coded_transcript_segments: number
  coded_texts: number
  total_participants: number
  total_records: number
  unlinked_speaker_count: number
}

export interface CodeInfo {
  id: number
  name: string
  color: string | null
  category_id: number | null
  category_name: string | null
  category_color?: string | null
  is_universal: boolean
  numeric_id: number
  /**
   * #749 — the two counts a client CANNOT derive from `sources`: one
   * participant speaks across conversations and one record can be coded in
   * several text columns, so summing per-source counts double-counts them.
   * Under `aggregation: 'category'` these are per-CATEGORY, keyed by the same
   * id the `codes` entry carries.
   */
  participant_count: number
  record_count: number
}

export interface SourceFrequenciesResponse {
  codes: CodeInfo[]
  sources: SourceEntry[]
  totals: SourceFrequenciesTotals
  group_by: string | null
}

// Demographic Comparison
export interface DemographicComparisonRequest {
  code_ids?: number[] | null
  group_by_subtype: string
  conversation_ids?: number[] | null
  text_column_ids?: number[] | null
  exclude_facilitator?: boolean
  participant_ids?: number[] | null
  /** Track J · J1 item 4 — coder (user) IDs to include; null/omit = all coders. */
  coder_ids?: number[] | null
  /** Track J · J2-5 — analysis coding layer: 'human' (default) or 'consensus'. */
  layer_scope?: 'human' | 'consensus' | null
}

export interface GroupTotal {
  total_segments: number
  total_word_count: number
}

export interface GroupCodeStats {
  count: number
  proportion: number
}

export interface StatTestResult {
  method: string
  statistic: number | null
  p_value: number
  significant: boolean
  effect_size: number | null
  effect_size_label: string | null
}

export interface CodeComparisonEntry {
  code_id: number
  code_name: string
  category_name: string | null
  by_group: Record<string, GroupCodeStats>
  delta_proportion: number | null
  test: StatTestResult | null
}

export interface DemographicComparisonResponse {
  groups: string[]
  group_totals: Record<string, GroupTotal>
  codes: CodeComparisonEntry[]
}

// Saturation
export interface SaturationPoint {
  source_index: number
  source_label: string
  source_type: string
  cumulative_unique_codes: number
  new_codes_this_source: number
  new_code_names: string[]
}

export interface SaturationResponse {
  points: SaturationPoint[]
  total_unique_codes: number
  total_sources: number
  category_level: boolean
}

// Reconciliation grid (Track J · J2-5 M-1)
export interface ReconciliationCoder {
  id: number
  name: string
}

export interface ReconciliationCodeInfo {
  id: number
  name: string
  color: string | null
}

export interface ReconciliationConsensusContext {
  rule: string // "unanimous" | "majority"
  agree: number
  voters: number
}


// ── Open-cut reliability (Observations slab 6b-A) ────────────────────────────

/**
 * What the computation did to the data before measuring it. Not diagnostics —
 * REPRODUCIBILITY: each field is a modelling choice that moves the result.
 */
export interface OpenCutDisclosure {
  tick_ms: number
  continuum_seconds: number
  /** 'recording' | 'marked_extent' — a fallback denominator must never be shown
   *  as if it were the recording's true length (#622's lesson). */
  extent_source: string
  n_merged_overlaps: number
  n_zero_length_dropped: number
  n_clips_without_times: number
  engaged_coder_ids: number[]
  excluded_coder_ids: number[]
}

export interface UnitizingCategoryResult {
  code_id: number
  code_name: string
  n_units: number
  alpha: number | null
  interpretation: string | null
  /** Share of the continuum marked with this code — alpha's own prevalence.
   *  Deliberately NOT the same denominator as binned kappa's `prevalence`. */
  coverage_fraction: number | null
}

export interface UnitizingAlphaResponse {
  available: boolean
  reason: string | null
  n_coders: number
  coders: number[]
  overall: { alpha: number | null; interpretation: string | null } | null
  per_category: UnitizingCategoryResult[]
  disclosure: OpenCutDisclosure
  interpretation_thresholds: Record<string, number>
}

export interface BinnedKappaCodeResult {
  code_id: number
  code_name: string
  n_bins: number
  percent_agreement: number | null
  cohens_kappa: number | null
  krippendorff_alpha: number | null
  /** Always rendered beside the coefficient: most bins are empty on a long
   *  recording, so percent agreement can read ~99% while kappa collapses. */
  prevalence: number | null
  interpretation: string | null
}

export interface BinnedKappaResponse {
  available: boolean
  reason: string | null
  n_coders: number
  coders: number[]
  bin_seconds: number
  n_bins: number
  per_code: BinnedKappaCodeResult[]
  disclosure: OpenCutDisclosure
  interpretation_thresholds: Record<string, number>
}

export interface ReconciliationUnit {
  /** A clip IS a Segment, so an observation unit is still 'segment'. */
  unit_type: 'segment' | 'dataset_value'
  unit_id: number
  source_type: 'conversation' | 'document' | 'observation' | 'column'
  source_id: number
  source_label: string
  text: string
  /**
   * Observation clips only in practice: a clip's identity is its time range,
   * because `text` holds just its label and is routinely empty. Note the backend
   * field is a plain `str`, so an unknown kind arriving here fails SILENTLY at
   * runtime (types erase) rather than 500ing — the inverse of the Literal trap.
   */
  start_time: number | null
  end_time: number | null
  /** coderId → effective code ids they applied here (an engaged coder who left it blank → []). */
  by_coder: Record<string, number[]>
  /** source-engaged coder ids (Option B: reviewed the source). */
  engaged: number[]
  /** effective code ids in the derived consensus. */
  consensus: number[]
  /** effective code id → {rule, agree, voters}. */
  consensus_context: Record<string, ReconciliationConsensusContext>
  has_disagreement: boolean
}

export interface ReconciliationResponse {
  available: boolean
  reason: string | null
  n_coders: number
  coders: ReconciliationCoder[]
  codes: ReconciliationCodeInfo[]
  units: ReconciliationUnit[]
  total: number
  has_more: boolean
}

export interface ReconciliationParams {
  source_type?: 'conversation' | 'document' | 'observation' | 'column'
  source_id?: number
  disagreements_only?: boolean
  coder_ids?: string
  limit?: number
  offset?: number
}

export interface RecomputeConsensusResponse {
  recomputed: number
  remaining: number
}

// Consensus-layer status (Track J · J2-5 M-2)
export interface ConsensusStatus {
  /** GLOBAL roster gate — the instance has >=2 selectable coders. */
  enabled: boolean
  /** This project has materialized consensus rows (offer the consensus view only when true). */
  exists: boolean
  /** Pending ConsensusStaleTarget markers for this project (>0 = consensus may be out of date). */
  stale_count: number
}

// Inter-rater reliability (Track J · J2-4 / J2-5 display)
export interface IrrCoderInfo {
  id: number
  name: string
}

export interface IrrCodeResult {
  code_id: number
  code_name: string
  n_units: number
  percent_agreement: number | null
  prevalence: number | null
  cohens_kappa: number | null
  kappa_interpretation: string | null
  krippendorff_alpha: number | null
  alpha_interpretation: string | null
}

export interface IrrThresholds {
  kappa?: Record<string, number>
  alpha?: Record<string, number>
}

export interface IrrResponse {
  available: boolean
  reason: string | null
  n_coders: number
  coders: IrrCoderInfo[]
  /** "kappa+alpha" (exactly 2 coders) | "alpha" (n coders). */
  metric_label: string | null
  per_code: IrrCodeResult[]
  overall_alpha: number | null
  overall_alpha_interpretation: string | null
  interpretation_thresholds: IrrThresholds
}

export interface IrrParams {
  /** Comma-separated coder IDs; omit = all roster coders (the display always omits). */
  coder_ids?: string
}

// Text columns
export interface TextColumnInfo {
  column_id: number
  column_name: string | null
  column_text: string
  dataset_id: number
  dataset_name: string
  coded_count: number
}

/** Track J · Group A (#3/#13): a coder who has real codings in scope. */
export interface CoderCoverageItem {
  user_id: number
  username: string
  display_color: string | null
  archived: boolean
}

export interface CoderCoverageResponse {
  coders: CoderCoverageItem[]
  count: number
}

// API functions - Code Analysis
export const codeAnalysisApi = {
  frequencies: (projectId: number, params?: CodeAnalysisFilterParams) =>
    api.get<CodeFrequencySummary>(`/projects/${projectId}/code-analysis/frequencies`, { params }).then(r => r.data),

  segmentsWithContext: (projectId: number, codeId: number, params?: CodeAnalysisFilterParams & {
    context_size?: number
    limit?: number
    offset?: number
  }) =>
    api.get<CodeSegmentsWithContextResponse>(
      `/projects/${projectId}/code-analysis/codes/${codeId}/segments`, { params }
    ).then(r => r.data),

  demographicFilters: (projectId: number) =>
    api.get<DemographicFilterOptionsResponse>(`/projects/${projectId}/code-analysis/demographic-filters`).then(r => r.data),

  /** Track J · Group A (#3/#13): distinct coders who coded a source — or, with no
   *  source selector, anywhere in the project. Derived from codings (not the
   *  roster); includes archived coders (flagged), excludes system coders. */
  coderCoverage: (projectId: number, params?: {
    conversation_id?: number
    document_id?: number
    observation_id?: number
    text_column_ids?: string
  }) =>
    api.get<CoderCoverageResponse>(
      `/projects/${projectId}/code-analysis/coder-coverage`, { params }
    ).then(r => r.data),

  textsWithContext: (projectId: number, codeId: number, params?: {
    participant_ids?: string
    text_column_ids?: string
    /** Track J · J1 item 4 — comma-separated coder (user) IDs; omit = all coders. */
    coder_ids?: string
    /** Track J · J2-5 — analysis coding layer: 'human' (default) or 'consensus'. */
    layer_scope?: 'human' | 'consensus'
    limit?: number
    offset?: number
  }) =>
    api.get<CodeTextsResponse>(
      `/projects/${projectId}/code-analysis/codes/${codeId}/texts`, { params }
    ).then(r => r.data),

  cooccurrence: (projectId: number, params?: CodeAnalysisFilterParams) =>
    api.get<CooccurrenceMatrixResponse>(`/projects/${projectId}/code-analysis/cooccurrence`, { params }).then(r => r.data),

  sourceFrequencies: (projectId: number, data: SourceFrequenciesRequest) =>
    api.post<SourceFrequenciesResponse>(`/projects/${projectId}/code-analysis/source-frequencies`, data)
      .then(r => r.data),

  demographicComparison: (projectId: number, data: DemographicComparisonRequest) =>
    api.post<DemographicComparisonResponse>(`/projects/${projectId}/code-analysis/demographic-comparison`, data)
      .then(r => r.data),

  saturation: (projectId: number, params?: { exclude_facilitator?: boolean; category_level?: boolean; conversation_ids?: string; document_ids?: string; observation_ids?: string; coder_ids?: string; layer_scope?: 'human' | 'consensus' }) =>
    api.get<SaturationResponse>(`/projects/${projectId}/code-analysis/saturation`, { params })
      .then(r => r.data),

  textColumnsWithCoding: (projectId: number) =>
    api.get<TextColumnInfo[]>(`/projects/${projectId}/code-analysis/text-columns`)
      .then(r => r.data),

  // Track J · J2-5 M-2 — drives the layer selector's "offer consensus only when it exists".
  consensusStatus: (projectId: number) =>
    api.get<ConsensusStatus>(`/projects/${projectId}/code-analysis/consensus-status`).then(r => r.data),

  // Track J · J2-5 M-1 — reconciliation grid: per-unit coder pivot + live-derived consensus.
  reconciliation: (projectId: number, params?: ReconciliationParams) =>
    api.get<ReconciliationResponse>(`/projects/${projectId}/code-analysis/reconciliation`, { params }).then(r => r.data),

  // Track J · J2-5 M-3 — sync the stored consensus layer on demand (bounded sweep).
  recomputeConsensus: (projectId: number) =>
    api.post<RecomputeConsensusResponse>(`/projects/${projectId}/code-analysis/recompute-consensus`, {}).then(r => r.data),

  // Track J · J2-4/J2-5 — inter-rater reliability (κ / α / % agreement) over the human roster.
  irr: (projectId: number, params?: IrrParams) =>
    api.get<IrrResponse>(`/projects/${projectId}/code-analysis/irr`, { params }).then(r => r.data),

  /** Unitizing agreement for ONE observation with open cuts (slab 6b-A). */
  unitizingAlpha: (projectId: number, observationId: number, params?: { coder_ids?: string }) =>
    api.get<UnitizingAlphaResponse>(
      `/projects/${projectId}/code-analysis/unitizing-alpha`,
      { params: { observation_id: observationId, ...params } },
    ).then(r => r.data),

  /** Time-binned agreement for ONE observation with open cuts (slab 6b-A). */
  binnedKappa: (projectId: number, observationId: number, params?: { bin_seconds?: number; coder_ids?: string }) =>
    api.get<BinnedKappaResponse>(
      `/projects/${projectId}/code-analysis/binned-kappa`,
      { params: { observation_id: observationId, ...params } },
    ).then(r => r.data),

  // Track J · J2-5 blind mode (DEC-G) — log that a coder broke blindness (audit trail).
  revealBlindMode: (projectId: number, body: { surface?: string }) =>
    api.post<{ logged: boolean }>(`/projects/${projectId}/code-analysis/reveal`, body).then(r => r.data),
}
