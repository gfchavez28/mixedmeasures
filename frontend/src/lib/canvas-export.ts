/**
 * Canvas export: Markdown, HTML, and chart-to-table conversion.
 *
 * Walks Tiptap JSON content, converts each node type to the target format,
 * and fetches chart metric data via quickCompute for table rendering.
 */

import {
  metricsApi,
  codeAnalysisApi,
  comparisonsApi,
  codesApi,
  observationsApi,
  jointDisplayApi,
  materialsApi,
  type AnalysisColumnsResponse,
  type JointDisplayComputeResponse,
  type JointDisplayPinFact,
  type MaterialResponse,
  type CanvasDetail,
  type CanvasTheme,
  type CanvasThemeRelationship,
  type MetricDefinitionResponse,
  type SourceFrequenciesResponse,
  type GroupComparisonResponse,
  type AnalysisCrossTabResponse,
} from '@/lib/api'
import { analysisScope, coderIdsField, ratingsViewerField } from './analysis-scope'
import { safeFilename } from './filename'
import { mdBlock, mdDestination, mdHeading, mdLine, mdLines, mdText, mdWrap } from './markdown-text'
import {
  computeTimedRows,
  coveredTotalSeconds,
  formatTimedRate,
  formatTimedSeconds,
  formatTimedShare,
  timedExtent,
  timedLayerFor,
} from '@/lib/timed-analytics'
import type { MachineCoderIds } from '@/lib/coding-progress'
import {
  resolveTimelineObservations,
  resolveTimelineCodes,
  resolveTimelineCoderLens,
} from '@/components/canvas/qual-timeline-params'
import {
  detectChartType,
  shapeScalarBarFigure,
  shapeFrequencyBars,
  shapeHeatmapRows,
  shapeHistogramBars,
  shapeDumbbellRows,
  shapeLineChart,
  isGroupedMetrics,
  DISPLAY_PRECISION,
  formatP,
  type ChartType,
} from '@/lib/chart-data'
import {
  comparisonMethodNote, correctionName, deltaIntervalVisual, describeOmittedTest, unitCount,
} from '@/lib/comparison-basis'
import { noCodingNote, noCodingScope } from '@/lib/coding-completeness'
import { ciLabel } from '@/lib/ci-label'
import { COOCCURRENCE_RULE } from '@/lib/cooccurrence-rule'
import {
  extractComputeParams,
  buildRequest,
  extractQualComputeParams,
  buildQualSaturationParams,
  buildQualCooccurrenceParams,
  buildQualComparisonRequest,
  qualChartKind,
  qualChartHasEnoughToFetch,
  extractComparisonParams,
  extractCrossTabParams,
  extractGroupDisplayOptions,
  quantChartKind,
  qualChartRefusal,
  type QualChartKind,
  type QualComputeParams,
} from '@/components/canvas/inline-chart-params'
import { isQualitativeMaterialConfig } from '@/lib/material-kind'
import { describeUndefined, formatStat, NO_VALUE, undefinedTooltip } from '@/lib/stat-format'
import {
  effectSizeText, groupStatHeaders, groupStatTexts, hasDifferenceColumn, meanDifference,
  pCellText, testStatisticText,
} from '@/lib/group-comparison-display'
import { untestedGroupsNote } from '@/lib/untested-groups'
import { describeUnavailable } from '@/lib/comparison-unavailable'
import { computeRequest, displayCoderScope, JOINT_DISPLAY_NODE, readDisplay, type JointDisplay } from '@/lib/joint-display'
import {
  buildJointDisplayReport, computeFailureText, NO_GROUPING_TEXT, reportToDocx, reportToHtml, reportToMarkdown,
  type DocxDisplayTable, type JointDisplayReport, type ReportResult,
} from '@/lib/joint-display-report'
import { describeResult, isDisplayResult } from '@/lib/joint-display-results'
import { caseCountRequest, hasMisfit, misfitReportFacts, type MisfitReportFacts } from '@/lib/joint-display-cases'
import { withheldAttributionColumn } from '@/lib/blind-rating-columns'
import { attributionUnusableNote } from '@/lib/joint-display-vocabulary'
import { formatWrittenDate, todayIso } from '@/components/canvas/joint-display/display-helpers'

// ── Types ────────────────────────────────────────────────────────────────────

interface TiptapNode {
  type: string
  attrs?: Record<string, unknown>
  marks?: { type: string; attrs?: Record<string, unknown> }[]
  text?: string
  content?: TiptapNode[]
}

// ── Download utility ─────────────────────────────────────────────────────────

/** Download filenames follow ONE client rule — see `lib/filename.ts` (#734).
 *  Canvas titles are prose, so spaces are kept rather than underscored. */
function sanitizeFilename(name: string): string {
  return safeFilename(name, { fallback: 'canvas', spaces: 'keep' })
}

export function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = sanitizeFilename(filename)
  a.click()
  URL.revokeObjectURL(url)
}

// ── Chart data fetching ──────────────────────────────────────────────────────

interface ChartInfo {
  materialId: number
  config: Record<string, unknown>
}

/** Collect all chart-embed nodes from all themes. */
function collectChartEmbeds(themes: CanvasTheme[]): ChartInfo[] {
  const charts: ChartInfo[] = []
  const seen = new Set<number>()
  for (const theme of themes) {
    if (!theme.content) continue
    const doc = typeof theme.content === 'string' ? JSON.parse(theme.content) : theme.content
    walkNodes(doc, (node) => {
      if (node.type === 'chart-embed' && node.attrs?.materialId) {
        const mid = node.attrs.materialId as number
        if (seen.has(mid)) return
        seen.add(mid)
        try {
          const config = typeof node.attrs.config === 'string'
            ? JSON.parse(node.attrs.config as string)
            : (node.attrs.config as Record<string, unknown>) ?? {}
          charts.push({ materialId: mid, config })
        } catch {
          // Skip unparseable config
        }
      }
    })
  }
  return charts
}

function walkNodes(node: TiptapNode, callback: (n: TiptapNode) => void): void {
  callback(node)
  if (node.content) {
    for (const child of node.content) walkNodes(child, callback)
  }
}

/**
 * The viewer's blind state, threaded in from `CanvasView` (#652 slab 4).
 *
 * ⚠️ The export runs OUTSIDE React, so it cannot call `useBlindMode` — but it
 * must still honour the lens. A Timeline table exported while blind would
 * otherwise carry all-coder numbers into a file that gets shared, which is the
 * privacy problem the on-screen lens exists to prevent, only worse. It also
 * keeps the exported table equal to the rendered chart, which is the whole
 * contract of `qualChartTable`.
 *
 * Absent (e.g. a caller that predates this) ⇒ not blind, which is the historical
 * behaviour and correct on every single-coder install.
 *
 * #964: `blind` here means "narrow to self", so `CanvasView` passes
 * `useBlindMode`'s fail-closed `withholding` — true while the roster is
 * unanswered too — never the display flag `blind`.
 */
export interface TimelineExportLens {
  blind: boolean
  self: number | null
  /**
   * #1077 (b) — `useMachineCoderIds()` from the page. REQUIRED, like every other
   * reader of the machine set: without it the exported table counted a model's
   * marks on the Coders layer while the rendered embed (once fixed) did not.
   */
  machineCoderIds: MachineCoderIds
}

/** #1615 (D281, D96) — a chart that needs the viewer while blind, with no viewer to name. */
const NO_VIEWER_SENTENCE = 'The chart was not computed: the coder could not be identified while blind mode is on.'

/** #1615 (D297's Canvas path) — the qualitative kinds whose request can group people by a
 *  variable (the bar's `group_by_subtype`, the comparison's groups), so it names the viewer. */
const QUAL_KINDS_ASKING_THE_VIEWER: ReadonlySet<QualChartKind> = new Set<QualChartKind>([
  'heatmap', 'bar', 'stacked_bar', 'summary', 'comparison_table', 'comparison_bar',
])

/** A chart exported as ONE sentence in place of its table (Markdown, HTML; Word reads no table,
 *  so it prints its own "Chart data unavailable"). The sentence may name a user's variable, so
 *  it is escaped as it enters (#1422 / #1339) — a plain paragraph, as a table's note is. */
function sentenceExport(materialId: number, why: string) {
  return { materialId, md: mdBlock(why), html: `<p><em>${esc(why)}</em></p>` }
}

/** Fetch chart data for all chart-embeds and convert to tables. */
export async function fetchChartTables(
  themes: CanvasTheme[],
  projectId: number,
  timelineLens: TimelineExportLens,
): Promise<Map<number, ChartExportTable>> {
  const charts = collectChartEmbeds(themes)
  if (charts.length === 0) return new Map()

  const results = await Promise.allSettled(charts.map(chart => shapeChartTable(projectId, chart, timelineLens)))

  const map = new Map<number, ChartExportTable>()
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.md) {
      map.set(r.value.materialId, { md: r.value.md, html: r.value.html, table: r.value.table ?? null })
    }
  }
  return map
}

/**
 * ONE saved chart's table, shaped as its chart embed exports it — the dispatch below is the
 * renderer's (#1315). Exported for the joint display's different-unit strand (D165), whose
 * saved result prints the table a chart embed of the same Material would, so the two cannot
 * disagree. `md: ''` = nothing to export (the embed's title and prose still carry).
 */
