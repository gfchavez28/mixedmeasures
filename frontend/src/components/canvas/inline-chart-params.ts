/**
 * Pure helpers for turning a canvas material/block `content` config into a
 * quickCompute request. Extracted from InlineChartRenderer.tsx so they live in
 * a non-component module (consumed by both InlineChartRenderer and the canvas
 * export pipeline) — keeps Fast Refresh working for the component file.
 */
import { toComparisonChartType, type ComparisonChartType } from '@/lib/comparison-chart-types'
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
  type QualTimelineTableMode,
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
  /**
   * #685 — the Timeline's table breakdown, read from the saved config so the
   * embed draws the breakdown the researcher arranged. Absent on every material
   * saved before that landed, which is why it falls back to `'code'` — the same
   * value those materials have always rendered.
   */
  tableMode: QualTimelineTableMode
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
  const tableMode: QualTimelineTableMode = content.timeline_table_mode === 'coder' ? 'coder' : 'code'

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
    tableMode,
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

// ── Quantitative CROSS-TAB materials (#823g / #832) ──────────────────────────
//
// 🔴 **A cross-tab is the one descriptives type that needs its OWN endpoint**,
// and #823(g) taught only the RENDERER about it. `lib/canvas-export.ts` kept
// falling through to `quickCompute` → `metricsToMarkdownTable`, which has no
// `cross_tab` case, so the export emitted the marginal frequency distribution
// where a cross-tabulation belongs — the second axis silently absent.
//
// ⚠️ **Round 3 did not create the export defect; it created the DIVERGENCE**,
// which is worse. Before it, the renderer printed the literal token
// `"cross_tab chart"` and the export emitted the wrong table: both useless,
// consistently. After it the canvas was right and `.md` was wrong, so nothing
// on screen gave the researcher a reason to doubt the file.
//
// 🔴 **These live here, beside `extractComparisonParams`, for the reason #824
// exists.** The renderer derived the two axis ids inline (`cross_tab_column_id`
// for the column, `columnIds[0]` when exactly one variable is selected for the
// row). Re-inlining that in the export would be a SECOND derivation of one
// question — the shape that made a panel advertise a chord firing a different
// code. One derivation, two consumers.

export interface CrossTabEmbedParams {
  /** The POST body for `metricsApi.crossTabulation`, or null when unusable. */
  request: {
    row_column_id: number
    col_column_id: number
    include_chi_square: boolean
  } | null
  /** `'count' | 'row_pct' | 'col_pct' | 'total_pct'` — mirrors the saved view. */
  display: string
  /** `'reversed'` flips both axes; anything else leaves them alone. */
  scaleOrder: string
}

/**
 * Is this material config a quantitative cross-tabulation?
 *
 * ⚠️ Keyed on `chart_type` ALONE, unlike `isComparisonMaterialConfig`'s two
 * markers — and that asymmetry is correct rather than an oversight.
 * `'cross_tab'` is not a default any writer omits (`buildCurrentChartConfig`
 * writes the chart type it drew), so its presence is already unambiguous; the
 * comparison case needs two markers precisely because `rc_view` can be stale on
 * a descriptives config. The MISSING-axis case is a separate question — see
 * `extractCrossTabParams`, which answers it with a null request rather than by
 * denying the material is a cross-tab.
 */
export function isCrossTabMaterialConfig(
  content: Record<string, unknown> | null | undefined,
): boolean {
  if (!content || typeof content !== 'object') return false
  return content.chart_type === 'cross_tab'
}

/**
 * The cross-tab request and display options a saved material implies.
 *
 * ⚠️ **A null request means "configured incompletely", not "not a cross-tab".**
 * The two consumers answer it differently and both are right: the renderer says
 * *"This cross-tab has no comparison column saved."* (an embed cannot prompt for
 * the missing axis the way the analysis view can), and the export emits nothing
 * — the same thing it does for every other unusable config, rather than a table
 * of whatever `quickCompute` happened to return.
 *
 * ⚠️ **The row axis is the selection, not a stored id.** A cross-tab is defined
 * over exactly one row variable, so a material carrying two or more selected
 * columns has no row axis — `columnIds[0]` would silently pick one.
 */
