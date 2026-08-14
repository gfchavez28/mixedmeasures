/**
 * Pure helpers for turning a canvas material/block `content` config into a
 * quickCompute request. Extracted from InlineChartRenderer.tsx so they live in
 * a non-component module (consumed by both InlineChartRenderer and the canvas
 * export pipeline) — keeps Fast Refresh working for the component file.
 */
import type {
  QuickComputeRequest,
  GroupingMode,
  SourceFrequenciesRequest,
  CodeAnalysisFilterParams,
  DemographicComparisonRequest,
} from '@/lib/api'
import {
  orientationFromToken,
  type QualChartType,
  type QualValueMode,
  type QualDenominatorMode,
  type QualSortOrder,
  type QualOrientation,
  type QualRelView,
  type QualComparisonChartMode,
  type QualCooccurrenceLevel,
} from '@/lib/qual-analysis-types'

/** Extract quickCompute params from material config stored in block content. */
export function extractComputeParams(content: Record<string, unknown>): {
  columnIds: number[]
  domainIds: number[]
  metricType: string
  config: Record<string, unknown>
  groupingColumnId: number | null
  groupingColumnId2: number | null
  groupingMode: GroupingMode | null
  excludeValues: string[] | null
} {
  // Palette config uses column_ids/domain_ids (not selected_columns/selected_domains)
  const columnIds = (content.column_ids as number[]) ?? (content.selected_columns as number[]) ?? []
  const domainIds = (content.domain_ids as number[]) ?? (content.selected_domains as number[]) ?? []
  const metricType = (content.metric_type as string) ?? 'frequency_distribution'
  const groupingColumnId = (content.grouping_column_id as number) ?? null
  const groupingColumnId2 = (content.grouping_column_id_2 as number) ?? null
  const groupingMode = (content.grouping_mode as GroupingMode) ?? null
  const excludeValues = (content.exclude_values as string[]) ?? null

  // Build config object based on metric type
  let config: Record<string, unknown> = {}
  if (metricType === 'proportion') {
    const propConfig = content.proportion_config as Record<string, unknown> | undefined
    if (propConfig) {
      config = propConfig.mode === 'numeric'
        ? { mode: 'numeric', operator: propConfig.operator, threshold_numeric: propConfig.threshold_numeric }
        : { mode: 'values', threshold_values: propConfig.threshold_values }
    }
  } else if (metricType === 'domain_aggregate') {
    config = { child_metric_type: 'mean', child_config: {}, aggregation: 'mean' }
  }

  return { columnIds, domainIds, metricType, config, groupingColumnId, groupingColumnId2, groupingMode, excludeValues }
}