export async function shapeChartTable(
  projectId: number,
  chart: ChartInfo,
  timelineLens: TimelineExportLens,
): Promise<{ materialId: number; md: string; html: string; table?: ExportTable }> {
  // #652 slab 1: a qualitative embed reads a different endpoint. Without
  // this branch `extractComputeParams` finds no columns or domains and the
  // chart exports as an EMPTY table in Markdown, HTML, PDF and the docx
  // fallback — so the export would silently lag the renderer.
  if (isQualitativeMaterialConfig(chart.config)) {
    const qualParams = extractQualComputeParams(chart.config)
    if (!qualChartHasEnoughToFetch(qualParams)) {
      return { materialId: chart.materialId, md: '', html: '' }
    }
    // #1615 (D297's Canvas path) — the two grouping reads ask the ratings question of the
    // VIEWER, from the export lens, as the embed does (`ratingsViewerField`); the figure's
    // coding stays its saved scope. Withholding with no viewer: no such read at all (D96).
    // A grouping refused while blind (D284's 409) exports the server's sentence, not a table.
    const viewer = analysisScope(timelineLens.blind, timelineLens.self)
    if (viewer == null && QUAL_KINDS_ASKING_THE_VIEWER.has(qualChartKind(qualParams)!)) {
      return sentenceExport(chart.materialId, NO_VIEWER_SENTENCE)
    }
    let table: ExportTable | null
    try {
      table = await qualChartTable(projectId, qualParams, timelineLens, ratingsViewerField(viewer?.coderIds ?? null))
    } catch (e) {
      const refusal = qualChartRefusal(e)
      if (refusal == null) throw e
      return sentenceExport(chart.materialId, refusal)
    }
    if (!table || table.rows.length === 0) return { materialId: chart.materialId, md: '', html: '' }
    return tableExport(chart.materialId, table)
  }

  // 🔴 #1315 — the SAME dispatch the renderer asks, so the two cannot take
  // different branches for one embed. They did: the renderer asked
  // "comparison?" first and this file "correlation?" first, so a comparison
  // carrying `show_scatter` drew on the canvas and exported as "Chart data
  // not available". The order lives in `quantChartKind`, nowhere else.
  const kind = quantChartKind(chart.config)

  // #1615 — the same scope the embed sends (`InlineChartRenderer`, `useAnalysisScope`), from
  // the export lens: the viewer alone while blind, so a rating score the screen leaves out is
  // left out of the file too. Withholding with no viewer to scope to: no read at all (D96).
  const scope = analysisScope(timelineLens.blind, timelineLens.self)
  if (scope == null) {
    const why = NO_VIEWER_SENTENCE
    return { materialId: chart.materialId, md: `*[${why}]*`, html: `<p><em>${why}</em></p>` }
  }
  const coderIds = scope.coderIds

  // 🔴 #817 — a quantitative COMPARISON must not be run through
  // `quickCompute` here either. This path is not a fallback for the
  // renderer: the Markdown export has no images at all, so it is the ONLY
  // thing a `.md` reader sees, and before this it carried the same wrong
  // figure the canvas drew — the pooled frequency distribution of the
  // comparison's own variables, under the comparison's title.
  //
  // ⚠️ **Two halves of one fact, in two files.** Fixing the renderer alone
  // would have left the Markdown export wrong and the HTML/PDF/docx exports
  // right (they capture the rendered PNG), so the same material would say
  // different things in different formats.
  // 🔴 #831 — and a CORRELATION or SCATTER matrix must not reach
  // `quickCompute` either, for the same reason one bullet up. The renderer
  // REFUSES to draw these (there is no inline correlation chart), so an
  // export that quietly emitted a frequency table of the correlation's own
  // variables would be the #832 divergence again: canvas honest, `.md`
  // wrong, and nothing to tell the reader which to believe.
  //
  // Exporting NOTHING is the honest match for a refusal on screen. The
  // embed's title and surrounding prose still carry into the document.
  if (kind === 'correlation') {
    return { materialId: chart.materialId, md: '', html: '' }
  }

  if (kind === 'comparison') {
    const cmp = extractComparisonParams(chart.config)
    if (cmp.request == null) return { materialId: chart.materialId, md: '', html: '' }
    const data = await comparisonsApi.groupComparison(projectId, { ...cmp.request, ...coderIdsField(coderIds) })
    // #1423: the table's own mean-or-median switch, from the same saved config.
    const table = comparisonExportTable(data, cmp.nonparametric)
    if (!table) {
      // #1615 (lead, from r6's found-beside): a comparison the server answered with a
      // reason (D275's rating score while blind, or any other) says it in the file as the
      // embed says it on screen — never the generic "not available".
      const why = describeUnavailable(data.unavailable_reason)?.title
      return why ? sentenceExport(chart.materialId, why) : { materialId: chart.materialId, md: '', html: '' }
    }
    return tableExport(chart.materialId, table)
  }

  // 🔴 #832 — a CROSS-TAB is the one descriptives type whose data does not
  // come from `quickCompute`, and #823(g) taught only the renderer that.
  // Without this branch the fall-through below computes a metric on the
  // cross-tab's ROW variable alone and emits its marginal frequency
  // distribution — the second axis silently absent, under the cross-tab's
  // own title. The canvas drew the right table and `.md` carried a
  // different one: the same material saying two things, which is exactly
  // what the #817 comment above exists to prevent.
  //
  // ⚠️ The axis derivation and the display mode are SHARED with the
  // renderer (`extractCrossTabParams`), not re-read from `content` here.
  if (kind === 'cross_tab') {
    const ct = extractCrossTabParams(chart.config)
    // A half-configured cross-tab has no row or no column axis. The
    // renderer says so on screen; an export emits nothing, exactly as it
    // does for every other unusable config.
    if (ct.request == null) return { materialId: chart.materialId, md: '', html: '' }
    const data = await metricsApi.crossTabulation(projectId, { ...ct.request, ...coderIdsField(coderIds) })
    const table = crossTabExportTable(data, ct.display, ct.scaleOrder)
    if (!table) return { materialId: chart.materialId, md: '', html: '' }
    return tableExport(chart.materialId, table)
  }

  const params = extractComputeParams(chart.config)
  if (params.columnIds.length === 0 && params.domainIds.length === 0) {
    return { materialId: chart.materialId, md: '', html: '' }
  }
  const request = buildRequest(params)
  const result = await metricsApi.quickCompute(projectId, { ...request, ...coderIdsField(coderIds) })
  const metrics = result.metrics ?? []
  if (metrics.length === 0) return { materialId: chart.materialId, md: '', html: '' }

  const chartType = (chart.config.chart_type as ChartType) ?? detectChartType(metrics)
  const metricType = params.metricType
  // #1406 — the groups the embed shows, from the function the renderer reads.
  const groupOpts = extractGroupDisplayOptions(chart.config)
  const binWidth = (chart.config.formatting as { binWidth?: number | null } | undefined)?.binWidth
  const table = convertMetrics(metrics, chartType, metricType, groupOpts, binWidth)
  // A table the shapers could not build still says so in the Markdown and
  // HTML; the `.docx` then reads "Chart data unavailable" for it.
  if (!table) {
    return {
      materialId: chart.materialId,
      md: '*[Chart data could not be converted to table]*',
      html: '<p><em>Chart data could not be converted to table</em></p>',
    }
  }
  return tableExport(chart.materialId, table)
}

// ── Joint displays (ROADMAP row 56, D174) ────────────────────────────────────────

/** A coder's name by `users.id` — threaded in from `CanvasView`, as the lens is. */
export type CoderNameLookup = (id: number) => string | null

interface DisplayInfo {
  displayKey: string
  display: JointDisplay
}

/** Every joint-display node across the themes, once per `displayKey`. */
function collectJointDisplays(themes: CanvasTheme[]): DisplayInfo[] {
  const out: DisplayInfo[] = []
  const seen = new Set<string>()
  for (const theme of themes) {
    if (!theme.content) continue
    let doc: TiptapNode
    try {
      doc = typeof theme.content === 'string' ? JSON.parse(theme.content) : theme.content
    } catch {
      continue
    }
    walkNodes(doc, node => {
      const key = node.attrs?.displayKey
      if (node.type !== JOINT_DISPLAY_NODE || typeof key !== 'string' || !key || seen.has(key)) return
      seen.add(key)
      out.push({ displayKey: key, display: readDisplay(node.attrs?.display) })
    })
  }
  return out
}

/**
 * Each joint display's REPORT table, keyed by `displayKey` — the one `buildJointDisplayReport`
 * the Report view renders (D176.2), read here under the EXPORT's lens: blind mode narrows the
 * numbers exactly as the Compact view's request does (D175), and a colleague's authorship is
 * not named. A read that fails says so in the table's place; it never sinks the export.
 */
