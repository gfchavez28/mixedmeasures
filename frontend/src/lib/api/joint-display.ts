import api from './client'
import { EXPORT_TIMEOUT_MS } from './download'
import type { LayerScope } from '@/lib/coding-layers'
import type { CodeSegmentsWithContextResponse } from './code-analysis'

/**
 * The joint display's wire (ROADMAP row 56; `backend/app/schemas/joint_display.py`).
 *
 * The display itself lives on a canvas node (`components/canvas/extensions/joint-display.ts`,
 * D162); these are the three reads it makes: its live NUMBERS (D165–D172), one group's coded
 * PASSAGES a pin is chosen from (D209), and the live FACTS a pin's attribution is derived from
 * (D210 — D163.4: never stored).
 *
 * 🔴 The vocabulary these payloads carry (`unit`, `summary`, `formed_groups`, the effect and
 * rating reasons, a strand's status) is the SERVER's (D207); its client statement is
 * `lib/joint-display-vocabulary.ts`, held to the Python by a contract test.
 */

/** Slice 1's row request — the server still reads it as the implicit pair (r1-2). */
export interface JointDisplayLegacyRowRequest {
  key: string
  code_ids: number[]
  column_ids: number[]
  codes_marked_formed: boolean
  variables_marked_formed: boolean
}

/** Joint display slice 2 (r1-1): one strand, as stored minus its label. */
export interface JointDisplayStrandRequest {
  key: string
  kind: 'codes' | 'text_codes' | 'variables' | 'observation_codes'
  /** Per kind: null = every source of the kind; a list = exactly those ([] = none, #1297). */
  conversation_ids: number[] | null
  document_ids: number[] | null
  observation_ids: number[] | null
  /** text_codes (r4-1): the open-text columns — [] = none. */
  text_column_ids?: number[]
  dataset_id: number | null
}

export interface JointDisplayRowRequest {
  key: string
  bindings: Record<string, { code_ids: number[]; column_ids: number[]; marked_formed: boolean }>
}

export interface JointDisplayComputeRequest {
  group_by_column_id: number
  strands: JointDisplayStrandRequest[]
  /** D175 — blind mode as the comparison does it. */
  coder_ids: number[] | null
  layer_scope: LayerScope
  /** D172 — the coded difference's Newcombe interval, off by default. */
  newcombe: boolean
  rows: JointDisplayRowRequest[]
}

export interface JointDisplayGroup {
  key: string
  participants: number
  /** #1626 (D243): the code strand's denominator and, of it, those with NO coding in
   *  scope. `null` when the display binds no code (no code strand to describe). */
  with_material: number | null
  without_coding: number | null
}

export interface JointDisplayRatingBasis {
  basis: string
  score_basis: string
  scope: string
  excluded_ratings: Record<string, number>
  unavailable_reason: string | null
}

export interface JointDisplayRatingCell {
  mean: number | null
  n: number
  undefined_reason: string | null
}

export interface JointDisplayCodeCell {
  group: string
  count: number
  n: number
  share: number | null
  share_undefined_reason: string | null
  passages: number
  rating: JointDisplayRatingCell | null
}

export interface JointDisplayDifference {
  value: number | null
  ci_lower: number | null
  ci_upper: number | null
  ci_level: number | null
  ci_method: string | null
  unavailable_reason: string | null
}

export interface JointDisplayCodeStrand {
  code_id: number
  name: string
  unit: string
  rated: boolean
  formed_groups: string | null
  cells: JointDisplayCodeCell[]
  difference: JointDisplayDifference
}

export interface JointDisplayCategoryCount {
  label: string
  count: number
  share: number | null
}

export interface JointDisplayVariableCell {
  group: string
  n: number
  mean: number | null
  mean_undefined_reason: string | null
  sd: number | null
  sd_undefined_reason: string | null
  distribution: JointDisplayCategoryCount[]
}

export interface JointDisplayEffect {
  d: number | null
  ci_lower: number | null
  ci_upper: number | null
  ci_level: number
  ci_method: string
  unavailable_reason: string | null
}

export interface JointDisplayVariableStrand {
  column_id: number
  name: string
  dataset_id: number
  unit: string
  formed_groups: string | null
  summary: string | null
  unavailable_reason: string | null
  categories: string[]
  cells: JointDisplayVariableCell[]
  effect: JointDisplayEffect | null
}

/** Slice 2 (r1-4): one code on an observation strand — clips, beside the groups. */
export interface JointDisplayObservationCode {
  code_id: number
  name: string
  unit: string
  /** r1-4 (L2): in the strand's OWN unit — sessions, then time, then clips where agreed. */
  observations: number
  of_observations: number
  seconds: number
  observed_seconds: number | null
  time_share: number | null
  time_share_undefined_reason: string | null
  clips: number | null
  of_clips: number | null
  clips_undefined_reason: string | null
  rating_unavailable_reason: string | null
}