// ── Qualitative materials (#652 slab 1) ──────────────────────────────────────
//
// The quantitative pair above assumes ONE endpoint and TWO source types. A
// qualitative config carries code_ids + four SOURCE kinds and needs a different
// endpoint, so these are siblings rather than a widening of the same function.
//
// Everything here mirrors `QualitativeAnalysisView`'s live request construction
// on purpose. Four of those details are load-bearing and silent if dropped:
//
//   1. **An empty `code_ids` list means NONE, not ALL.** The service filters
//      `if code_ids is not None`, so `[]` yields an empty codes array and an
//      empty chart. The live view never sends one because its query `enabled`
//      gate requires a non-empty selection — so a canvas embed MUST carry the
//      same gate, or it renders "no data" for a reason that is our fault.
//      (`participant_ids` is the opposite — the service tests it for truthiness,
//      so `[]` there is safely "no filter". The inconsistency is why each list
//      is handled explicitly below rather than by one generic rule.)
//   2. **`group_by_subtype` is chart-type-conditional.** The view sends it only
//      for the bar chart. A stored config keeps `group_by` regardless, so
//      sending it unconditionally would fetch DIFFERENT data than the
//      researcher saw when they saved.
//   3. **`aggregation` is derived from `code_mode`**, not stored directly.
//   4. **The show/hide flags are written to config only in their NON-default
//      state** (`show_summary_row` only when false; `show_chart_n` only when
//      true), so their defaults are asymmetric and reading them with a uniform
//      `?? false` inverts two of the three.
//
// Blind mode deliberately does NOT apply: the view narrows the sent scope to
// self while blind, but a canvas embed replays the coder scope that was SAVED.
// It is a snapshot of a figure, and the quantitative path behaves the same way.
//
// ── Slab 2 (saturation · co-occurrence · comparisons) ────────────────────────
//
// ⚠️ **THE FOUR ENDPOINTS DISAGREE WITH EACH OTHER ABOUT EMPTY LISTS**, all
// three variants verified in the service, and no generic request builder can be
// correct for more than one of them:
//
//   · `source-frequencies.code_ids` filters `if code_ids is not None`
//        ⇒ `[]` means **NONE**
//   · `demographic-comparison.code_ids` filters `if code_ids:`
//        ⇒ `[]` means **ALL**
//   · `saturation` takes **no `code_ids` at all**, and its source-id filters are
//        truthiness ⇒ empty means **ALL SOURCES**
//
// So each builder below mirrors ITS OWN live caller in `QualitativeAnalysisView`
// field by field. That is the discipline this seam requires; it is not
// defensive style.
//
// Two more shape traps in the same family:
//
//   · **`category_level` vs `aggregation` encode the SAME concept differently.**
//     Saturation takes `category_level: boolean`; source-frequencies takes
//     `aggregation: 'category' | undefined`. Both derive from
//     `code_mode === 'categories'`. Copying the wrong one silently changes what
//     is being counted rather than erroring.
//   · **Saturation ignores `text_column_ids`, `participant_ids` and `code_ids`**
//     — the view's own saturation query omits all three, so an embed must too,
//     even though the config carries them.
//
// **Demographic comparison omits `document_ids` / `observation_ids` by design**
// (it groups by participant demographics, and neither documents nor observation
// clips carry a speaker→participant link). Mirror it; do NOT read it as a
// parent-arm omission to be fixed here.

export interface QualComputeParams {
  request: SourceFrequenciesRequest
  /** Mirrors the qual view's query `enabled` gate — see note 1 above. */
  hasSelection: boolean
  /**
   * ⚠️ Read this BEFORE `chartType`. `buildCurrentConfig` writes `chart_type`
   * unconditionally, so a material saved from the Relationships tab still
   * carries whatever descriptives chart type was last selected — typically
   * `'heatmap'`. Dispatching on `chart_type` alone would draw a co-occurrence
   * material as a descriptives heatmap over source-frequencies data: a
   * confidently-wrong chart, which is worse than the honest empty state.
   */
  tab: string
  chartType: QualChartType
  valueMode: QualValueMode
  denominatorMode: QualDenominatorMode
  sortOrder: QualSortOrder
  /**
   * #675 — the code-axis order behind `sortOrder: 'custom'`.
   *
   * ⚠️ The #675 entry says the canvas gets this "free once the shaping honours
   * it, since `sort_order` and `custom_order` are already in the config". Half
   * true and the wrong half: `buildCurrentConfig` does WRITE `custom_order`, but
   * nothing here ever read it and `QualComputeParams` had no field for it — so
   * shaping alone would have left a custom-ordered chart rendering in import
   * order on the canvas while the analysis view showed the researcher's order.
   * The two agreed before the fix, and that agreement is the thing worth keeping.
   */
  customOrder: number[]
  orientation: QualOrientation
  groupBy: string | null
  showSummaryRow: boolean
  showRowN: boolean
  showChartN: boolean
  categoryMode: boolean
  // ── Relationships-tab axes (slab 2) ──
  relView: QualRelView
  comparisonChartMode: QualComparisonChartMode
  cooccurrenceLevel: QualCooccurrenceLevel
  showProportion: boolean
  cooccurrencePreset: string
  comparisonPalette: string
  showEffectSize: boolean
  source: 'all' | 'conversations' | 'text'
  /**
   * ⚠️ Also reachable as `request.layer_scope`, and duplicated here ON PURPOSE
   * (#652 slab 4). For the source-frequency four it is an endpoint parameter;
   * for the Timeline it is a DISPATCH input — the chart reads the human coding
   * layer and refuses under consensus (DEC-6c-7) — and a dispatch input should
   * not be reachable only by digging into a request body.
   */
  layerScope: 'human' | 'consensus'
}

function idList(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((n): n is number => typeof n === 'number') : []
}