export async function fetchDisplayReports(
  themes: CanvasTheme[],
  projectId: number,
  timelineLens: TimelineExportLens,
  coderName: CoderNameLookup,
): Promise<Map<string, JointDisplayReport>> {
  const displays = collectJointDisplays(themes)
  if (displays.length === 0) return new Map()
  const scope = displayCoderScope(timelineLens.blind, timelineLens.self)
  const ctx = { coderName, withholding: timelineLens.blind, self: timelineLens.self, asOf: formatWrittenDate(todayIso()) }

  // The saved results' metadata, once for every display (D165).
  const needResults = displays.some(d => d.display.rows.some(r => r.result_material_ids.some(id => id != null)))
  let materials: MaterialResponse[] | null = []
  let columns: AnalysisColumnsResponse | null = null
  if (needResults) {
    try {
      ;[materials, columns] = await Promise.all([
        materialsApi.listAllMaterials(projectId), metricsApi.analysisColumns(projectId),
      ])
    } catch {
      materials = null
    }
  }

  const reports = await Promise.all(displays.map(async ({ displayKey, display }) => {
    const request = computeRequest(display, scope)
    let data: JointDisplayComputeResponse | null = null
    let unavailable: string | null = null
    if (scope == null) {
      // `useBlindScope`'s rule (D96): a read with no one to scope it to must not run — and
      // since D361 there is no scope to build one from (`computeRequest` answers null).
      unavailable = 'The joint display was not computed: the coder could not be identified while blind mode is on.'
    } else if (request == null) unavailable = NO_GROUPING_TEXT
    else {
      try {
        data = await jointDisplayApi.compute(projectId, request)
      } catch (e) {
        unavailable = computeFailureText(e)  // #1639 (r1-5)
      }
    }

    const pinIds = [...new Set(display.rows.flatMap(r => r.pins.map(p => p.excerptId)).filter((x): x is number => x != null))]
    let facts: Map<number, JointDisplayPinFact> | null = new Map()
    let attributionWithheld: string | null = null
    let attributionUnusable: string | null = null
    if (pinIds.length > 0) {
      if (scope == null) {
        // #1615: D96 — no one to scope the attribution to, so no read (its column may be
        // a rating score); the pins say their attribution could not be read.
        facts = null
      } else {
        try {
          // #1615: the display's blind scope, as the Compact view sends it — a rating-derived
          // attribution column's value is left out while blind (`column_withheld`), and the
          // report's note says so by the column's name (D286).
          const got = await jointDisplayApi.pinFacts(projectId, {
            excerpt_ids: pinIds, column_id: display.attribution.column_id, coder_ids: scope.coderIds,
          })
          facts = new Map(got.pins.map(f => [f.excerpt_id, f]))
          attributionWithheld = withheldAttributionColumn(got)
          // #1653 (D346): a gone or retyped attribution variable — who and where are still read.
          attributionUnusable = attributionUnusableNote(got)
        } catch {
          facts = null
        }
      }
    }

    const results = new Map<number, ReportResult>()
    let resultsUnread = false
    const bound = [...new Set(display.rows.flatMap(r => r.result_material_ids).filter((x): x is number => x != null))]
    if (bound.length > 0 && (materials == null || columns == null)) resultsUnread = true
    else {
      for (const id of bound) {
        const m = materials!.find(x => x.id === id)
        if (!m) continue
        // A result slice 1 cannot place is named, never shaped (`describeResult` leaves its unit null).
        const shaped = isDisplayResult(m)
          ? await shapeChartTable(projectId, { materialId: id, config: m.config ?? {} }, timelineLens).catch(() => null)
          : null
        results.set(id, { ...describeResult(m, columns!), table: shaped?.table ?? null })
      }
    }

    // Joint display slice 2, round 2 (r5-8, r3-11): one COUNT-ONLY case read per row with a
    // misfit (r5-7: `limit` 0 — no person's facts), under the same lens as the numbers. Only
    // when the numbers were read: with none the report prints its one sentence and no note —
    // which is also what keeps D96 (blind, no viewer: no compute, so no case read either).
    const misfits = new Map<string, MisfitReportFacts>()
    if (data) {
      await Promise.all(display.rows.filter(hasMisfit).map(async r => {
        const req = caseCountRequest(display, r.key, scope)
        if (req == null) { misfits.set(r.key, 'unread'); return }
        try {
          misfits.set(r.key, misfitReportFacts(await jointDisplayApi.cases(projectId, req), (r.misfit?.rule?.conditions.length ?? 0) > 0))
        } catch {
          misfits.set(r.key, 'unread')
        }
      }))
    }

    return [displayKey, buildJointDisplayReport({ display, data, unavailable, facts, attributionWithheld, attributionUnusable, results, resultsUnread, misfits }, ctx)] as const
  }))
  return new Map(reports)
}

/** The Word payload for each display (`display_tables`) — the same report, as strings. */
export function docxDisplayTables(reports: Map<string, JointDisplayReport>): Map<string, DocxDisplayTable> {
  return new Map([...reports].map(([key, r]) => [key, reportToDocx(r)]))
}

/** What a theme's Tiptap renders against: the charts' tables and the displays' reports. */
interface ExportTables {
  charts: Map<number, { md: string; html: string }>
  displays: Map<string, JointDisplayReport>
}

/**
 * #1406 D5 — the tables the `.docx` export renders for a chart with no captured
 * image. The server derives none of its own (its `_get_chart_table_data` read
 * a grouped metric's missing-group bucket, and ignored the embed's grouping,
 * proportion settings and exclusions), so a Word table is the one the Markdown
 * and HTML exports print.
 */
export function docxChartTables(tables: Map<number, ChartExportTable>): Map<number, ExportTable> {
  const out = new Map<number, ExportTable>()
  for (const [materialId, t] of tables) {
    if (t.table) out.set(materialId, t.table)
  }
  return out
}

/**
 * The cross-tab grid, shaped exactly as `AnalysisCrossTabTable` draws it (#832).
 *
 * ⚠️ **Mirroring the DISPLAY MODE is the point, not a nicety.** The component
 * shows `count`, `row_pct`, `col_pct` or `total_pct` per `cross_tab_display`,
 * and reverses BOTH axes when `scaleOrder === 'reversed'`. An export that always
 * emitted counts in natural order would still be a different table from the one
 * on screen — a quieter version of the defect this branch exists to close.
 *
 * The totals row and column come from the payload's own `row_totals` /
 * `col_totals` / `n_shared`, reordered with the axes, so they are counts even
 * when the cells are percentages — as they are in the rendered table.
 */
function crossTabExportTable(
  data: AnalysisCrossTabResponse,
  display: string,
  scaleOrder: string,
): { headers: string[]; rows: string[][] } | null {
  if (data.row_values.length === 0 || data.col_values.length === 0) return null

  const reversed = scaleOrder === 'reversed'
  const rowValues = reversed ? [...data.row_values].reverse() : data.row_values
  const colValues = reversed ? [...data.col_values].reverse() : data.col_values
  const rowIndex = rowValues.map(v => data.row_values.indexOf(v))
  const colIndex = colValues.map(v => data.col_values.indexOf(v))

  const isPercent = display !== 'count'
  const cellValue = (ri: number, ci: number): number => {
    const cell = data.matrix[rowIndex[ri]]?.[colIndex[ci]]
    if (!cell) return 0
    switch (display) {
      case 'row_pct': return cell.row_pct
      case 'col_pct': return cell.col_pct
      case 'total_pct': return cell.total_pct
      default: return cell.count
    }
  }
  const fmtCell = (v: number): string =>
    isPercent ? `${v.toFixed(DISPLAY_PRECISION)}%` : String(v)

  const headers = [data.row_column_label, ...colValues, 'Total']
  const rows = rowValues.map((rv, ri) => [
    rv,
    ...colValues.map((_, ci) => fmtCell(cellValue(ri, ci))),
    String(data.row_totals[rowIndex[ri]] ?? ''),
  ])
  rows.push([
    'Total',
    ...colIndex.map(i => String(data.col_totals[i] ?? '')),
    String(data.n_shared),
  ])
  return { headers, rows }
}

/**
 * A group comparison as a plain table (#817) — the Markdown export's only view of it,
 * the table under the figure's image in HTML/PDF, Word's table when no image was
 * captured (#1406 D5), and the joint display's bound saved result (D165, through
 * `shapeChartTable`).
 *
 * 🔴 **#1423 — every cell is the screen's, from the resolvers `GroupComparisonTable` and
 * `ComparisonTestStrip` render (`lib/group-comparison-display.ts`), never a derivation of
 * its own.** This printed the test's wire id (`kruskal_wallis = 48.557`), the MEAN under a
 * figure showing medians, `p.toFixed(4)` ("0.0000") and no effect size. Columns:
 * - `Variable`, then per group the table's own columns — n, M, SD, or n and Mdn under a
 *   rank test (`nonparametric` is the embed's saved setting, the prop the table gets);
 * - `Δ (A − B)` where the table shows its Difference column (two groups, a
 *   variance-based test);
 * - `Test` — the strip's `F(2, 15) = 42.35`; `p` — the table's `.002` / `<.001`, with
 *   the method the data chose (#1326 D58); `Effect size` — the strip's
 *   `ω² = 0.82 (large)`, with d's interval.
 * ⚠️ No significance stars (their legend would have to ride the note) and no post-hoc
 * block: the image carries both where there is one.
 *
 * ⚠️ **A row whose test did not run prints the REASON, never a blank cell** (#566).
 */
function comparisonExportTable(
  data: GroupComparisonResponse,
  nonparametric: boolean,
): ExportTable | null {
  if (data.rows.length === 0) return null
  const delta = hasDifferenceColumn(data.groups, nonparametric)
  const statHeaders = groupStatHeaders(nonparametric)
  const headers = [
    'Variable',
    ...data.groups.flatMap(g => statHeaders.map(h => `${g} ${h}`)),
    ...(delta ? [`Δ (${data.groups[0]} − ${data.groups[1]})`] : []),
    'Test',
    'p',
    'Effect size',
  ]
  const rows = data.rows.map(row => {
    const cells: string[] = [row.full_label || row.label]
    for (const g of data.groups) {
      cells.push(...groupStatTexts(row.group_stats.find(s => s.group === g), nonparametric))
    }
    const test = row.test
    // The table's Difference cell is a dash when the row's test did not run.
    if (delta) cells.push(test ? formatStat(meanDifference(row, data.groups)) : NO_VALUE)
    if (test) {
      cells.push(testStatisticText(test), pCellText(test), effectSizeText(test))
    } else {
      cells.push(describeUndefined(row.test_omitted_reason) ?? 'Not computed', NO_VALUE, NO_VALUE)
    }
    return cells
  })
  // #1329 (D51): the rendered table says which groups its tests left out, so
  // the exported one does too — under it, as the figure's own words (#1323).
  const several = data.rows.length > 1
  const notes = data.rows
    .map(r => untestedGroupsNote(r.untested_groups, several ? (r.full_label || r.label) : undefined))
    .filter((n): n is string => n != null)
  return notes.length ? { headers, rows, note: notes.join(' ') } : { headers, rows }
}