/** Slice 2: what one row draws from one strand — only its kind's list is filled. */
export interface JointDisplayRowStrand {
  kind: string
  status: string
  codes: JointDisplayCodeStrand[]
  variables: JointDisplayVariableStrand[]
  observation_codes: JointDisplayObservationCode[]
  missing_code_ids: number[]
  missing_column_ids: number[]
  /** #1665 (D336) — bound variables of another dataset than the strand reads (D205): in the
   *  project, so never in `missing_column_ids`. Absent on a response that predates it. */
  other_dataset_column_ids?: number[]
  /** #1659 — why `status` is "not_measured" (`SERVER_VOCABULARY.STRAND_NOT_MEASURED_*`); null
   *  when it covers. Absent on a response that predates it (then the place says no cause). */
  not_measured_reason?: string | null
}

/** #1639 follow-up (r1-8): a bound code inactive in the codebook — out of the numbers, and said;
 *  `merged_into_*` names the code a merge moved its coding into, when the audit trail says so. */
export interface JointDisplayInactiveCode {
  strand_key: string
  code_id: number
  name: string
  merged_into_id: number | null
  merged_into_name: string | null
}

export interface JointDisplayRowResult {
  key: string
  /** Slice 1's: every per-group strand's results of the kind, in display order (r1-3). */
  codes: JointDisplayCodeStrand[]
  variables: JointDisplayVariableStrand[]
  missing_code_ids: number[]
  missing_column_ids: number[]
  /** #1665 (D336) — every strand's other-dataset variables (the Compact view and report say them
   *  apart from the gone ones). Optional until every fixture carries it. */
  other_dataset_column_ids?: number[]
  /** #1639 follow-up (r1-8). Optional until every fixture carries it. */
  inactive_codes?: JointDisplayInactiveCode[]
  strands: { codes: string; variables: string }
  /** Slice 2: strand key → this row's results from it. Optional until every fixture carries it. */
  by_strand?: Record<string, Pick<JointDisplayRowStrand, 'codes' | 'variables' | 'observation_codes'> & Partial<JointDisplayRowStrand>>
}

/** Slice 2: one strand's display-level facts. */
export interface JointDisplayStrandResult {
  key: string
  kind: string
  unit: string
  dataset_id: number | null
  groups: { key: string; with_material: number | null; without_coding: number | null; surveyed: number | null }[] | null
  scope: JointDisplayComputeResponse['scope'] | null
  observations: { chosen: number; with_coding: number; agreed: number; observed_seconds: number | null; segmentation: string | null } | null
}

export interface JointDisplayComputeResponse {
  unit: string
  group_by: { column_id: number; name: string; dataset_id: number; dataset_name: string | null }
  groups: JointDisplayGroup[]
  unavailable_reason: string | null
  scope: {
    conversations: number
    documents: number
    unassigned_passages: number
    participants_without_group: number
    /** #1626 (D244): whose coding `groups[i].without_coding` is about. */
    no_coding_scope: string
  }
  rating: JointDisplayRatingBasis | null
  /** Slice 2: every strand's display-level facts, in display order. */
  strands?: JointDisplayStrandResult[]
  rows: JointDisplayRowResult[]
}

export interface JointDisplayPassagesRequest {
  group_by_column_id: number
  group: string
  code_id: number
  conversation_ids: number[] | null
  document_ids: number[] | null
  /** Joint display slice 2 (r4-1, R9): the PIN'S STRAND's open-text columns — the SAME list
   *  that strand counts, so a suggestion is a passage the numbers count (D209). `[]` = none. */
  text_column_ids: number[]
  coder_ids: number[] | null
  layer_scope: LayerScope
  /** D102 — sent true ONLY while blind mode withholds. */
  chips_follow_coder_ids: boolean
  limit: number
  offset: number
}

/** Joint display slice 2 (r4-2): one coded open-text answer a pin may quote — always WHOLE. */
export interface JointDisplayAnswerPassage {
  dataset_value_id: number
  text: string
  column_id: number
  /** "Dataset › Column" — the quote's own `source_name`, so the picker and the pin agree. */
  source_name: string
  participant_id: number
  participant_name: string | null
  is_quoted: boolean
}

/** D209's answer plus the group's coded answers (`total_segments` counts them too). */
export interface JointDisplayPassagesResponse extends CodeSegmentsWithContextResponse {
  answer_total: number
  answers: JointDisplayAnswerPassage[]
}

export interface JointDisplayPinFact {
  excerpt_id: number
  participant_id: number | null
  participant_identifier: string | null
  speaker_label: string | null
  source_name: string
  /** Joint display slice 2 (R8, r4-4): `SERVER_VOCABULARY.PIN_SOURCE_*` — an answer's
   *  attribution says "Survey answer (…)". Optional: a fact read before slice 2 has none. */
  source_kind?: string | null
  column_value: string | null
}