/** Extract source-frequencies params from a qualitative material config. */
export function extractQualComputeParams(content: Record<string, unknown>): QualComputeParams {
  const codeIds = idList(content.code_ids)
  const conversationIds = idList(content.conversation_ids)
  const textColumnIds = idList(content.text_column_ids)
  const documentIds = idList(content.document_ids)
  const observationIds = idList(content.observation_ids)
  const participantIds = idList(content.participant_ids)
  const coderIds = idList(content.coder_ids)

  const chartType = (content.chart_type as QualChartType) ?? 'heatmap'
  const groupBy = (content.group_by as string) ?? null
  const categoryMode = content.code_mode === 'categories'
  const layerScope = content.layer_scope === 'consensus' ? 'consensus' : 'human'

  const hasSourceSelection =
    conversationIds.length > 0 ||
    textColumnIds.length > 0 ||
    documentIds.length > 0 ||
    observationIds.length > 0

  return {
    request: {
      code_ids: codeIds,
      conversation_ids: conversationIds,
      text_column_ids: textColumnIds,
      document_ids: documentIds,
      observation_ids: observationIds,
      exclude_facilitator: content.exclude_facilitator !== false,
      participant_ids: participantIds.length > 0 ? participantIds : undefined,
      // Note 2 — bar chart only, exactly as the view sends it.
      group_by_subtype: chartType === 'bar' && groupBy ? groupBy : undefined,
      aggregation: categoryMode ? 'category' : undefined,
      coder_ids: coderIds.length > 0 ? coderIds : null,
      layer_scope: layerScope,
    },
    hasSelection: codeIds.length > 0 && hasSourceSelection,
    layerScope,
    tab: (content.tab as string) ?? 'descriptives',
    chartType,
    valueMode: (content.value_mode as QualValueMode) ?? 'count',
    denominatorMode: (content.denominator_mode as QualDenominatorMode) ?? 'total',
    sortOrder: (content.sort_order as QualSortOrder) ?? 'import',
    customOrder: idList(content.custom_order),
    // The stored value is the URL TOKEN ('sr'/'cr') — see qual-analysis-types.
    orientation: orientationFromToken(content.orientation),
    groupBy,
    // Note 4 — absent means SHOWN for these two...
    showSummaryRow: content.show_summary_row !== false,
    showRowN: content.show_row_n !== false,
    // ...and absent means HIDDEN for this one.
    showChartN: content.show_chart_n === true,
    categoryMode,
    source: (content.source as 'all' | 'conversations' | 'text') ?? 'all',
    relView: (content.rel_view as QualRelView) ?? 'cooccurrence',
    comparisonChartMode: (content.comparison_chart_mode as QualComparisonChartMode) ?? 'table',
    cooccurrenceLevel: (content.cooccurrence_level as QualCooccurrenceLevel) ?? 'segment',
    showProportion: content.show_proportion === true,
    cooccurrencePreset: (content.cooccurrence_preset as string) ?? 'green',
    comparisonPalette: (content.comparison_palette as string) ?? 'default',
    // Defaults TRUE in the view (`showEffect` param defaults to '1') and is
    // always written — but an older config may predate the key, so absent must
    // mean shown, not hidden.
    showEffectSize: content.show_effect_size !== false,
  }
}

/**
 * WHICH CHART a saved qualitative config describes — the single discriminant.
 *
 * ⚠️ It takes **four** config keys, because the analysis view selects a chart
 * along four axes and only one of them is `chart_type`:
 *
 *   `tab` ──┬─ 'descriptives'  → `chart_type`
 *           └─ 'relationships' → `rel_view` ──┬─ 'cooccurrence' → done
 *                                             └─ 'comparisons'  → `comparison_chart_mode`
 *
 * `buildCurrentConfig` writes ALL of them unconditionally, so a Relationships
 * material still carries a stale, perfectly drawable `chart_type` (typically
 * `'heatmap'`). Reading that key first draws a co-occurrence material as a
 * Descriptives heatmap over source-frequencies data — confidently wrong, which
 * is worse than the honest "not yet" message.
 *
 * Returning ONE kind (rather than exposing the axes) is what stops the
 * renderer, the router, the export tables and the user-facing message from each
 * re-deriving the dispatch and disagreeing. Adding a chart type = one entry
 * here plus a case in each consumer, and TypeScript finds the consumers.
 *
 * `null` = "this build cannot draw it". Since slab 4 shipped the Timeline, the
 * only member left is `qual_content` — which is unreachable dead code (the save
 * gate offers only Descriptives and Relationships), so nothing reachable
 * returns null today. Keep the arm anyway: it is what makes a NINTH kind added
 * here fail visibly at its consumers instead of rendering blank.
 */