/**
 * Fetch and flatten whichever payload this qualitative chart is made of.
 *
 * Dispatches on the SAME `qualChartKind` the renderer uses, so an exported
 * table can never describe a different chart than the one on screen. Note
 * co-occurrence is fetched directly here — the export mounts no components, so
 * the fact that `QualCooccurrence` normally fetches for itself is irrelevant on
 * this path.
 */
async function qualChartTable(
  projectId: number,
  params: QualComputeParams,
  timelineLens: TimelineExportLens,
  /** #1615 — `ratingsViewerField(…)`, spread into the two grouping reads only. */
  viewer: { ratings_viewer_id?: number },
): Promise<ExportTable | null> {
  switch (qualChartKind(params)) {
    case 'timeline':
      return qualTimelineTable(projectId, params, timelineLens)

    case 'heatmap':
    case 'bar':
    case 'stacked_bar':
    case 'summary': {
      const data = await codeAnalysisApi.sourceFrequencies(projectId, { ...params.request, ...viewer })
      return qualFrequenciesToTable(data, params.orientation === 'codes-rows')
    }

    case 'saturation': {
      const data = await codeAnalysisApi.saturation(projectId, buildQualSaturationParams(params))
      return {
        headers: ['#', 'Source', 'New codes', 'Cumulative unique codes'],
        rows: (data.points ?? []).map(p => [
          String(p.source_index + 1),
          p.source_label,
          String(p.new_codes_this_source),
          String(p.cumulative_unique_codes),
        ]),
      }
    }

    case 'cooccurrence': {
      const data = await codeAnalysisApi.cooccurrence(projectId, {
        ...buildQualCooccurrenceParams(params),
        level: params.cooccurrenceLevel,
      })
      const codes = data.codes ?? []
      if (codes.length === 0) return null
      return {
        headers: ['Code', ...codes.map(c => c.name)],
        rows: codes.map((code, i) => [code.name, ...codes.map((_, j) => String(data.matrix?.[i]?.[j] ?? 0))]),
        // #1335 (D47): the rule the figure's caption says, under the table — a
        // Markdown or HTML reader sees no caption.
        note: COOCCURRENCE_RULE,
      }
    }

    case 'comparison_table':
    case 'comparison_bar': {
      const request = buildQualComparisonRequest(params)
      if (!request) return null
      const data = await codeAnalysisApi.demographicComparison(projectId, { ...request, ...viewer })
      const groups = data.groups ?? []
      if (groups.length === 0) return null
      // #1323: the unit is in the header ("Board (of 5 participants)") and the test
      // rides with both p-values — the Markdown export has no image to carry them —
      // and the method note the figure prints beneath itself rides as the table's
      // `note` (session B). The scope sentence is not here: the figure does not
      // carry it either (it is RelationshipsPanel's).
      const basis = data.basis
      const tested = basis != null && basis.test_omitted_reason == null
      // D3: two groups carry Δ, and over a tested unit its interval — labelled by
      // `ciLabel` (the level, then "(unadjusted)"), because the p beside it IS adjusted.
      const twoGroups = groups.length === 2
      const ci = (data.codes ?? []).find(c => c.delta_ci)?.delta_ci
      return {
        headers: [
          'Code',
          // No basis (a payload from before it existed): the old header, unrelabelled.
          ...groups.map(g => (basis ? `${g} (of ${unitCount(basis.unit, data.group_totals?.[g]?.n ?? 0)})` : `${g} n`)),
          ...groups.map(g => `${g} %`),
          ...(twoGroups ? ['Δ (percentage points)'] : []),
          ...(twoGroups && ci ? [`Δ ${ciLabel(ci.method, ci.level)}`] : []),
          ...(tested ? ['p', `p adjusted (${correctionName(basis.correction)})`] : []),
        ],
        rows: (data.codes ?? []).map(entry => [
          entry.code_name,
          ...groups.map(g => String(entry.by_group?.[g]?.count ?? 0)),
          ...groups.map(g => {
            const cell = entry.by_group?.[g]
            const p = cell?.proportion
            if (p != null) return `${(p * 100).toFixed(1)}%`
            // #1421: a group with no material has no share — `—` and the server's
            // reason, #1363's rule for an undefined cell (a blank reads as a broken
            // export). An absent cell keeps its blank.
            return cell ? `${NO_VALUE} ${undefinedTooltip(cell.undefined_reason)}` : ''
          }),
          ...(twoGroups
            ? [entry.delta_proportion != null
                ? `${entry.delta_proportion >= 0 ? '+' : ''}${(entry.delta_proportion * 100).toFixed(1)}`
                : NO_VALUE]
            : []),
          ...(twoGroups && ci ? [deltaIntervalVisual(entry.delta_ci) ?? NO_VALUE] : []),
          ...(tested
            ? entry.test
              ? [formatP(entry.test.p_value), entry.test.p_adjusted != null ? formatP(entry.test.p_adjusted) : NO_VALUE]
              : [NO_VALUE, describeOmittedTest(entry.test_omitted_reason) ?? NO_VALUE]
            : []),
        ]),
        // #1626 (D244): the participants with no coding in scope, after the method
        // note, as the figure prints them beneath itself.
        note: [
          comparisonMethodNote(data),
          noCodingNote(
            groups.map(g => [g, data.group_totals?.[g]?.without_coding ?? 0] as const),
            noCodingScope(data.scope?.no_coding_scope),
          ),
        ].filter(Boolean).join(' ') || undefined,
      }
    }

    default:
      return null
  }
}

/**
 * Flatten a Timeline material into one table (#652 slab 4).
 *
 * ⚠️ **This is the one place a second implementation could appear.** Every other
 * kind hands a fetched payload to a flattener; the Timeline has no endpoint, so
 * this path has to do the same resolving and the same arithmetic the renderer
 * does — and a divergence here would be invisible, because both outputs look
 * plausible and only differ in a number. So it calls exactly the shared pieces:
 * `resolveTimeline*` for which observations / codes / marks count,
 * `timedExtent` + `computeTimedRows` + `coveredTotalSeconds` for the maths, and
 * the `formatTimed*` trio for the strings. Nothing is re-derived locally.
 *
 * The table is BY CODE only — the on-screen "By code × coder" toggle is local
 * per-observation state that no config records (#685), so by-code is the only
 * breakdown a saved material can be said to have.
 */
async function qualTimelineTable(
  projectId: number,
  params: QualComputeParams,
  lens: TimelineExportLens,
): Promise<{ headers: string[]; rows: string[][] } | null> {
  // Mirrors the embed's first gate: the clip payload has no consensus layer to draw.
  if (params.layerScope === 'consensus') return null

  const [observationList, codeList] = await Promise.all([
    observationsApi.list(projectId),
    codesApi.list(projectId),
  ])
  const observations = resolveTimelineObservations(params.request.observation_ids ?? [], observationList)
  const codes = resolveTimelineCodes(params.request.code_ids ?? [], codeList.codes ?? [])
  if (observations.length === 0 || codes.length === 0) return null

  // `multiCoder` is irrelevant here (no coder column), so the roster flag is
  // false; the blind arm is what matters and it ignores it.
  const { lens: timed } = resolveTimelineCoderLens(
    params.request.coder_ids ?? null, lens.blind, lens.self, false,
    lens.machineCoderIds, timedLayerFor(params.layerScope) ?? 'human',
  )
  const codeIds = codes.map(c => c.id)

  const clipsPerObservation = await Promise.all(
    observations.map(o => observationsApi.listSegments(projectId, o.id)),
  )

  const rows: string[][] = []
  observations.forEach((obs, i) => {
    const clips = clipsPerObservation[i] ?? []
    const { extent } = timedExtent(obs.media_duration_seconds, clips)
    const codeRows = computeTimedRows(clips, codeIds, timed, extent)
    codeRows.forEach((row, j) => {
      rows.push([
        obs.name,
        codes[j].name,
        String(row.marks),
        formatTimedSeconds(row.airtimeSeconds),
        formatTimedShare(row.airtimeFraction),
        formatTimedRate(row.ratePerMinute),
        formatTimedSeconds(row.meanBoutSeconds),
        formatTimedSeconds(row.medianBoutSeconds),
        formatTimedSeconds(row.maxBoutSeconds),
      ])
    })
    // The table's footer row, flattened. Airtimes across codes do NOT sum to
    // this (codes overlap) — carrying it is what stops a reader adding the
    // column up and getting a different, wrong answer.
    const covered = coveredTotalSeconds(clips, codeIds, timed, extent)
    if (covered != null && extent != null) {
      rows.push([
        obs.name,
        'Covered by selected coding',
        '',
        formatTimedSeconds(covered),
        formatTimedShare(covered / extent),
        '', '', '', '',
      ])
    }
  })

  if (rows.length === 0) return null
  return {
    headers: [
      'Observation', 'Code', 'Marks', 'Airtime', 'Share of session',
      'Rate', 'Mean bout', 'Median bout', 'Longest bout',
    ],
    rows,
  }
}

/**
 * Flatten a source-frequencies payload into a codes × sources count table.
 *
 * Honours the material's saved orientation so the exported table reads the way
 * the researcher arranged the chart — transposed, not re-derived, because the
 * numbers are identical either way and only the axes swap.
 */
