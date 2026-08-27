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
  type CanvasDetail,
  type CanvasTheme,
  type CanvasThemeRelationship,
  type MetricDefinitionResponse,
  type SourceFrequenciesResponse,
  type GroupComparisonResponse,
  type AnalysisCrossTabResponse,
} from '@/lib/api'
import { safeFilename } from './filename'
import {
  computeTimedRows,
  coveredTotalSeconds,
  formatTimedRate,
  formatTimedSeconds,
  formatTimedShare,
  timedExtent,
} from '@/lib/timed-analytics'
import {
  resolveTimelineObservations,
  resolveTimelineCodes,
  resolveTimelineCoderLens,
} from '@/components/canvas/qual-timeline-params'
import {
  detectChartType,
  shapeScalarBars,
  shapeFrequencyBars,
  shapeHeatmapRows,
  shapeDumbbellRows,
  shapeLineChart,
  DISPLAY_PRECISION,
  type ChartType,
} from '@/lib/chart-data'
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
  isComparisonMaterialConfig,
  isCorrelationMaterialConfig,
  extractCrossTabParams,
  isCrossTabMaterialConfig,
  type QualComputeParams,
} from '@/components/canvas/inline-chart-params'
import { isQualitativeMaterialConfig } from '@/lib/material-kind'
import { describeUndefined } from '@/lib/stat-format'

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
 */
export interface TimelineExportLens {
  blind: boolean
  self: number | null
}

/** Fetch chart data for all chart-embeds and convert to tables. */
export async function fetchChartTables(
  themes: CanvasTheme[],
  projectId: number,
  timelineLens: TimelineExportLens = { blind: false, self: null },
): Promise<Map<number, { md: string; html: string }>> {
  const charts = collectChartEmbeds(themes)
  if (charts.length === 0) return new Map()

  const results = await Promise.allSettled(
    charts.map(async (chart) => {
      // #652 slab 1: a qualitative embed reads a different endpoint. Without
      // this branch `extractComputeParams` finds no columns or domains and the
      // chart exports as an EMPTY table in Markdown, HTML, PDF and the docx
      // fallback — so the export would silently lag the renderer.
      if (isQualitativeMaterialConfig(chart.config)) {
        const qualParams = extractQualComputeParams(chart.config)
        if (!qualChartHasEnoughToFetch(qualParams)) {
          return { materialId: chart.materialId, md: '', html: '' }
        }
        const table = await qualChartTable(projectId, qualParams, timelineLens)
        if (!table || table.rows.length === 0) return { materialId: chart.materialId, md: '', html: '' }
        return {
          materialId: chart.materialId,
          md: mdTable(table.headers, table.rows),
          html: htmlTable(table.headers, table.rows),
        }
      }

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
      if (isCorrelationMaterialConfig(chart.config)) {
        return { materialId: chart.materialId, md: '', html: '' }
      }

      if (isComparisonMaterialConfig(chart.config)) {
        const cmp = extractComparisonParams(chart.config)
        if (cmp.request == null) return { materialId: chart.materialId, md: '', html: '' }
        const data = await comparisonsApi.groupComparison(projectId, cmp.request)
        const table = comparisonExportTable(data)
        if (!table) return { materialId: chart.materialId, md: '', html: '' }
        return {
          materialId: chart.materialId,
          md: mdTable(table.headers, table.rows),
          html: htmlTable(table.headers, table.rows),
        }
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
      if (isCrossTabMaterialConfig(chart.config)) {
        const ct = extractCrossTabParams(chart.config)
        // A half-configured cross-tab has no row or no column axis. The
        // renderer says so on screen; an export emits nothing, exactly as it
        // does for every other unusable config.
        if (ct.request == null) return { materialId: chart.materialId, md: '', html: '' }
        const data = await metricsApi.crossTabulation(projectId, ct.request)
        const table = crossTabExportTable(data, ct.display, ct.scaleOrder)
        if (!table) return { materialId: chart.materialId, md: '', html: '' }
        return {
          materialId: chart.materialId,
          md: mdTable(table.headers, table.rows),
          html: htmlTable(table.headers, table.rows),
        }
      }

      const params = extractComputeParams(chart.config)
      if (params.columnIds.length === 0 && params.domainIds.length === 0) {
        return { materialId: chart.materialId, md: '', html: '' }
      }
      const request = buildRequest(params)
      const result = await metricsApi.quickCompute(projectId, request)
      const metrics = result.metrics ?? []
      if (metrics.length === 0) return { materialId: chart.materialId, md: '', html: '' }

      const chartType = (chart.config.chart_type as ChartType) ?? detectChartType(metrics)
      const metricType = params.metricType
      const md = metricsToMarkdownTable(metrics, chartType, metricType)
      const html = metricsToHtmlTable(metrics, chartType, metricType)
      return { materialId: chart.materialId, md, html }
    }),
  )

  const map = new Map<number, { md: string; html: string }>()
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.md) {
      map.set(r.value.materialId, { md: r.value.md, html: r.value.html })
    }
  }
  return map
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
/**
 * A group comparison as a plain table, for the Markdown and HTML exports (#817).
 *
 * ⚠️ **Mirrors what `GroupComparisonTable` renders, not what the payload
 * holds** — per group its n and mean, then the test and its p. A dump of every
 * field would not be the figure the researcher put on the page.
 *
 * ⚠️ **A row whose test did not run prints the REASON, never a blank cell.** A
 * blank is indistinguishable from a broken export (#566), and the reason is
 * already on the row.
 */
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