export type QualChartKind =
  | 'heatmap'
  | 'bar'
  | 'stacked_bar'
  | 'summary'
  | 'saturation'
  | 'timeline'
  | 'cooccurrence'
  | 'comparison_table'
  | 'comparison_bar'

const SOURCE_FREQUENCY_CHART_TYPES: ReadonlySet<QualChartType> = new Set<QualChartType>([
  'heatmap',
  'bar',
  'stacked_bar',
  'summary',
])

export function qualChartKind(params: QualComputeParams): QualChartKind | null {
  if (params.tab === 'descriptives') {
    if (SOURCE_FREQUENCY_CHART_TYPES.has(params.chartType)) return params.chartType as QualChartKind
    if (params.chartType === 'saturation') return 'saturation'
    if (params.chartType === 'timeline') return 'timeline'
    return null
  }
  if (params.tab === 'relationships') {
    if (params.relView === 'cooccurrence') return 'cooccurrence'
    return params.comparisonChartMode === 'bar' ? 'comparison_bar' : 'comparison_table'
  }
  return null
}

export function isQualChartRenderable(params: QualComputeParams): boolean {
  return qualChartKind(params) !== null
}

/**
 * Does this chart have everything it needs to be fetched at all?
 *
 * Deliberately per-kind, because the four endpoints do NOT share a notion of
 * "enough to ask":
 *   · the source-frequency four need codes AND a source (an empty `code_ids`
 *     means none, so asking would return an empty chart that reads as our bug);
 *   · **saturation needs nothing** — it has no `code_ids` and empty source lists
 *     mean "all sources", which is exactly what the view sends by default;
 *   · **comparisons need `group_by`** — the view builds a null request without
 *     it and never fires;
 *   · **co-occurrence needs nothing from the config** — it is all-codes by
 *     design (its filter params carry no `code_ids` at all);
 *   · **the Timeline needs codes AND a source** — see the note on its branch,
 *     which is spelled out rather than falling through to the shared tail
 *     because the config alone argues for the opposite answer.
 */
export function qualChartHasEnoughToFetch(params: QualComputeParams): boolean {
  const kind = qualChartKind(params)
  if (kind === null) return false
  if (kind === 'saturation' || kind === 'cooccurrence') return true
  if (kind === 'comparison_table' || kind === 'comparison_bar') return !!params.groupBy
  if (kind === 'timeline') {
    // ⚠️ `code_ids: []` means TWO contradictory things on this path, and this
    // branch is the tie-break (#652 slab 4).
    //
    //   · `QualitativeAnalysisView::timedCodes` — empty selection ⇒ ALL ACTIVE
    //     codes, and `generateAutoName()` even NAMES such a material
    //     "All codes", agreeing with it;
    //   · `hasQualSelection` (= codes AND ≥1 source) gates the entire
    //     Descriptives body, so with no codes selected the view renders its
    //     empty state and the chart never mounts.
    //
    // The GATE is what the researcher actually saw, so the embed reproduces the
    // gate — which keeps the "all active" branch as dead here as it is there.
    // Do not "fix" this to render all codes on the strength of the name.
    return params.hasSelection
  }
  return params.hasSelection
}

/*
 * #749 — the summary table's SECOND endpoint is gone.
 *
 * `qualChartNeedsFrequencies` / `buildQualFrequencyParams` existed because
 * `QualSummaryTable` drew its per-kind columns and totals from
 * `code-frequencies` while everything else came from `source-frequencies`. Both
 * halves now come from the one payload, so a canvas summary embed makes one
 * request instead of two — and it can no longer render a selection-scoped body
 * above a project-scoped totals row.
 */