function qualFrequenciesToTable(
  data: SourceFrequenciesResponse,
  codesAsRows: boolean,
): { headers: string[]; rows: string[][] } {
  const codes = data.codes ?? []
  const sources = data.sources ?? []
  if (codes.length === 0 || sources.length === 0) return { headers: [], rows: [] }

  const countFor = (source: (typeof sources)[number], codeId: number): string =>
    String(source.code_counts?.[String(codeId)]?.count ?? 0)

  if (codesAsRows) {
    return {
      headers: ['Code', ...sources.map(s => s.source_label)],
      rows: codes.map(code => [code.name, ...sources.map(s => countFor(s, code.id))]),
    }
  }
  return {
    headers: ['Source', ...codes.map(c => c.name)],
    rows: sources.map(source => [source.source_label, ...codes.map(c => countFor(source, c.id))]),
  }
}

// ── Chart-to-table conversion ────────────────────────────────────────────────

function fmt(v: number | null | undefined, decimals = 1): string {
  if (v == null) return ''
  return Number(v.toFixed(decimals)).toString()
}

/**
 * #1363 — a SCALAR statistic's cell: the number, or `—` and the reason. `fmt`'s
 * blank is right for an absent count and wrong here: before #1363 these cells
 * printed `0` for an undefined statistic, and a blank is indistinguishable from
 * a broken export (#566's rule, which the comparison table above already keeps).
 */
function fmtScalar(v: number | null | undefined, reason?: string | null): string {
  if (v != null) return fmt(v)
  return `${NO_VALUE} ${undefinedTooltip(reason)}`
}

/**
 * #1412 — a FREQUENCY share's cell: `N%`, or `—` and the reason when the result
 * had no valid answers (the shapers' `null`). A real 0 is `0%`.
 */
function fmtFrequencyShare(v: number | null | undefined, reason?: string | null): string {
  return v == null ? fmtScalar(null, reason) : `${fmt(v)}%`
}

/** #1406 D5 — a chart's table as headers and rows, before any format renders it. */
export interface ExportTable {
  headers: string[]
  rows: string[][]
  /**
   * #1323 — a paragraph printed UNDER the table in the Markdown and HTML renderings:
   * the words the rendered figure carries beneath itself (the comparison's method
   * note), which a Markdown reader otherwise never sees. #1458 D260: the `.docx`
   * fallback table prints it too — `docxChartTables` sends it and
   * `routers/canvas.py::_decode_chart_tables` validates it (a non-string drops the
   * entry; over 20,000 characters is `too_large`, never cut). Under a captured image
   * Word prints no note: the image carries its own.
   */
  note?: string
}

/**
 * One chart's entry from `fetchChartTables`: its Markdown and HTML renderings,
 * and the table they render — `null` when none could be shaped, so the
 * `.docx` cannot print a table the other formats do not.
 */
export interface ChartExportTable {
  md: string
  html: string
  table: ExportTable | null
}

function tableExport(materialId: number, table: ExportTable) {
  // A plain paragraph, not emphasis: the note is generated prose, and an `*` or `_`
  // inside it would unbalance Markdown emphasis. It names groups (user values), so it
  // is escaped as it enters (#1422).
  const md = mdTable(table.headers, table.rows) + (table.note ? `\n\n${mdBlock(table.note)}` : '')
  const html = htmlTable(table.headers, table.rows) + (table.note ? `\n<p>${esc(table.note)}</p>` : '')
  return { materialId, md, html, table }
}

/**
 * #1422 — every header and cell is DATA, escaped by `mdLine` (a `|` would add a column, a
 * newline end the row, a `*` or `<Tag>` become markup); a cell can never carry Markdown.
 */
function mdTable(headers: string[], rows: string[][]): string {
  const h = `| ${headers.map(mdLine).join(' | ')} |`
  const sep = `| ${headers.map(() => '---').join(' | ')} |`
  const body = rows.map(r => `| ${r.map(mdLine).join(' | ')} |`).join('\n')
  return `${h}\n${sep}\n${body}`
}

function htmlTable(headers: string[], rows: string[][]): string {
  const ths = headers.map(h => `<th>${esc(h)}</th>`).join('')
  const trs = rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('\n')
  return `<table>\n<thead><tr>${ths}</tr></thead>\n<tbody>\n${trs}\n</tbody>\n</table>`
}

/**
 * #1339 — escape a value for HTML TEXT **and** a double- or single-quoted
 * ATTRIBUTE. One function for both contexts, because the call sites already mix
 * them (`alt="${title}"` reuses the heading's escaped title) and a text-only
 * escape there let a `"` open a new attribute — an `onload` on the chart image,
 * which runs when the downloaded file is OPENED.
 *
 * Takes `unknown`: node attrs are untyped JSON that a `.mmproject` import stores
 * verbatim, and a non-string used to throw out of `.replace` and fail the whole
 * export.
 */
function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** The schemes a link in an exported report keeps its anchor for (#1339). */
const EXPORT_LINK_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'mailto'])

/**
 * #1339 — the href to emit for a link mark, or `null` when the export must
 * drop the anchor and keep only the link's words.
 *
 * ALLOW-list, anchored at the first non-blank character: an href keeps its
 * anchor only when it literally begins `http:`, `https:` or `mailto:`. A
 * browser's URL parser also drops leading C0 controls and every tab/newline,
 * so `\u0001javascript:` and `java\tscript:` are `javascript:` to it — and
 * both are refused here because neither BEGINS with an allowed scheme. Nothing
 * a parser removes can turn a string that begins `https:` into another scheme.
 * (Measured: a version that first stripped every C0 control passed the same
 * tests — the strip was redundant, so it is not here; `trim()` stays only so a
 * pasted ` https://…` keeps its anchor.)
 *
 * ⚠️ Not Tiptap's `isAllowedUri`: the editor never sees imported JSON, and
 * that check accepts relative and scheme-less hrefs, which resolve against the
 * downloaded FILE and so lead nowhere a reader could follow.
 */
export function exportableHref(href: unknown): string | null {
  if (typeof href !== 'string') return null
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href.trim())?.[1]?.toLowerCase()
  return scheme && EXPORT_LINK_SCHEMES.has(scheme) ? href : null
}

/**
 * #1339 — the exported HTML leaves the app, and with it the app's own CSP, so
 * it states one. It permits what the document uses (its `<style>` and the
 * chart PNG data URLs) and nothing else: no script, no handler, no navigation
 * to `javascript:` — so an escape this module misses still cannot run.
 */