/** `POST …/pin-facts`'s answer — the pins, and whether the attribution column was left out. */
export interface JointDisplayPinFactsResponse {
  pins: JointDisplayPinFact[]
  /** #1615: the column comes from participant scores and the reader is blind — every pin's
   *  `column_value` is null because it was LEFT OUT, never because it has no value. */
  column_withheld?: boolean
  /** #1615 D286: that column's name, when `column_withheld` (the display's note names it); since
   *  #1653 (D346) also when `column_unusable` is "ineligible". */
  column_name?: string | null
  /** #1653 (D346): why the attribution column could not be read — `PIN_ATTRIBUTION_GONE` or
   *  `PIN_ATTRIBUTION_INELIGIBLE`. Every pin keeps who said it and where; `column_value` is null. */
  column_unusable?: 'gone' | 'ineligible' | null
}

// ── Joint display slice 2 — the case-ordered view (D173; `services/joint_display_cases.py`) ──

export interface JointDisplayCasesRequest {
  group_by_column_id: number
  conversation_ids: number[] | null
  document_ids: number[] | null
  /** The compute's own strands (r1; R10 — r3's stub re-pointed); absent = slice 1's implicit
   *  pair, keys 'codes' and 'variables'. An observation strand is never a case column. */
  strands?: JointDisplayStrandRequest[]
  coder_ids: number[] | null
  layer_scope: LayerScope
  row_key: string
  bindings: Record<string, { code_ids?: number[]; column_ids?: number[] }>
  rule?: { conditions: Record<string, unknown>[] } | null
  /** 'list' = the misfit list (r3-12): the rule's cases, less the removed, plus the added. */
  only?: 'all' | 'list'
  added_participant_ids?: number[]
  removed_participant_ids?: number[]
  offset?: number
  limit?: number
}

export interface JointDisplayCaseFacts {
  has_material: boolean | null
  coded: boolean | null
  codes: { code_id: number; passages: number; used: boolean | null }[]
  values: { column_id: number; value: number | null; label: string | null; reason: string | null }[]
}

export interface JointDisplayCasesResponse {
  groups: string[]
  /** Every participant of the display's groups. */
  total: number
  /** How many the `only` filter lists (the pager's total). */
  listed: number
  matched: number | null
  /** r3-2 — cases the rule cannot check (a missing value, no material), never folded in. */
  unknown: number | null
  rule_unavailable_reason: string | null
  /** #1615 — the withheld variables a rule names while blind, by name (r3-3). */
  rule_withheld_columns: string[]
  list_size: number
  /** Added cases no longer among the display's groups. */
  added_outside: number
  codes: { code_id: number; name: string }[]
  /** #1664 (D332): the row's bound codes the codebook made inactive — out of `codes` and every
   *  case fact, named here (the compute's shape). Optional until every fixture carries it. */
  inactive_codes?: JointDisplayInactiveCode[]
  variables: { column_id: number; name: string; dataset_id: number; withheld: boolean; operators: string[] }[]
  cases: JointDisplayCase[]
  /** Joint display slice 2, round 2 (r5-6): the added and removed cases' identifiers and
   *  groups (null = no longer in the display's groups) — never a rule-selected case's. */
  named_cases: { participant_id: number; label: string; group: string | null }[]
  unavailable_reason: string | null
}

export interface JointDisplayCase {
  participant_id: number
  label: string
  group: string
  facts: Record<string, JointDisplayCaseFacts>
  matches: boolean | null
  listed_by: 'rule' | 'added' | null
  removed: boolean
}

export const jointDisplayApi = {
  /**
   * The display's live numbers. `EXPORT_TIMEOUT_MS`, as the code-by-group comparison
   * (#1548 D190): it runs that comparison's gather, and an encrypted copy of the D12 kit took
   * 14 s, and 24 s with one rated code (session B, 2026-11-12e) — too near the 30 s default.
   */
  compute: (projectId: number, data: JointDisplayComputeRequest) =>
    api.post<JointDisplayComputeResponse>(
      `/projects/${projectId}/joint-display/compute`, data, { timeout: EXPORT_TIMEOUT_MS },
    ).then(r => r.data),

  /** One group's passages coded with one code — a pin's suggestions (D209). */
  passages: (projectId: number, data: JointDisplayPassagesRequest) =>
    api.post<JointDisplayPassagesResponse>(
      `/projects/${projectId}/joint-display/passages`, data, { timeout: EXPORT_TIMEOUT_MS },
    ).then(r => r.data),

  /** Joint display slice 2 (D173) — one row per case, and which cases a stated rule selects. */
  cases: (projectId: number, data: JointDisplayCasesRequest) =>
    api.post<JointDisplayCasesResponse>(
      `/projects/${projectId}/joint-display/cases`, data, { timeout: EXPORT_TIMEOUT_MS },
    ).then(r => r.data),

  /** The live facts each pin's attribution is derived from (D210), and (#1615 D286) whether its
   *  column was left out while blind — the whole answer, so the note can say so. */
  pinFacts: (projectId: number, data: { excerpt_ids: number[]; column_id: number | null; coder_ids?: number[] | null }) =>
    api.post<JointDisplayPinFactsResponse>(
      `/projects/${projectId}/joint-display/pin-facts`, data,
    ).then(r => r.data),
}