/**
 * Saturation params — mirrors `QualitativeAnalysisView`'s saturation query.
 *
 * ⚠️ Deliberately NARROWER than the other builders: no `code_ids` (the endpoint
 * has no such parameter), no `text_column_ids`, no `participant_ids`. The curve
 * is "unique codes accumulated as sources are added", so it is scoped by SOURCE
 * only. Sending the config's other filters would imply a scoping the chart does
 * not have.
 *
 * Note `category_level` is a BOOLEAN here where source-frequencies takes
 * `aggregation: 'category'` — same concept, two encodings, both derived from
 * `code_mode`.
 */
export function buildQualSaturationParams(params: QualComputeParams): {
  exclude_facilitator?: boolean
  category_level?: boolean
  conversation_ids?: string
  document_ids?: string
  observation_ids?: string
  coder_ids?: string
  layer_scope?: 'human' | 'consensus'
} {
  const req = params.request
  const csv = (ids: number[] | null | undefined) => (ids && ids.length > 0 ? ids.join(',') : undefined)
  return {
    exclude_facilitator: req.exclude_facilitator,
    category_level: params.categoryMode,
    conversation_ids: csv(req.conversation_ids),
    document_ids: csv(req.document_ids),
    observation_ids: csv(req.observation_ids),
    coder_ids: csv(req.coder_ids),
    layer_scope: req.layer_scope ?? 'human',
  }
}

/**
 * Co-occurrence filter params — mirrors the view's shared `filterParams`.
 *
 * ⚠️ Carries **no `code_ids`**: co-occurrence is all-codes by design (the view
 * gates the sub-view on the project having ≥2 ACTIVE codes, not on the current
 * selection). `level` is NOT set here — `QualCooccurrence` merges its own.
 */
export function buildQualCooccurrenceParams(params: QualComputeParams): CodeAnalysisFilterParams {
  // Inlined when #749 removed the summary table's second fetch — this became
  // the only caller of the shared builder, and a one-caller indirection named
  // after the other chart type reads as if the two still share a contract.
  const csv = (ids: number[] | null | undefined) => (ids && ids.length > 0 ? ids.join(',') : undefined)
  const req = params.request
  return {
    exclude_facilitator: req.exclude_facilitator,
    conversation_ids: csv(req.conversation_ids),
    participant_ids: csv(req.participant_ids),
    text_column_ids: csv(req.text_column_ids),
    document_ids: csv(req.document_ids),
    observation_ids: csv(req.observation_ids),
    source: params.source,
    coder_ids: csv(req.coder_ids),
    layer_scope: req.layer_scope ?? 'human',
  }
}

/**
 * Demographic-comparison request — mirrors the view's `comparisonRequest`.
 *
 * Returns `null` without a `group_by`, exactly as the view does, so the caller
 * cannot accidentally fire a request the analysis surface would never send.
 *
 * ⚠️ Sends `conversation_ids` + `text_column_ids` only. Documents and
 * observations are absent BY DESIGN (grouping runs through participant
 * demographics, and neither carries a speaker→participant link) — mirroring the
 * view here is correct, not an omission to fix.
 */
export function buildQualComparisonRequest(params: QualComputeParams): DemographicComparisonRequest | null {
  if (!params.groupBy) return null
  const req = params.request
  const nonEmpty = (ids: number[] | null | undefined) => (ids && ids.length > 0 ? ids : undefined)
  return {
    group_by_subtype: params.groupBy,
    code_ids: nonEmpty(req.code_ids),
    conversation_ids: nonEmpty(req.conversation_ids),
    text_column_ids: nonEmpty(req.text_column_ids),
    exclude_facilitator: req.exclude_facilitator,
    participant_ids: nonEmpty(req.participant_ids),
    coder_ids: req.coder_ids ?? null,
    layer_scope: req.layer_scope ?? 'human',
  }
}

/** Build the quickCompute API request from extracted params. */
export function buildRequest(params: ReturnType<typeof extractComputeParams>): QuickComputeRequest {
  const sources = [
    ...params.columnIds.map(id => ({ source_type: 'dataset_column' as const, source_id: id })),
    ...params.domainIds.map(id => ({ source_type: 'dataset_domain' as const, source_id: id })),
  ]
  return {
    sources,
    metric_type: params.metricType,
    config: params.config,
    grouping_column_id: params.groupingColumnId,
    grouping_column_id_2: params.groupingColumnId2,
    grouping_mode: params.groupingMode,
    exclude_values: params.excludeValues,
  }
}