const EXPORT_CSP_META =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`

type GroupDisplayOptions = ReturnType<typeof extractGroupDisplayOptions>

/**
 * A metric chart's table, shaped ONCE — the Markdown, HTML and `.docx` exports
 * each render it (#1406 D5) — or `null` when the shapers could not build it.
 */
function convertMetrics(
  metrics: MetricDefinitionResponse[],
  chartType: ChartType | null,
  metricType: string,
  groupOpts: GroupDisplayOptions,
  binWidth?: number | null,
): ExportTable | null {
  const table = (headers: string[], rows: string[][]): ExportTable => ({ headers, rows })

  try {
    if (metricType === 'frequency_distribution') {
      // #1406 — a histogram's table is its BINS, as drawn (pooled across groups
      // when grouped — `shapeHistogramBars` says so under the chart).
      if (chartType === 'histogram' && metrics.length === 1) {
        const { bars } = shapeHistogramBars(metrics[0], { binWidth })
        return table(['Bin', '%', 'Count'], bars.map(b => [b.label, `${fmt(b.value)}%`, String(b.count ?? '')]))
      }
      // #1406 — ONE grouped distribution is a row per group, the heatmap's
      // shape; `shapeFrequencyBars` read `results[0]`, the missing-group bucket.
      if (chartType === 'heatmap' || metrics.length > 1 || isGroupedMetrics(metrics)) {
        const data = shapeHeatmapRows(metrics, groupOpts)
        const headers = ['Variable', ...data.columnLabels, 'N']
        // #1412: a row nobody answered is `—` and why in every cell, never `0%`.
        const rows = data.rows.map(r => [
          r.label,
          ...r.cells.map(c => c ? fmtFrequencyShare(c.percentage, c.undefinedReason) : ''),
          String(r.totalN ?? ''),
        ])
        return table(headers, rows)
      }
      // Single frequency distribution
      const bars = shapeFrequencyBars(metrics[0])
      const headers = ['Response', '%', 'Count']
      const rows = bars.map(b => [b.label, fmtFrequencyShare(b.value, b.undefinedReason), String(b.count ?? '')])
      return table(headers, rows)
    }

    // Scalar metrics
    if (chartType === 'dumbbell') {
      // #1406 — the embed hides the saved hidden groups; so must its table.
      const data = shapeDumbbellRows(metrics, undefined, groupOpts)
      const headers = ['Metric', ...data.groupValues.map(g => g ?? 'Overall'), 'N']
      // One cell per HEADER, looked up by group — `r.dots.map` shifted every
      // later column left under a metric that has no result for some group.
      const rows = data.rows.map(r => [
        r.label,
        ...data.groupValues.map(g => {
          const d = r.dots.find(dd => dd.groupValue === g)
          return d ? fmtScalar(d.value, d.undefinedReason) : ''
        }),
        String(r.dots[0]?.n ?? ''),
      ])
      return table(headers, rows)
    }

    if (chartType === 'line') {
      // #1479 — the hidden groups' series are dropped, as the embed drops them.
      const data = shapeLineChart(metrics, undefined, undefined, groupOpts)
      // Grouped by `LineChart`'s own rule: ONE series left visible is still a
      // group and keeps its name as the column — the old `length <= 1` test
      // printed group A's numbers under "Value", saying nothing of A.
      const grouped = data.series.some(s => s.groupValue != null)
      if (!grouped) {
        const headers = ['Metric', 'Value', 'N']
        const rows = (data.series[0]?.points ?? []).map(p => [
          p.label, fmtScalar(p.value, p.undefinedReason), String(p.n ?? ''),
        ])
        return table(headers, rows)
      }
      const headers = ['Metric', ...data.series.map(s => s.groupValue ?? 'Overall')]
      const points = data.series[0]?.points ?? []
      const rows = points.map((p, i) => [
        p.label,
        ...data.series.map(s => {
          const q = s.points[i]
          return q ? fmtScalar(q.value, q.undefinedReason) : ''
        }),
      ])
      return table(headers, rows)
    }

    // Default: scalar bars (and the summary table) — through THE decision the
    // embed draws by (#1406), so a grouped figure exports a row per group, each
    // with its own n, an undefined group as `—` and a real 0 as `0`.
    const figure = shapeScalarBarFigure(metrics, groupOpts)
    if (figure.kind === 'grouped') {
      const rows = figure.sections.flatMap(s => s.groups.map(g => [
        s.metricName, g.groupValue, fmtScalar(g.value, g.undefinedReason), String(g.n),
      ]))
      return table(['Metric', 'Group', 'Value', 'N'], rows)
    }
    const headers = ['Metric', 'Value', 'N']
    const rows = figure.bars.map(b => [b.label, fmtScalar(b.value, b.undefinedReason), String(b.n ?? '')])
    return table(headers, rows)
  } catch {
    return null
  }
}

// ── Tiptap-to-Markdown ───────────────────────────────────────────────────────

/**
 * A text node: its words escaped ONCE (#1422), then the marks wrapped around them — never the
 * other way round, or the marks' own `*` would be escaped. A `\n` in the text is a line
 * break, resolved by the enclosing block (`mdLines`).
 */
function renderTextWithMarks(node: TiptapNode): string {
  let text = mdText(node.text)
  if (!node.marks) return text
  for (const mark of node.marks) {
    switch (mark.type) {
      case 'bold': text = mdWrap('**', text); break
      case 'italic': text = mdWrap('*', text); break
      case 'strike': text = mdWrap('~~', text); break
      // DECIDED (r1-9): Markdown has no underline, and inline `<u>` prints as literal tags
      // where a renderer disables HTML (markdown-it's default preset) — so the words, plain.
      case 'underline': break
      case 'link': {
        const href = exportableHref(mark.attrs?.href)
        if (href != null) text = `[${text}](${mdDestination(href)})`
        break
      }
    }
  }
  return text
}

/** #1457 — an @mention prints as the editor draws it: `@` and its label (the id without one). */
function mentionText(node: TiptapNode): string {
  return `@${String(node.attrs?.label ?? node.attrs?.id ?? '')}`
}

/**
 * An ordered list's first number (Tiptap's input rule stores a typed "3. " as `start: 3`).
 * A non-negative integer, else 1 — the Word export's rule (`_new_numbering`), so the formats agree.
 */
function listStart(node: TiptapNode): number {
  const s = node.attrs?.start
  return typeof s === 'number' && Number.isInteger(s) && s >= 0 ? s : 1
}

/** `- ` / `1. ` and the item's blocks, every later line indented under the marker (#1422):
 *  an unindented second paragraph or nested list leaves the item. */
function mdListItem(marker: string, body: string): string {
  const pad = ' '.repeat(marker.length)
  return marker + body.trim().split('\n').map((l, i) => (i === 0 || l === '' ? l : pad + l)).join('\n') + '\n'
}

function nodeChildrenToMd(node: TiptapNode, tables: ExportTables): string {
  if (!node.content) return ''
  return node.content.map(c => nodeToMd(c, tables)).join('')
}

/**
 * The joint display in either format: its report table, or — when the node's key matched no
 * report (it could not be collected) — one sentence, never nothing: an unknown node rendered
 * NOTHING in every export before session C, silently.
 */
function jointDisplayExport(node: TiptapNode, tables: ExportTables, format: 'md' | 'html'): string {
  const key = node.attrs?.displayKey
  const report = typeof key === 'string' ? tables.displays.get(key) : undefined
  if (report) return format === 'md' ? reportToMarkdown(report) : reportToHtml(report, esc)
  const text = 'Joint display not available in this export.'
  return format === 'md' ? `*[${text}]*\n\n` : `<p><em>${esc(text)}</em></p>\n`
}

function nodeToMd(node: TiptapNode, tables: ExportTables): string {
  const chartTables = tables.charts
  switch (node.type) {
    case 'text':
      return renderTextWithMarks(node)

    // #1457 — Shift+Enter; the enclosing block turns it into a hard break (`mdLines`).
    case 'hardBreak':
      return '\n'

    case 'mention':
      return mdText(mentionText(node))

    case 'paragraph':
      return mdLines(nodeChildrenToMd(node, tables)) + '\n\n'

    case 'heading': {
      // Only imported JSON holds one (the editor has no headings). An ATX heading is one line,
      // so a line break in it is a space here; HTML keeps it as `<br>`.
      const level = (node.attrs?.level as number) ?? 3
      const prefix = '#'.repeat(Math.min(level + 2, 6)) // offset: themes are h2
      return `${prefix} ${mdHeading(nodeChildrenToMd(node, tables))}\n\n`
    }

    case 'bulletList':
      return (node.content ?? []).map(li => mdListItem('- ', nodeChildrenToMd(li, tables))).join('') + '\n'

    case 'orderedList': {
      // CommonMark takes the list's first number as its start (r1-10); a marker past nine digits
      // is not a list marker at all, so such a list counts from 1 rather than becoming prose.
      const items = node.content ?? []
      const start = listStart(node) + items.length - 1 <= 999_999_999 ? listStart(node) : 1
      return items.map((li, i) => mdListItem(`${start + i}. `, nodeChildrenToMd(li, tables))).join('') + '\n'
    }

    case 'listItem':
      return nodeChildrenToMd(node, tables)

    case 'blockquote':
      return nodeChildrenToMd(node, tables).trim().split('\n').map(l => `> ${l}`).join('\n') + '\n\n'

    case 'horizontalRule':
      return '---\n\n'

    case 'excerpt-embed': {
      // #1422 \u2014 EVERY line of the quote carries `> `: a participant's second paragraph must not
      // leave the quote and read as the researcher's prose. The attribution and the tag are
      // their own lines inside it (they ran onto the quote's line as a soft break).
      const text = (node.attrs?.displayText as string) ?? ''
      const source = (node.attrs?.sourceContext as string) ?? ''
      const tag = (node.attrs?.materialTag as string) ?? ''
      const parts = [`"${mdBlock(text)}"`]
      if (source) parts.push(mdWrap('*', `\u2014 ${mdLine(source)}`))
      if (tag) parts.push(`Tag: ${mdLine(tag)}`)
      return parts.join('\n\n').split('\n').map(l => (l ? `> ${l}` : '>')).join('\n') + '\n\n'
    }

    case 'chart-embed': {
      const title = (node.attrs?.title as string) ?? 'Chart'
      const mid = node.attrs?.materialId as number
      const tag = (node.attrs?.materialTag as string) ?? ''
      const tableData = mid ? chartTables.get(mid) : undefined
      let md = `${mdWrap('**', mdLine(title))}\n\n`
      if (tableData?.md) {
        md += tableData.md + '\n\n'
      } else {
        md += '*[Chart data not available as table]*\n\n'
      }
      if (tag) md += `Tag: ${mdLine(tag)}\n\n`
      return md
    }

    case 'memo-embed': {
      const numId = node.attrs?.numericId ?? ''
      const title = (node.attrs?.title as string) ?? ''
      const preview = (node.attrs?.preview as string) ?? ''
      const tag = (node.attrs?.materialTag as string) ?? ''
      let md = `${mdWrap('**', `Memo M-${mdLine(numId)}${title ? `: ${mdLine(title)}` : ''}`)}\n\n`
      if (preview) md += `${mdBlock(preview)}\n\n`
      if (tag) md += `Tag: ${mdLine(tag)}\n\n`
      return md
    }

    case 'callout-stat': {
      const value = (node.attrs?.value as string) ?? ''
      const label = (node.attrs?.label as string) ?? ''
      const source = (node.attrs?.sourceDescription as string) ?? ''
      const tag = (node.attrs?.materialTag as string) ?? ''
      // `mdLines` guards the line's start: with no value it begins with the label.
      let md = `${mdLines(`${mdWrap('**', mdLine(value))} ${mdLine(label)}`)}\n\n`
      if (source) md += `${mdWrap('*', `Source: ${mdLine(source)}`)}\n\n`
      if (tag) md += `Tag: ${mdLine(tag)}\n\n`
      return md
    }

    case 'image-embed': {
      const alt = (node.attrs?.alt as string) ?? 'Image'
      const tag = (node.attrs?.materialTag as string) ?? ''
      let md = `*[Image: ${mdLine(alt)}]*\n\n`
      if (tag) md += `Tag: ${mdLine(tag)}\n\n`
      return md
    }

    case JOINT_DISPLAY_NODE:
      return jointDisplayExport(node, tables, 'md')

    default:
      // Unknown node — try to render children
      return nodeChildrenToMd(node, tables)
  }
}

function tiptapToMarkdown(content: unknown, tables: ExportTables): string {
  if (!content) return ''
  const doc = typeof content === 'string' ? JSON.parse(content) : content
  if (!doc?.content) return ''
  return (doc.content as TiptapNode[]).map(n => nodeToMd(n, tables)).join('').trim()
}

// ── Chart PNG capture ─────────────────────────────────────────────────────────

/**
 * Wait until every chart-embed in the DOM has either rendered its chart (an
 * <svg> inside the capture root) or reached a terminal non-loading state, so a
 * capture doesn't grab "Loading chart…" spinners. Bounded by timeoutMs.
 *
 * Charts render via InlineChartRenderer which fetches data through react-query;
 * by export time they're usually cached, but this guards the cold-cache case.
 */
async function waitForChartsReady(timeoutMs = 3500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const wrappers = document.querySelectorAll('[data-type="chart-embed"][data-material-id]')
    if (wrappers.length === 0) return
    const stillLoading = Array.from(wrappers).some(
      (w) => w.querySelector('.animate-spin') || /Loading chart/.test(w.textContent || ''),
    )
    if (!stillLoading) return
    await new Promise((r) => setTimeout(r, 120))
  }
}

/**
 * Rasterize every chart-embed currently in the DOM to a PNG data URL, keyed by
 * materialId. Captures the clean chart subtree (`[data-chart-capture-root]`) so
 * the node's title heading, "Open in Analysis" link, and hover buttons are NOT
 * baked into the image. Charts must be mounted to capture — i.e. the Writing
 * view must be active; from the Spatial view this returns an empty map and
 * callers fall back to data tables.
 *
 * Known limitation: capture uses a white background, so charts viewed in dark
 * mode (light-on-dark text) export with reduced contrast. Export in light mode
 * for best fidelity.
 */
export async function captureCanvasChartPngs(): Promise<Map<number, string>> {
  const map = new Map<number, string>()
  const wrappers = Array.from(
    document.querySelectorAll<HTMLElement>('[data-type="chart-embed"][data-material-id]'),
  )
  if (wrappers.length === 0) return map

  await waitForChartsReady()

  try {
    const { toPng } = await import('html-to-image')
    const results = await Promise.allSettled(
      wrappers.map(async (w) => {
        const mid = Number(w.getAttribute('data-material-id'))
        if (!mid) return null
        // Prefer the clean chart subtree; only capture once it has actually rendered.
        //
        // ⚠️ #682: this used to require an `<svg>`, which quietly excluded every
        // TABLE-shaped qualitative chart — heatmap, summary table, co-occurrence
        // and comparison table render no SVG at all, so half of what #652 slabs
        // 1–2 shipped exported with no image and fell back to the data table
        // (losing, for instance, the heatmap's entire colour ramp). The Timeline
        // is the same shape. Accepting a rendered `<table>` does not reopen what
        // the gate was guarding: `waitForChartsReady` above is what keeps a
        // spinner from being rasterized, and a spinner contains neither element.
        const root = w.querySelector<HTMLElement>('[data-chart-capture-root]')
        if (!root || !root.querySelector('svg, table')) return null
        const dataUrl = await toPng(root, {
          pixelRatio: 2,
          skipFonts: true,
          backgroundColor: '#ffffff',
          cacheBust: true,
        })
        return { mid, dataUrl }
      }),
    )
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        map.set(r.value.mid, r.value.dataUrl)
      }
    }
  } catch {
    // html-to-image unavailable or blocked — fall back to tables only
  }
  return map
}

// ── Tiptap-to-HTML ───────────────────────────────────────────────────────────

/**
 * #1457 — escaped text whose line breaks stay line breaks (HTML collapses a bare `\n`).
 * ONE paragraph: for an attr that can hold blank lines use `htmlParagraphs`.
 */
function htmlLines(s: unknown): string {
  return esc(s).replace(/\r\n?|\n/g, '<br>')
}

/** Multi-line attr text (a quote, a memo preview) → `<p>` per blank-line paragraph (#1422). */
function htmlParagraphs(s: unknown): string {
  return String(s ?? '')
    .split(/(?:\r\n?|\n)[ \t]*(?:\r\n?|\n)/)
    .filter(p => p.trim() !== '')
    .map(p => `<p>${htmlLines(p.trim())}</p>`)
    .join('')
}

function renderTextWithMarksHtml(node: TiptapNode): string {
  let text = htmlLines(node.text)
  if (!node.marks) return text
  for (const mark of node.marks) {
    switch (mark.type) {
      case 'bold': text = `<strong>${text}</strong>`; break
      case 'italic': text = `<em>${text}</em>`; break
      case 'strike': text = `<s>${text}</s>`; break
      // StarterKit's Ctrl+U — the Word export keeps it as an underlined run (r1-9).
      case 'underline': text = `<u>${text}</u>`; break
      case 'link': {
        const href = exportableHref(mark.attrs?.href)
        if (href != null) text = `<a href="${esc(href)}">${text}</a>`
        break
      }
    }
  }
  return text
}

function nodeChildrenToHtml(node: TiptapNode, tables: ExportTables, chartPngs: Map<number, string>): string {
  if (!node.content) return ''
  return node.content.map(c => nodeToHtml(c, tables, chartPngs)).join('')
}

function nodeToHtml(node: TiptapNode, tables: ExportTables, chartPngs: Map<number, string>): string {
  const chartTables = tables.charts
  switch (node.type) {
    case 'text':
      return renderTextWithMarksHtml(node)

    // #1457 — Shift+Enter, and an @mention as the editor draws it.
    case 'hardBreak':
      return '<br>'

    case 'mention':
      return esc(mentionText(node))

    case 'paragraph':
      return `<p>${nodeChildrenToHtml(node, tables, chartPngs)}</p>\n`

    case 'heading': {
      const level = Math.min(((node.attrs?.level as number) ?? 3) + 2, 6)
      return `<h${level}>${nodeChildrenToHtml(node, tables, chartPngs)}</h${level}>\n`
    }

    case 'bulletList':
      return `<ul>\n${(node.content ?? []).map(li => `<li>${nodeChildrenToHtml(li, tables, chartPngs).trim()}</li>\n`).join('')}</ul>\n`

    case 'orderedList': {
      // r1-10 — a list typed from "3. " counts from 3, as on screen (`start` only when not 1).
      const start = listStart(node)
      return `<ol${start === 1 ? '' : ` start="${start}"`}>\n${(node.content ?? []).map(li => `<li>${nodeChildrenToHtml(li, tables, chartPngs).trim()}</li>\n`).join('')}</ol>\n`
    }

    case 'listItem':
      return nodeChildrenToHtml(node, tables, chartPngs)

    case 'blockquote':
      return `<blockquote>${nodeChildrenToHtml(node, tables, chartPngs)}</blockquote>\n`

    case 'horizontalRule':
      return '<hr>\n'

    case 'excerpt-embed': {
      // #1422 \u2014 a quote's paragraphs stay paragraphs (HTML ran them into one).
      const text = String((node.attrs?.displayText as string) ?? '').trim()
      const source = esc((node.attrs?.sourceContext as string) ?? '')
      const tag = (node.attrs?.materialTag as string) ?? ''
      return `<blockquote class="excerpt">${htmlParagraphs(`"${text}"`)}${source ? `<footer>\u2014 ${source}</footer>` : ''}${tag ? `<p class="tag">Tag: ${esc(tag)}</p>` : ''}</blockquote>\n`
    }

    case 'chart-embed': {
      const title = esc((node.attrs?.title as string) ?? 'Chart')
      const mid = node.attrs?.materialId as number
      const tag = (node.attrs?.materialTag as string) ?? ''
      const tableData = mid ? chartTables.get(mid) : undefined
      const pngDataUrl = mid ? chartPngs.get(mid) : undefined
      let html = `<div class="chart"><h4>${title}</h4>\n`
      if (pngDataUrl) {
        html += `<img src="${esc(pngDataUrl)}" alt="${title}" style="max-width:100%;margin-bottom:0.75rem" />\n`
      }
      html += tableData?.html ?? '<p><em>Chart data not available</em></p>'
      if (tag) html += `\n<p class="tag">Tag: ${esc(tag)}</p>`
      return html + '</div>\n'
    }

    case 'memo-embed': {
      const numId = esc(node.attrs?.numericId)
      const title = esc((node.attrs?.title as string) ?? '')
      const preview = (node.attrs?.preview as string) ?? ''
      const tag = (node.attrs?.materialTag as string) ?? ''
      return `<div class="memo"><strong>Memo M-${numId}${title ? `: ${title}` : ''}</strong>${preview ? htmlParagraphs(preview) : ''}${tag ? `<p class="tag">Tag: ${esc(tag)}</p>` : ''}</div>\n`
    }

    case 'callout-stat': {
      const value = esc((node.attrs?.value as string) ?? '')
      const label = esc((node.attrs?.label as string) ?? '')
      const source = esc((node.attrs?.sourceDescription as string) ?? '')
      const tag = (node.attrs?.materialTag as string) ?? ''
      return `<div class="callout"><span class="value">${value}</span> <span class="label">${label}</span>${source ? `<p class="source">${source}</p>` : ''}${tag ? `<p class="tag">Tag: ${esc(tag)}</p>` : ''}</div>\n`
    }

    case 'image-embed': {
      const alt = esc((node.attrs?.alt as string) ?? 'Image')
      const tag = (node.attrs?.materialTag as string) ?? ''
      return `<div class="image"><p><em>[Image: ${alt}]</em></p>${tag ? `<p class="tag">Tag: ${esc(tag)}</p>` : ''}</div>\n`
    }

    case JOINT_DISPLAY_NODE:
      return jointDisplayExport(node, tables, 'html')

    default:
      return nodeChildrenToHtml(node, tables, chartPngs)
  }
}

function tiptapToHtml(content: unknown, tables: ExportTables, chartPngs: Map<number, string>): string {
  if (!content) return ''
  const doc = typeof content === 'string' ? JSON.parse(content) : content
  if (!doc?.content) return ''
  return (doc.content as TiptapNode[]).map(n => nodeToHtml(n, tables, chartPngs)).join('')
}

// ── Full document assembly ───────────────────────────────────────────────────

function buildRelationshipsSummary(
  relationships: CanvasThemeRelationship[],
  themes: CanvasTheme[],
  format: 'md' | 'html',
): string {
  if (relationships.length === 0) return ''
  const themeNames = new Map(themes.map(t => [t.id, t.name]))

  if (format === 'md') {
    let md = '---\n\n## Relationships\n\n'
    for (const r of relationships) {
      // #1422 \u2014 names and labels are user text; `mdLines` guards the item's start (`- # x`
      // would be a heading inside the list).
      const src = mdLine(themeNames.get(r.source_theme_id) ?? 'Unknown')
      const tgt = mdLine(themeNames.get(r.target_theme_id) ?? 'Unknown')
      const type = r.relationship_type === 'custom' ? '' : mdWrap('**', mdLine(r.relationship_type))
      const label = r.label ? (type ? ` \u00b7 ${mdLine(r.label)}` : mdLine(r.label)) : ''
      const arrow = r.is_bidirectional ? '\u2194' : '\u2192'
      md += `- ${mdLines(`${src} ${arrow} ${tgt}${type || label ? `: ${type}${label}` : ''}`)}\n`
    }
    return md + '\n'
  }

  let html = '<hr>\n<h2>Relationships</h2>\n<ul>\n'
  for (const r of relationships) {
    const src = esc(themeNames.get(r.source_theme_id) ?? 'Unknown')
    const tgt = esc(themeNames.get(r.target_theme_id) ?? 'Unknown')
    const type = r.relationship_type === 'custom' ? '' : `<strong>${esc(r.relationship_type)}</strong>`
    const label = r.label ? (type ? ` \u00b7 ${esc(r.label)}` : esc(r.label)) : ''
    const arrow = r.is_bidirectional ? '\u2194' : '\u2192'
    html += `<li>${src} ${arrow} ${tgt}${type || label ? `: ${type}${label}` : ''}</li>\n`
  }
  return html + '</ul>\n'
}