export function extractCrossTabParams(
  content: Record<string, unknown>,
): CrossTabEmbedParams {
  const { columnIds } = extractComputeParams(content)
  const rowColumnId = columnIds.length === 1 ? columnIds[0] : null
  const colColumnId = (content.cross_tab_column_id as number) ?? null

  return {
    request: (rowColumnId != null && colColumnId != null)
      ? { row_column_id: rowColumnId, col_column_id: colColumnId, include_chi_square: true }
      : null,
    display: (content.cross_tab_display as string) ?? 'count',
    scaleOrder: (content.scaleOrder as string) ?? 'natural',
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

// ── #795: which of this embed's variables need recomputing ───────────────────

/**
 * The variables feeding this chart that are COMPUTED and out of date.
 *
 * 🔴 **What this signal is, and what it is NOT.** A canvas chart embed is
 * LIVE — `InlineChartRenderer` re-fetches through `quickCompute` on every
 * render — so its figures are never "old" and the dead `isStale` prop's "Data
 * stale" wording could not have been true. What CAN be wrong is upstream: a
 * computed column whose dependency changed and has not been recomputed still
 * holds its earlier values, so a chart reading it draws those.
 *
 * ⚠️ **It does NOT mean "these numbers changed since you wrote the prose
 * around them".** That is the thing a researcher actually wants from a canvas
 * and the app cannot answer it — no baseline is stored anywhere to diff
 * against. Filed separately (#808). Do not reword this to imply it.
 *
 * ⚠️ **A saved chart's staleness is a different flag.** `lib/chart-export.tsx`
 * rolls up `MetricDefinition.stale`; an embed computes ad-hoc and has no
 * MetricDefinition, so that precedent does not transfer — which is why this
 * reads the COLUMN's flag off the analysis-columns payload instead.
 *
 * Domains are included because a variable group's scale score aggregates its
 * member columns, so a stale member makes the group's number stale too; the
 * membership rides `domain_ids` on each column, so one project-wide payload
 * answers both without a second request.
 */
export function staleComputedInputs<
  T extends { id: number; stale?: boolean; domain_ids?: number[] },
>(
  params: Pick<ReturnType<typeof extractComputeParams>, 'columnIds' | 'domainIds'>,
  allColumns: T[],
): T[] {
  const columnIds = new Set(params.columnIds)
  const domainIds = new Set(params.domainIds)
  if (columnIds.size === 0 && domainIds.size === 0) return []
  return allColumns.filter(
    c =>
      c.stale === true &&
      (columnIds.has(c.id) || (c.domain_ids ?? []).some(d => domainIds.has(d))),
  )
}

// ── Quantitative COMPARISON materials (#817) ─────────────────────────────────
//
// 🔴 **A comparison embed used to render a DIFFERENT figure, silently.**
// Measured on the GSS canvas: *"Comparison · Trust scale A (Depends = middle)
// by degree"* drew
//
//     Metric                             1       2       3
//     Trust scale A (Depends = middle)   47.1%   6.3%    46.6%
//
// — the pooled frequency distribution of the scale — with `F = 690.88`, the
// per-group n/M/SD, the p-value, ω² and the whole Tukey block absent, and
// nothing on screen saying a substitution had happened.
//
// **The mechanism, and the filed entry describes it the wrong way round.** It
// says `isComparison` routes `comparison_table` through the qualitative API "so
// a quantitative comparison falls past it". The qualitative branch never sees
// it at all: `isQualitativeMaterialConfig` keys on `code_mode`/`code_ids`, which
// a quantitative comparison has neither of, so it lands in the quantitative
// branch — **which only knows how to draw METRICS via `quickCompute`.** There
// was no quantitative-comparison renderer to fall past. `chart_type` is absent
// on these configs, so `detectChartType` picked `heatmap` from the frequency
// metrics and drew a plausible, wrong table.
//
// ⚠️ **CORRELATION and SCATTER materials had the same fall-through — closed by
// #831, in two halves, and the residual is stated below.**
//
// The saver now writes `rc_view` UNCONDITIONALLY, so every R&C material created
// from this point identifies itself. For material saved BEFORE that, two of the
// three shapes are still recoverable from config alone: a scatter matrix
// carries `show_scatter`, and a non-Pearson correlation carries `corr_type`.
//
// ⚠️ **The residual, deliberately accepted (decided with the developer,
// 2026-08-25): a LEGACY default-Pearson `correlation_matrix` remains
// indistinguishable from a descriptives material.** Its config carries no
// marker of any kind — `rc_view` omitted (default), `corr_type` omitted
// (default), `show_scatter` omitted (false) — and the unconditional keys
// (`sig_levels`, `nonparametric`, `post_hoc_expanded`, `show_reg_line`) ride
// EVERY quantitative material, descriptives included, so none of them
// discriminates. VERIFIED against the real corpus's ten materials.
//
// The alternative was to read the material row's `material_type`, which
// `material-kind.ts` refuses as an input to this seam for two reasons that
// still hold (it can disappear; it arrives late). That was put and declined:
// one discriminator, and a shrinking legacy set left no worse than it is today,
// beats a second discriminator that makes every embed flash.

export interface ComparisonEmbedParams {
  /** The POST body for `comparisonsApi.groupComparison`, or null when unusable. */
  request: {
    column_ids: number[]
    domain_ids: number[]
    grouping_column_id: number
    grouping_column_id_2: number | null
    test_type: string
    include_effect_size_ci: boolean
    exclude_groups?: string[]
    nonparametric?: boolean
    include_qq?: boolean
  } | null
  chartType: ComparisonChartType
  sigLevels: { show_05: boolean; show_01: boolean; show_001: boolean }
  nonparametric: boolean
  postHocExpanded: boolean
}

/**
 * Is this material config a quantitative group comparison?
 *
 * `rc_view` is written whenever the R&C view is NOT its default, so
 * `'comparisons'` is always present on a comparison material; `compare_by` is
 * what the comparison cannot run without. Both are required so a descriptives
 * config that happens to carry a stale `compare_by` is not mistaken for one.
 */
export function isComparisonMaterialConfig(
  content: Record<string, unknown> | null | undefined,
): boolean {
  if (!content || typeof content !== 'object') return false
  return content.rc_view === 'comparisons' && content.compare_by != null
}

/**
 * Is this material a CORRELATION or SCATTER matrix? (#831)
 *
 * Sibling of `isComparisonMaterialConfig`, and the two together are what stop
 * an R&C material being drawn as a descriptives metric. This one exists to
 * REFUSE rather than to render: there is no inline correlation renderer, so the
 * honest outcome is the "open it in Analysis" notice — a visible limit instead
 * of a silent wrong figure.
 *
 * Three tells, in the order they became available:
 *   - `rc_view === 'correlations'` — written unconditionally since #831, so it
 *     is present on everything saved from then on. **The primary tell.**
 *   - `corr_type` — present on any non-Pearson correlation, including legacy.
 *   - `show_scatter` — present on any scatter matrix, including legacy.
 *
 * ⚠️ **`show_scatter` is tested with `in`, not for truthiness.** The saver
 * writes it as `showScatter || undefined`, so the key is absent when false —
 * meaning its PRESENCE is the signal and a truthiness test would say the same
 * thing more fragilely. Do not "simplify" it to `content.show_scatter === true`
 * without re-reading the saver.
 *
 * ⚠️ It deliberately does NOT require a second corroborating key the way the
 * comparison predicate does. A comparison needs `compare_by` to run at all, so
 * requiring it costs nothing; a correlation needs only its selected columns,
 * and demanding more would re-open exactly the gap this closes.
 */
export function isCorrelationMaterialConfig(
  content: Record<string, unknown> | null | undefined,
): boolean {
  if (!content || typeof content !== 'object') return false
  if (content.rc_view === 'correlations') return true
  return 'corr_type' in content || 'show_scatter' in content
}

/**
 * Any Relationships & Comparisons material — the set the descriptives metric
 * path must not touch.
 *
 * Callers that only need "is this safe to draw as a metric?" should ask THIS
 * rather than either predicate, so a future third R&C kind is added in one
 * place. Both the renderer and the export pipeline consume it (#832: the
 * export was a second file with #817's defect, and a renderer-only fix left
 * Markdown carrying a different figure under the same title).
 */
export function isRelationshipsMaterialConfig(
  content: Record<string, unknown> | null | undefined,
): boolean {
  return isComparisonMaterialConfig(content) || isCorrelationMaterialConfig(content)
}

/**
 * The comparison request and display options a saved material implies.
 *
 * Mirrors `AnalysisView`'s live query construction. ⚠️ `include_qq` is opt-in
 * there for a reason (#525b — the only O(n) field in the payload), so it is
 * requested only by the chart that draws it here too.
 */
export function extractComparisonParams(
  content: Record<string, unknown>,
): ComparisonEmbedParams {
  const columnIds = (content.column_ids as number[]) ?? (content.selected_columns as number[]) ?? []
  const domainIds = (content.domain_ids as number[]) ?? (content.selected_domains as number[]) ?? []
  const compareBy = content.compare_by as number | undefined
  const excludeGroups = (content.exclude_groups as string[]) ?? []
  const nonparametric = content.nonparametric === true
  // `rc_chart_type` is stored only in its NON-default state, exactly like the
  // qualitative flags above — reading it with a bare cast would render every
  // saved table as `undefined`.
  const chartType = toComparisonChartType((content.rc_chart_type as string) ?? null)
  const sig = content.sig_levels as ComparisonEmbedParams['sigLevels'] | undefined

  const hasSelection = columnIds.length > 0 || domainIds.length > 0
  return {
    request: (hasSelection && compareBy != null)
      ? {
        column_ids: columnIds,
        domain_ids: domainIds,
        grouping_column_id: compareBy,
        grouping_column_id_2: (content.compare_by_2 as number) ?? null,
        test_type: (content.test_type as string) ?? 'auto',
        include_effect_size_ci: true,
        exclude_groups: excludeGroups.length > 0 ? excludeGroups : undefined,
        nonparametric,
        include_qq: chartType === 'comparison_qq' || undefined,
      }
      : null,
    chartType,
    sigLevels: sig ?? { show_05: true, show_01: true, show_001: true },
    nonparametric,
    postHocExpanded: content.post_hoc_expanded === true,
  }
}