function comparisonExportTable(
  data: GroupComparisonResponse,
): { headers: string[]; rows: string[][] } | null {
  if (data.rows.length === 0) return null
  const headers = [
    'Variable',
    ...data.groups.flatMap(g => [`${g} n`, `${g} M`]),
    'Test',
    'p',
  ]
  const rows = data.rows.map(row => {
    const cells: string[] = [row.full_label || row.label]
    for (const g of data.groups) {
      const stat = row.group_stats.find(s => s.group === g)
      cells.push(stat ? String(stat.n) : '—')
      cells.push(stat?.mean != null ? stat.mean.toFixed(2) : '—')
    }
    if (row.test) {
      cells.push(`${row.test.test_type} = ${row.test.statistic.toFixed(3)}`)
      cells.push(row.test.p.toFixed(4))
    } else {
      cells.push(describeUndefined(row.test_omitted_reason) ?? 'Not computed')
      cells.push('—')
    }
    return cells
  })
  return { headers, rows }
}

async function qualChartTable(
  projectId: number,
  params: QualComputeParams,
  timelineLens: TimelineExportLens,
): Promise<{ headers: string[]; rows: string[][] } | null> {
  switch (qualChartKind(params)) {
    case 'timeline':
      return qualTimelineTable(projectId, params, timelineLens)

    case 'heatmap':
    case 'bar':
    case 'stacked_bar':
    case 'summary': {
      const data = await codeAnalysisApi.sourceFrequencies(projectId, params.request)
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
      }
    }

    case 'comparison_table':
    case 'comparison_bar': {
      const request = buildQualComparisonRequest(params)
      if (!request) return null
      const data = await codeAnalysisApi.demographicComparison(projectId, request)
      const groups = data.groups ?? []
      if (groups.length === 0) return null
      return {
        headers: ['Code', ...groups.map(g => `${g} n`), ...groups.map(g => `${g} %`)],
        rows: (data.codes ?? []).map(entry => [
          entry.code_name,
          ...groups.map(g => String(entry.by_group?.[g]?.count ?? 0)),
          ...groups.map(g => {
            const p = entry.by_group?.[g]?.proportion
            return p == null ? '' : `${(p * 100).toFixed(1)}%`
          }),
        ]),
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
  // Mirrors the embed's first gate: this chart reads the human coding layer.
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
  const { include } = resolveTimelineCoderLens(params.request.coder_ids ?? null, lens.blind, lens.self, false)
  const codeIds = codes.map(c => c.id)

  const clipsPerObservation = await Promise.all(
    observations.map(o => observationsApi.listSegments(projectId, o.id)),
  )

  const rows: string[][] = []
  observations.forEach((obs, i) => {
    const clips = clipsPerObservation[i] ?? []
    const { extent } = timedExtent(obs.media_duration_seconds, clips)
    const codeRows = computeTimedRows(clips, codeIds, include, extent)
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
    const covered = coveredTotalSeconds(clips, codeIds, include, extent)
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

function mdTable(headers: string[], rows: string[][]): string {
  const h = `| ${headers.join(' | ')} |`
  const sep = `| ${headers.map(() => '---').join(' | ')} |`
  const body = rows.map(r => `| ${r.join(' | ')} |`).join('\n')
  return `${h}\n${sep}\n${body}`
}

function htmlTable(headers: string[], rows: string[][]): string {
  const ths = headers.map(h => `<th>${esc(h)}</th>`).join('')
  const trs = rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('\n')
  return `<table>\n<thead><tr>${ths}</tr></thead>\n<tbody>\n${trs}\n</tbody>\n</table>`
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function metricsToMarkdownTable(
  metrics: MetricDefinitionResponse[],
  chartType: ChartType | null,
  metricType: string,
): string {
  return convertMetrics(metrics, chartType, metricType, 'md')
}

function metricsToHtmlTable(
  metrics: MetricDefinitionResponse[],
  chartType: ChartType | null,
  metricType: string,
): string {
  return convertMetrics(metrics, chartType, metricType, 'html')
}

function convertMetrics(
  metrics: MetricDefinitionResponse[],
  chartType: ChartType | null,
  metricType: string,
  format: 'md' | 'html',
): string {
  const table = format === 'md' ? mdTable : htmlTable

  try {
    if (metricType === 'frequency_distribution') {
      if (chartType === 'heatmap' || metrics.length > 1) {
        const data = shapeHeatmapRows(metrics)
        const headers = ['Variable', ...data.columnLabels, 'N']
        const rows = data.rows.map(r => [
          r.label,
          ...r.cells.map(c => c ? `${fmt(c.percentage)}%` : ''),
          String(r.totalN ?? ''),
        ])
        return table(headers, rows)
      }
      // Single frequency distribution
      const bars = shapeFrequencyBars(metrics[0])
      const headers = ['Response', '%', 'Count']
      const rows = bars.map(b => [b.label, `${fmt(b.value)}%`, String(b.count ?? '')])
      return table(headers, rows)
    }

    // Scalar metrics
    if (chartType === 'dumbbell') {
      const data = shapeDumbbellRows(metrics)
      const headers = ['Metric', ...data.groupValues.map(g => g ?? 'Overall'), 'N']
      const rows = data.rows.map(r => [
        r.label,
        ...r.dots.map(d => fmt(d.value)),
        String(r.dots[0]?.n ?? ''),
      ])
      return table(headers, rows)
    }

    if (chartType === 'line') {
      const data = shapeLineChart(metrics)
      if (data.series.length <= 1) {
        const headers = ['Metric', 'Value', 'N']
        const rows = (data.series[0]?.points ?? []).map(p => [
          p.label, fmt(p.value), String(p.n ?? ''),
        ])
        return table(headers, rows)
      }
      const headers = ['Metric', ...data.series.map(s => s.groupValue ?? 'Overall')]
      const points = data.series[0]?.points ?? []
      const rows = points.map((p, i) => [
        p.label,
        ...data.series.map(s => fmt(s.points[i]?.value)),
      ])
      return table(headers, rows)
    }

    // Default: scalar bars
    const bars = shapeScalarBars(metrics)
    const headers = ['Metric', 'Value', 'N']
    const rows = bars.map(b => [b.label, fmt(b.value), String(b.n ?? '')])
    return table(headers, rows)
  } catch {
    return format === 'md' ? '*[Chart data could not be converted to table]*' : '<p><em>Chart data could not be converted to table</em></p>'
  }
}

// ── Tiptap-to-Markdown ───────────────────────────────────────────────────────

function renderTextWithMarks(node: TiptapNode): string {
  let text = node.text ?? ''
  if (!node.marks) return text
  for (const mark of node.marks) {
    switch (mark.type) {
      case 'bold': text = `**${text}**`; break
      case 'italic': text = `*${text}*`; break
      case 'strike': text = `~~${text}~~`; break
      case 'link': text = `[${text}](${(mark.attrs?.href as string) ?? ''})`; break
    }
  }
  return text
}

function nodeChildrenToMd(node: TiptapNode, chartTables: Map<number, { md: string; html: string }>): string {
  if (!node.content) return ''
  return node.content.map(c => nodeToMd(c, chartTables)).join('')
}

function nodeToMd(node: TiptapNode, chartTables: Map<number, { md: string; html: string }>): string {
  switch (node.type) {
    case 'text':
      return renderTextWithMarks(node)

    case 'paragraph':
      return nodeChildrenToMd(node, chartTables) + '\n\n'

    case 'heading': {
      const level = (node.attrs?.level as number) ?? 3
      const prefix = '#'.repeat(Math.min(level + 2, 6)) // offset: themes are h2
      return `${prefix} ${nodeChildrenToMd(node, chartTables)}\n\n`
    }

    case 'bulletList':
      return (node.content ?? []).map(li => {
        const text = nodeChildrenToMd(li, chartTables).trim()
        return `- ${text}\n`
      }).join('') + '\n'

    case 'orderedList':
      return (node.content ?? []).map((li, i) => {
        const text = nodeChildrenToMd(li, chartTables).trim()
        return `${i + 1}. ${text}\n`
      }).join('') + '\n'

    case 'listItem':
      return nodeChildrenToMd(node, chartTables)

    case 'blockquote':
      return nodeChildrenToMd(node, chartTables).trim().split('\n').map(l => `> ${l}`).join('\n') + '\n\n'

    case 'horizontalRule':
      return '---\n\n'

    case 'excerpt-embed': {
      const text = (node.attrs?.displayText as string) ?? ''
      const source = (node.attrs?.sourceContext as string) ?? ''
      const tag = (node.attrs?.materialTag as string) ?? ''
      let md = `> "${text}"\n`
      if (source) md += `> *\u2014 ${source}*\n`
      if (tag) md += `> Tag: ${tag}\n`
      return md + '\n'
    }

    case 'chart-embed': {
      const title = (node.attrs?.title as string) ?? 'Chart'
      const mid = node.attrs?.materialId as number
      const tag = (node.attrs?.materialTag as string) ?? ''
      const tableData = mid ? chartTables.get(mid) : undefined
      let md = `**${title}**\n\n`
      if (tableData?.md) {
        md += tableData.md + '\n\n'
      } else {
        md += '*[Chart data not available as table]*\n\n'
      }
      if (tag) md += `Tag: ${tag}\n\n`
      return md
    }

    case 'memo-embed': {
      const numId = (node.attrs?.numericId as number) ?? ''
      const title = (node.attrs?.title as string) ?? ''
      const preview = (node.attrs?.preview as string) ?? ''
      const tag = (node.attrs?.materialTag as string) ?? ''
      let md = `**Memo M-${numId}${title ? `: ${title}` : ''}**\n\n`
      if (preview) md += `${preview}\n\n`
      if (tag) md += `Tag: ${tag}\n\n`
      return md
    }

    case 'callout-stat': {
      const value = (node.attrs?.value as string) ?? ''
      const label = (node.attrs?.label as string) ?? ''
      const source = (node.attrs?.sourceDescription as string) ?? ''
      const tag = (node.attrs?.materialTag as string) ?? ''
      let md = `**${value}** ${label}\n\n`
      if (source) md += `*Source: ${source}*\n\n`
      if (tag) md += `Tag: ${tag}\n\n`
      return md
    }

    case 'image-embed': {
      const alt = (node.attrs?.alt as string) ?? 'Image'
      const tag = (node.attrs?.materialTag as string) ?? ''
      let md = `*[Image: ${alt}]*\n\n`
      if (tag) md += `Tag: ${tag}\n\n`
      return md
    }

    default:
      // Unknown node — try to render children
      return nodeChildrenToMd(node, chartTables)
  }
}

function tiptapToMarkdown(content: unknown, chartTables: Map<number, { md: string; html: string }>): string {
  if (!content) return ''
  const doc = typeof content === 'string' ? JSON.parse(content) : content
  if (!doc?.content) return ''
  return (doc.content as TiptapNode[]).map(n => nodeToMd(n, chartTables)).join('').trim()
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

function renderTextWithMarksHtml(node: TiptapNode): string {
  let text = esc(node.text ?? '')
  if (!node.marks) return text
  for (const mark of node.marks) {
    switch (mark.type) {
      case 'bold': text = `<strong>${text}</strong>`; break
      case 'italic': text = `<em>${text}</em>`; break
      case 'strike': text = `<s>${text}</s>`; break
      case 'link': text = `<a href="${esc((mark.attrs?.href as string) ?? '')}">${text}</a>`; break
    }
  }
  return text
}

function nodeChildrenToHtml(node: TiptapNode, chartTables: Map<number, { md: string; html: string }>, chartPngs: Map<number, string>): string {
  if (!node.content) return ''
  return node.content.map(c => nodeToHtml(c, chartTables, chartPngs)).join('')
}

function nodeToHtml(node: TiptapNode, chartTables: Map<number, { md: string; html: string }>, chartPngs: Map<number, string>): string {
  switch (node.type) {
    case 'text':
      return renderTextWithMarksHtml(node)

    case 'paragraph':
      return `<p>${nodeChildrenToHtml(node, chartTables, chartPngs)}</p>\n`

    case 'heading': {
      const level = Math.min(((node.attrs?.level as number) ?? 3) + 2, 6)
      return `<h${level}>${nodeChildrenToHtml(node, chartTables, chartPngs)}</h${level}>\n`
    }

    case 'bulletList':
      return `<ul>\n${(node.content ?? []).map(li => `<li>${nodeChildrenToHtml(li, chartTables, chartPngs).trim()}</li>\n`).join('')}</ul>\n`

    case 'orderedList':
      return `<ol>\n${(node.content ?? []).map(li => `<li>${nodeChildrenToHtml(li, chartTables, chartPngs).trim()}</li>\n`).join('')}</ol>\n`

    case 'listItem':
      return nodeChildrenToHtml(node, chartTables, chartPngs)

    case 'blockquote':
      return `<blockquote>${nodeChildrenToHtml(node, chartTables, chartPngs)}</blockquote>\n`

    case 'horizontalRule':
      return '<hr>\n'

    case 'excerpt-embed': {
      const text = esc((node.attrs?.displayText as string) ?? '')
      const source = esc((node.attrs?.sourceContext as string) ?? '')
      const tag = (node.attrs?.materialTag as string) ?? ''
      return `<blockquote class="excerpt"><p>"${text}"</p>${source ? `<footer>\u2014 ${source}</footer>` : ''}${tag ? `<p class="tag">Tag: ${esc(tag)}</p>` : ''}</blockquote>\n`
    }

    case 'chart-embed': {
      const title = esc((node.attrs?.title as string) ?? 'Chart')
      const mid = node.attrs?.materialId as number
      const tag = (node.attrs?.materialTag as string) ?? ''
      const tableData = mid ? chartTables.get(mid) : undefined
      const pngDataUrl = mid ? chartPngs.get(mid) : undefined
      let html = `<div class="chart"><h4>${title}</h4>\n`
      if (pngDataUrl) {
        html += `<img src="${pngDataUrl}" alt="${title}" style="max-width:100%;margin-bottom:0.75rem" />\n`
      }
      html += tableData?.html ?? '<p><em>Chart data not available</em></p>'
      if (tag) html += `\n<p class="tag">Tag: ${esc(tag)}</p>`
      return html + '</div>\n'
    }

    case 'memo-embed': {
      const numId = (node.attrs?.numericId as number) ?? ''
      const title = esc((node.attrs?.title as string) ?? '')
      const preview = esc((node.attrs?.preview as string) ?? '')
      const tag = (node.attrs?.materialTag as string) ?? ''
      return `<div class="memo"><strong>Memo M-${numId}${title ? `: ${title}` : ''}</strong>${preview ? `<p>${preview}</p>` : ''}${tag ? `<p class="tag">Tag: ${esc(tag)}</p>` : ''}</div>\n`
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

    default:
      return nodeChildrenToHtml(node, chartTables, chartPngs)
  }
}

function tiptapToHtml(content: unknown, chartTables: Map<number, { md: string; html: string }>, chartPngs: Map<number, string>): string {
  if (!content) return ''
  const doc = typeof content === 'string' ? JSON.parse(content) : content
  if (!doc?.content) return ''
  return (doc.content as TiptapNode[]).map(n => nodeToHtml(n, chartTables, chartPngs)).join('')
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
      const src = themeNames.get(r.source_theme_id) ?? 'Unknown'
      const tgt = themeNames.get(r.target_theme_id) ?? 'Unknown'
      const type = r.relationship_type === 'custom' ? '' : `**${r.relationship_type}**`
      const label = r.label ? (type ? ` \u00b7 ${r.label}` : r.label) : ''
      const arrow = r.is_bidirectional ? '\u2194' : '\u2192'
      md += `- ${src} ${arrow} ${tgt}${type || label ? `: ${type}${label}` : ''}\n`
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

export async function exportCanvasMarkdown(
  canvas: CanvasDetail,
  themes: CanvasTheme[],
  projectId: number,
  timelineLens?: TimelineExportLens,
): Promise<string> {
  const chartTables = await fetchChartTables(themes, projectId, timelineLens)
  const relationships = getAllRelationships(themes)

  let md = `# ${canvas.name}\n\n`
  for (const theme of themes) {
    md += `## ${theme.name}\n\n`
    md += tiptapToMarkdown(theme.content, chartTables)
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
hr { border: none; border-top: 1px solid #e5e7eb; margin: 2rem 0; }
ul { padding-left: 1.5rem; }
`.trim()

/** Build the inner HTML body (title + themes + relationships) shared by HTML + print exports. */
async function buildCanvasHtmlBody(
  canvas: CanvasDetail,
  themes: CanvasTheme[],
  projectId: number,
  chartPngs: Map<number, string>,
  timelineLens?: TimelineExportLens,
): Promise<string> {
  const chartTables = await fetchChartTables(themes, projectId, timelineLens)
  const relationships = getAllRelationships(themes)

  let body = `<h1>${esc(canvas.name)}</h1>\n`
  for (const theme of themes) {
    body += `<h2>${esc(theme.name)}</h2>\n`
    body += tiptapToHtml(theme.content, chartTables, chartPngs)
  }
  body += buildRelationshipsSummary(relationships, themes, 'html')
  return body
}

export async function exportCanvasHtml(
  canvas: CanvasDetail,
  themes: CanvasTheme[],
  projectId: number,
  preCapturedPngs?: Map<number, string>,
  timelineLens?: TimelineExportLens,
): Promise<string> {
  const chartPngs = preCapturedPngs ?? await captureCanvasChartPngs()
  const body = await buildCanvasHtmlBody(canvas, themes, projectId, chartPngs, timelineLens)

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
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
  preCapturedPngs?: Map<number, string>,
  timelineLens?: TimelineExportLens,
): Promise<void> {
  const chartPngs = preCapturedPngs ?? await captureCanvasChartPngs()
  const body = await buildCanvasHtmlBody(canvas, themes, projectId, chartPngs, timelineLens)

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
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