function getAllRelationships(themes: CanvasTheme[]): CanvasThemeRelationship[] {
  const seen = new Set<number>()
  const rels: CanvasThemeRelationship[] = []
  for (const t of themes) {
    for (const r of (t.relationships_out ?? [])) {
      if (!seen.has(r.id)) { seen.add(r.id); rels.push(r) }
    }
  }
  return rels
}

/** Both table sets a canvas export renders against, fetched side by side. */
async function fetchExportTables(
  themes: CanvasTheme[],
  projectId: number,
  timelineLens: TimelineExportLens,
  coderName: CoderNameLookup,
): Promise<ExportTables> {
  const [charts, displays] = await Promise.all([
    fetchChartTables(themes, projectId, timelineLens),
    fetchDisplayReports(themes, projectId, timelineLens, coderName),
  ])
  return { charts, displays }
}

export async function exportCanvasMarkdown(
  canvas: CanvasDetail,
  themes: CanvasTheme[],
  projectId: number,
  timelineLens: TimelineExportLens,
  coderName: CoderNameLookup,
): Promise<string> {
  const tables = await fetchExportTables(themes, projectId, timelineLens, coderName)
  const relationships = getAllRelationships(themes)

  // #1422 — the names are user text: `_draft_` was emphasis, `<x>` vanished, a trailing ` #` was eaten.
  let md = `# ${mdHeading(mdLine(canvas.name))}\n\n`
  for (const theme of themes) {
    md += `## ${mdHeading(mdLine(theme.name))}\n\n`
    md += tiptapToMarkdown(theme.content, tables)
    if (md.length > 0 && !md.endsWith('\n\n')) md += '\n\n'
  }
  md += buildRelationshipsSummary(relationships, themes, 'md')
  return md.trim() + '\n'
}

const HTML_STYLES = `
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 800px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; line-height: 1.7; }
h1 { border-bottom: 2px solid #e5e7eb; padding-bottom: 0.5rem; }
h2 { margin-top: 2rem; color: #374151; }
blockquote.excerpt { border-left: 4px solid #10b981; padding: 0.75rem 1rem; margin: 1rem 0; background: #f0fdf4; }
blockquote.excerpt footer { font-style: italic; color: #6b7280; margin-top: 0.5rem; }
.chart { margin: 1.5rem 0; padding: 1rem; border: 1px solid #e5e7eb; border-radius: 0.5rem; }
.chart h4 { margin: 0 0 0.75rem; }
.memo { margin: 1rem 0; padding: 0.75rem 1rem; border-left: 4px solid #8b5cf6; background: #faf5ff; }
.callout { text-align: center; margin: 1.5rem 0; padding: 1rem; }
.callout .value { font-size: 2rem; font-weight: 700; }
.callout .label { color: #6b7280; }
.tag { font-size: 0.85rem; color: #6b7280; font-style: italic; }
.source { font-size: 0.85rem; color: #9ca3af; font-style: italic; }
table { border-collapse: collapse; width: 100%; margin: 0.5rem 0; font-size: 0.9rem; }
th, td { border: 1px solid #d1d5db; padding: 0.4rem 0.75rem; text-align: left; }
th { background: #f9fafb; font-weight: 600; }
.joint-display th[scope="row"] { background: transparent; }
.joint-display tr.beside td { background: #f6f6f6; }
.joint-display td, .joint-display th { vertical-align: top; }
.note { font-size: 0.85rem; color: #4b5563; }
hr { border: none; border-top: 1px solid #e5e7eb; margin: 2rem 0; }
ul { padding-left: 1.5rem; }
`.trim()

/** Build the inner HTML body (title + themes + relationships) shared by HTML + print exports. */
async function buildCanvasHtmlBody(
  canvas: CanvasDetail,
  themes: CanvasTheme[],
  projectId: number,
  chartPngs: Map<number, string>,
  timelineLens: TimelineExportLens,
  coderName: CoderNameLookup,
): Promise<string> {
  const tables = await fetchExportTables(themes, projectId, timelineLens, coderName)
  const relationships = getAllRelationships(themes)

  let body = `<h1>${esc(canvas.name)}</h1>\n`
  for (const theme of themes) {
    body += `<h2>${esc(theme.name)}</h2>\n`
    body += tiptapToHtml(theme.content, tables, chartPngs)
  }
  body += buildRelationshipsSummary(relationships, themes, 'html')
  return body
}

export async function exportCanvasHtml(
  canvas: CanvasDetail,
  themes: CanvasTheme[],
  projectId: number,
  preCapturedPngs: Map<number, string> | undefined,
  timelineLens: TimelineExportLens,
  coderName: CoderNameLookup,
): Promise<string> {
  const chartPngs = preCapturedPngs ?? await captureCanvasChartPngs()
  const body = await buildCanvasHtmlBody(canvas, themes, projectId, chartPngs, timelineLens, coderName)

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
${EXPORT_CSP_META}
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(canvas.name)}</title>
<style>${HTML_STYLES}</style>
</head>
<body>
${body}
</body>
</html>`
}

// ── PDF (client-side print of clean HTML) ──────────────────────────────────────

/**
 * Print CSS layered on top of HTML_STYLES for the print/PDF document. Gives
 * per-page margins, prevents charts/quotes/tables from splitting across page
 * boundaries, keeps headings with their content, and forces background colors
 * (excerpt/callout fills) to render in print.
 */
const PRINT_STYLES = `
@page { margin: 14mm; }
@media print {
  html, body { margin: 0; }
  body { max-width: none; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .chart, blockquote, .callout, .memo, table, img, figure { break-inside: avoid; page-break-inside: avoid; }
  h1, h2, h3, h4 { break-after: avoid; page-break-after: avoid; }
}
`.trim()

/**
 * Render a full HTML document into a hidden iframe and trigger the browser's
 * print dialog on THAT isolated document (not the live app). This fixes the
 * three window.print() defects (#369): no app chrome/toolbar, no deep-link URL
 * header, and no viewport clipping — the iframe document has no fixed-height
 * overflow chain. Works identically in the browser and Electron.
 */
async function printHtmlDocument(html: string): Promise<void> {
  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;'
  document.body.appendChild(iframe)

  const cleanup = () => {
    // Defer removal so the print dialog has fully detached from the iframe.
    setTimeout(() => iframe.remove(), 1000)
  }

  await new Promise<void>((resolve) => {
    iframe.onload = async () => {
      const win = iframe.contentWindow
      if (!win) { resolve(); return }
      // Wait for embedded chart images (data URLs) to decode before printing.
      try {
        const imgs = Array.from(iframe.contentDocument?.images ?? [])
        await Promise.all(imgs.map((img) => (img.complete ? Promise.resolve() : img.decode().catch(() => {}))))
      } catch { /* ignore decode errors — print whatever rendered */ }
      win.addEventListener('afterprint', () => { cleanup(); resolve() }, { once: true })
      win.focus()
      win.print()
      // Fallback: some environments never fire afterprint (or the user cancels).
      setTimeout(() => { cleanup(); resolve() }, 60_000)
    }
    iframe.srcdoc = html
  })
}

/**
 * Export the canvas as PDF by printing a clean, isolated HTML document. Captures
 * chart images first (reused so charts render in the PDF), builds the print HTML,
 * and opens the print dialog. The caller is responsible for any progress toast.
 */
export async function exportCanvasPdf(
  canvas: CanvasDetail,
  themes: CanvasTheme[],
  projectId: number,
  preCapturedPngs: Map<number, string> | undefined,
  timelineLens: TimelineExportLens,
  coderName: CoderNameLookup,
): Promise<void> {
  const chartPngs = preCapturedPngs ?? await captureCanvasChartPngs()
  const body = await buildCanvasHtmlBody(canvas, themes, projectId, chartPngs, timelineLens, coderName)

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
${EXPORT_CSP_META}
<title>${esc(canvas.name)}</title>
<style>${HTML_STYLES}
${PRINT_STYLES}</style>
</head>
<body>
${body}
</body>
</html>`

  await printHtmlDocument(html)
}
