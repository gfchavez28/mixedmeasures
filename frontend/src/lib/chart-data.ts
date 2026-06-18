/**
 * Pure data transformation functions for chart rendering.
 * No React, no side effects — boundary between API data and chart components.
 */
import { getHslTextColor } from './utils'
import { metricDisplayLabel } from './metric-label'

import type {
  MetricDefinitionResponse,
  MetricDefinitionSummaryResponse,
  MetricType as MetricTypeFromApi,
  AnalysisDomainResponse,
} from './api'

/**
 * Opaque server JSON accessed via dynamic property names.
 * Used to narrow `Record<string, unknown>` at consumption boundaries.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonRecord = Record<string, any>


// ── Constants ──────────────────────────────────────────────────────────────────

export const GROUP_COMPARISON_COLORS = ['#7c3aed', '#ea580c', '#0891b2', '#be123c']

/** WCAG AA-safe (≥4.5:1 against white) darker variants of GROUP_COMPARISON_COLORS for text rendering. */
export const GROUP_TEXT_COLORS = ['#6d28d9', '#c2410c', '#0e7490', '#9f1239']

/** Canonical category color palette used for charts, domains, and code categories. */
export const CATEGORY_COLORS = [
  '#3b82f6', '#8b5cf6', '#ec4899', '#f97316', '#14b8a6', '#eab308',
  '#ef4444', '#22c55e', '#6366f1', '#06b6d4', '#f43f5e', '#a855f7',
  '#f59e0b', '#0ea5e9', '#84cc16', '#78716c',
]

/** Decimal places for displaying percentages and metric values in charts and tables. */
export const DISPLAY_PRECISION = 1

/** Shared chart theme colors used across DumbbellChart, HeatmapTable, and HorizontalBarChart. */
export const CHART_COLORS = {
  /** Grid lines */
  grid: '#e5e7eb',
  /** Axis lines and connecting lines */
  axis: '#d1d5db',
  /** Primary text (labels, ticks) */
  text: '#374151',
  /** Dark text (cell values, metric labels) */
  textDark: '#1a1a1a',
  /** Muted/secondary text (n counts, footnotes) */
  textMuted: '#6b7280',
  /** Reference lines and CI whiskers */
  reference: '#9ca3af',
  /** Line overlay stroke */
  lineOverlay: '#6b7280',
  /** Accent color for primary data series */
  accent: '#3b82f6',
} as const

/** Type for chart color palettes (light or dark). */
export type ChartColorPalette = Record<keyof typeof CHART_COLORS, string>

/** Dark-mode chart theme colors — same keys as CHART_COLORS. */
export const CHART_COLORS_DARK: ChartColorPalette = {
  grid: '#374151',
  axis: '#4b5563',
  text: '#d1d5db',
  textDark: '#f3f4f6',
  textMuted: '#9ca3af',
  reference: '#6b7280',
  lineOverlay: '#9ca3af',
  accent: '#60a5fa',
} as const

export type VariableNMode = 'off' | 'differing' | 'all'

// ── Chart formatting ─────────────────────────────────────────────────────────

/** Percentage of horizontal space allocated to the data (bars/cells). 'auto' sizes labels by content. */
export type DataWidthMode = 'auto' | '75%' | '50%' | '25%'

export type DataLabelPosition = 'outside' | 'inside' | 'none'

export interface ChartFormatting {
  labelFontSize: number
  axisFontSize: number
  titleFontSize: number
  dataLabelFontSize: number
  barSize: number
  colorPalette: string
  customColors: Record<string, string>
  heatmapPreset: string
  heatmapLabelFontSize: number
  pointSize: number
  referenceLine: number | null
  dataWidth: DataWidthMode
  dataLabels: DataLabelPosition
  xAxisMin: number | null
  xAxisMax: number | null
}

export const DEFAULT_FORMATTING: ChartFormatting = {
  labelFontSize: 12,
  axisFontSize: 12,
  titleFontSize: 16,
  dataLabelFontSize: 12,
  barSize: 24,
  colorPalette: 'default',
  customColors: {},
  heatmapPreset: 'green',
  heatmapLabelFontSize: 12,
  pointSize: 5,
  referenceLine: null,
  dataWidth: 'auto',
  dataLabels: 'outside',
  xAxisMin: null,
  xAxisMax: null,
}

/**
 * Compute the YAxis pixel width for a recharts chart given container width and dataWidth mode.
 * Returns undefined for 'auto' (let the chart compute its own width).
 */
export function computeYAxisWidth(
  containerWidth: number | undefined,
  dataWidth: DataWidthMode,
): number | undefined {
  if (dataWidth === 'auto' || !containerWidth || containerWidth <= 0) return undefined
  const dataRatio = parseInt(dataWidth) / 100 // 0.75, 0.50, or 0.25
  return Math.round(containerWidth * (1 - dataRatio))
}

/**
 * Split a label into multiple lines for SVG rendering, wrapping at word boundaries.
 * Returns array of line strings. If the label fits in maxChars, returns [label].
 */
export function wrapLabel(label: string, maxChars: number, maxLines = 2): string[] {
  if (!label || label.length <= maxChars) return [label || '']
  const words = label.split(/\s+/)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (current && (current.length + 1 + word.length) > maxChars) {
      lines.push(current)
      current = word
    } else {
      current = current ? `${current} ${word}` : word
    }
  }
  if (current) lines.push(current)
  // Cap at maxLines, truncate last line if needed
  if (lines.length > maxLines) {
    let last = lines[maxLines - 1]
    lines.length = maxLines
    if (last.length + 3 > maxChars) {
      last = last.slice(0, maxChars - 3)
    }
    lines[maxLines - 1] = last + '...'
  }
  return lines
}

export const COLOR_PALETTES: Record<string, string[]> = {
  default: CATEGORY_COLORS,
  likert5: ['#dc2626', '#f97316', '#9ca3af', '#4ade80', '#16a34a'],
  monochrome: ['#374151', '#6b7280', '#9ca3af', '#d1d5db', '#e5e7eb'],
  blue: ['#1e3a5f', '#2563eb', '#60a5fa', '#93c5fd', '#dbeafe'],
  warm: ['#991b1b', '#dc2626', '#f97316', '#facc15', '#fef08a'],
}

/** Merge a partial formatting override with defaults. Auto-derives dataLabelFontSize from axisFontSize when not explicitly set. */
export function mergeFormatting(partial?: Partial<ChartFormatting>): ChartFormatting {
  if (!partial) return DEFAULT_FORMATTING
  const merged = { ...DEFAULT_FORMATTING, ...partial }
  // Auto-derive dataLabelFontSize from axisFontSize unless caller explicitly set it
  if (partial.dataLabelFontSize == null && partial.axisFontSize != null) {
    merged.dataLabelFontSize = partial.axisFontSize
  }
  return merged
}

export const HEATMAP_PRESETS: Record<string, { hue: number; saturation: number }> = {
  green:  { hue: 142, saturation: 76 },
  blue:   { hue: 217, saturation: 91 },
  red:    { hue: 0,   saturation: 84 },
  purple: { hue: 270, saturation: 67 },
  amber:  { hue: 38,  saturation: 92 },
  diverging_blue_red: { hue: 0, saturation: 0 },  // Sentinel — use diverging logic in getCorrCellStyle()
}

export const HEATMAP_LABELS: Record<string, string> = {
  green: 'Green',
  blue: 'Blue',
  red: 'Red',
  purple: 'Purple',
  amber: 'Amber',
  diverging_blue_red: 'Diverging (Blue\u2013Red)',
}

export const PALETTE_LABELS: Record<string, string> = {
  default: 'Default',
  likert5: 'Likert (5-point)',
  monochrome: 'Monochrome',
  blue: 'Blue',
  warm: 'Warm',
}

/**
 * Diverging heatmap coloring for correlation matrices.
 * Maps r ∈ [-1, 1] to deep red → neutral → deep blue.
 * The neutral midpoint (r = 0) uses CSS variable --mm-bg for dark-mode adaptation.
 * Returns { backgroundColor, color } for direct use as inline styles.
 */
export function getDivergingCellStyle(
  r: number,
  isDark: boolean,
): { backgroundColor: string; color: string } {
  return getCorrCellStyle(r, isDark, 'diverging_blue_red')
}

/**
 * Correlation matrix cell coloring with preset support.
 * For 'diverging_blue_red': maps r ∈ [-1, 1] to red → neutral → blue.
 * For single-hue presets: maps |r| to intensity using the preset's hue/saturation.
 */
export function getCorrCellStyle(
  r: number,
  isDark: boolean,
  preset: string = 'diverging_blue_red',
): { backgroundColor: string; color: string } {
  const absR = Math.min(Math.abs(r), 1)

  if (absR < 0.02) {
    return { backgroundColor: 'transparent', color: isDark ? '#ffffff' : '#1a1a1a' }
  }

  if (preset === 'diverging_blue_red') {
    const hue = r >= 0 ? 220 : 0
    const saturation = 75
    const neutralL = isDark ? 16 : 96
    const deepL = isDark ? 30 : 36
    const L = neutralL - absR * (neutralL - deepL)
    return { backgroundColor: `hsl(${hue}, ${saturation}%, ${L}%)`, color: getHslTextColor(hue, saturation, L) }
  }

  // Single-hue preset: use |r| as intensity
  const { hue, saturation } = HEATMAP_PRESETS[preset] ?? HEATMAP_PRESETS.green
  const neutralL = isDark ? 16 : 96
  const deepL = isDark ? 30 : 36
  const L = neutralL - absR * (neutralL - deepL)
  return { backgroundColor: `hsl(${hue}, ${saturation}%, ${L}%)`, color: getHslTextColor(hue, saturation, L) }
}

export function resolveColorPalette(name: string): string[] {
  return COLOR_PALETTES[name] ?? COLOR_PALETTES.default
}

export function resolveHeatmapColors(preset: string): { hue: number; saturation: number } {
  return HEATMAP_PRESETS[preset] ?? HEATMAP_PRESETS.green
}

export function resolveChartColors(
  responseLabels: string[],
  paletteName: string,
  customColors: Record<string, string>,
): Record<string, string> {
  const palette = resolveColorPalette(paletteName)
  const result: Record<string, string> = {}
  responseLabels.forEach((label, i) => {
    result[label] = customColors[label] ?? palette[i % palette.length]
  })
  return result
}

export function resolveGroupColors(
  groupValues: string[],
  paletteName: string,
): Record<string, string> {
  const source = paletteName === 'default'
    ? GROUP_COMPARISON_COLORS
    : resolveColorPalette(paletteName)
  const colors: Record<string, string> = {}
  groupValues.forEach((gv, i) => {
    colors[gv] = source[i % source.length]
  })
  return colors
}

/** Resolve WCAG AA-safe text colors for group values (darker variants for text readability). */
export function resolveGroupTextColors(
  groupValues: string[],
  paletteName: string,
): Record<string, string> {
  const source = paletteName === 'default'
    ? GROUP_TEXT_COLORS
    : resolveColorPalette(paletteName)
  const colors: Record<string, string> = {}
  groupValues.forEach((gv, i) => {
    colors[gv] = source[i % source.length]
  })
  return colors
}

// ── Sort order ───────────────────────────────────────────────────────────────

export type SortOrder = 'desc' | 'asc' | 'none' | 'custom' | 'data_desc' | 'data_asc'

/**
 * Extract a single numeric sort value from a metric's computed results.
 * Prefers the ungrouped (null group_value) result; falls back to first result.
 * Returns null when no results are available.
 */
export function getMetricSortValue(m: MetricDefinitionResponse): number | null {
  if (!m.results || m.results.length === 0) return null
  const r = m.results.find(res => res.group_value === null) || m.results[0]
  const rd = r.result_data as JsonRecord
  if (rd.mean != null) return rd.mean
  if (rd.percentage != null) return rd.percentage
  if (rd.aggregate_value != null) return rd.aggregate_value
  // frequency_distribution: weighted average from percentages + scale_order
  const scaleOrder: string[] = rd.scale_order
  const percentages: Record<string, number> = rd.percentages
  if (scaleOrder && percentages) {
    let weightedSum = 0
    let totalPct = 0
    for (let i = 0; i < scaleOrder.length; i++) {
      const pct = percentages[scaleOrder[i]] ?? 0
      weightedSum += pct * (i + 1) // position-weighted: 1-indexed
      totalPct += pct
    }
    return totalPct > 0 ? weightedSum / totalPct : null
  }
  return null
}

/**
 * Extract a representative numeric value for a single group value across all metrics.
 * For each metric, finds the result matching groupValue, extracts its sort value
 * (same logic as getMetricSortValue), then averages across all metrics.
 */
export function getGroupSortValue(
  metrics: MetricDefinitionResponse[],
  groupValue: string,
): number | null {
  const values: number[] = []
  for (const m of metrics) {
    const r = m.results.find(res => res.group_value === groupValue)
    if (!r) continue
    const rd = r.result_data as JsonRecord
    if (rd.mean != null) { values.push(rd.mean); continue }
    if (rd.percentage != null) { values.push(rd.percentage); continue }
    if (rd.aggregate_value != null) { values.push(rd.aggregate_value); continue }
    // frequency_distribution: weighted average from percentages + scale_order
    const scaleOrder: string[] = rd.scale_order
    const percentages: Record<string, number> = rd.percentages
    if (scaleOrder && percentages) {
      let weightedSum = 0
      let totalPct = 0
      for (let i = 0; i < scaleOrder.length; i++) {
        const pct = percentages[scaleOrder[i]] ?? 0
        weightedSum += pct * (i + 1)
        totalPct += pct
      }
      if (totalPct > 0) values.push(weightedSum / totalPct)
    }
  }
  if (values.length === 0) return null
  return values.reduce((a, b) => a + b, 0) / values.length
}

/**
 * #406: numeric-aware label comparator — the frontend mirror of backend
 * `services/grouping.py::order_value_labels`. Labels that parse as finite
 * numbers sort numerically and come before non-numeric labels; non-numeric
 * labels compare via localeCompare. Keeps group-by axes and label sorts from
 * string-ordering numeric labels (1, 12, 15, 2, …).
 */
export function compareValueLabels(a: string, b: string): number {
  const na = Number(a)
  const nb = Number(b)
  const aNum = a.trim() !== '' && Number.isFinite(na)
  const bNum = b.trim() !== '' && Number.isFinite(nb)
  if (aNum && bNum) return na - nb
  if (aNum) return -1
  if (bNum) return 1
  return a.localeCompare(b)
}

/**
 * Sort group values based on the active sort order.
 * - 'none' / 'custom' → return as-is (default numeric-aware order from getGroupValues)
 * - 'asc' / 'desc' → label order via compareValueLabels (numeric-aware, #406)
 * - 'data_asc' / 'data_desc' → sort by getGroupSortValue(), nulls to end
 */
export function sortGroupValues(
  groupValues: string[],
  sortOrder: SortOrder,
  metrics: MetricDefinitionResponse[],
): string[] {
  if (sortOrder === 'none' || sortOrder === 'custom') return groupValues
  if (sortOrder === 'asc') return [...groupValues].sort(compareValueLabels)
  if (sortOrder === 'desc') return [...groupValues].sort((a, b) => compareValueLabels(b, a))
  // data_asc or data_desc
  const copy = [...groupValues]
  copy.sort((a, b) => {
    const aVal = getGroupSortValue(metrics, a)
    const bVal = getGroupSortValue(metrics, b)
    if (aVal == null && bVal == null) return 0
    if (aVal == null) return 1
    if (bVal == null) return -1
    return sortOrder === 'data_desc' ? bVal - aVal : aVal - bVal
  })
  return copy
}

/** Controls which text appears as the row label on charts. */
export type LabelMode = 'short' | 'full'

/** Controls row ordering when Group By is active on heatmaps/stacked bars. */
export type GroupOrganization = 'variable-first' | 'group-first'

// ── Chart option visibility ──────────────────────────────────────────────────

export type AxisTransform = 'linear' | 'log'

export interface VisibleOptions {
  sort: boolean
  display: boolean
  scaling: boolean
  scaleOrder: boolean
  groupBy: boolean
  groupFilter: boolean
  groupOrganization: boolean
  excludeValues: boolean
  hideFromChart: boolean
  showCI: boolean
  sampleSizes: boolean
  groupN: boolean
  referenceLine: boolean
  barSize: boolean
  heatmapColor: boolean
  colorPalette: boolean
  responseColors: boolean
  pointSize: boolean
  dataWidth: boolean
  proportionThreshold: boolean
  dataLabels: boolean
  dataLabelsInsideOnly: boolean
  axisRange: boolean
  divergingLayout: boolean
  errorBand: boolean
  lineStyle: boolean
  lineOverlay: boolean
  axisTransform: boolean
  crossTabColumn: boolean
  crossTabDisplay: boolean
}

export function getVisibleOptions(
  chartType: ChartType | null,
  metricType: string,
): VisibleOptions {
  const isFreq = metricType === 'frequency_distribution'
  const isCrossTab = chartType === 'cross_tab'
  const isScalarBar = (chartType === 'horizontal_bar' || chartType === 'vertical_bar') && !isFreq
  const isFreqBar = (chartType === 'horizontal_bar' || chartType === 'vertical_bar') && isFreq
  const isVerticalBar = chartType === 'vertical_bar'

  return {
    sort: !isCrossTab,
    display: (chartType === 'heatmap' || chartType === 'stacked_bar' || isFreqBar) && !isCrossTab,
    scaling: chartType === 'heatmap',
    scaleOrder: chartType === 'heatmap' || chartType === 'stacked_bar' || isFreqBar || chartType === 'frequency_table' || isCrossTab,
    groupBy: !isCrossTab,
    groupFilter: !isCrossTab,
    groupOrganization: chartType === 'heatmap' || chartType === 'stacked_bar',
    excludeValues: !isCrossTab,
    hideFromChart: (chartType === 'heatmap' || chartType === 'stacked_bar' || isFreqBar || chartType === 'frequency_table') && !isCrossTab,
    showCI: (isScalarBar || chartType === 'dumbbell' || chartType === 'table' || chartType === 'line') && !isCrossTab,
    sampleSizes: chartType !== 'table' && chartType !== 'frequency_table' && !isCrossTab,
    groupN: (chartType === 'dumbbell' || chartType === 'line') && !isCrossTab,
    referenceLine: (isScalarBar || chartType === 'dumbbell' || chartType === 'line') && !isCrossTab,
    barSize: (chartType === 'horizontal_bar' || chartType === 'stacked_bar' || isVerticalBar) && !isCrossTab,
    heatmapColor: chartType === 'heatmap' || isCrossTab,
    colorPalette: chartType !== 'heatmap' && chartType !== 'table' && chartType !== 'frequency_table' && !isCrossTab && chartType !== null,
    responseColors: (chartType === 'heatmap' || chartType === 'stacked_bar' || isFreqBar) && !isCrossTab,
    pointSize: (chartType === 'dumbbell' || chartType === 'line') && !isCrossTab,
    dataWidth: (chartType === 'horizontal_bar' || chartType === 'stacked_bar' || chartType === 'heatmap') && !isCrossTab,
    proportionThreshold: metricType === 'proportion' && !isCrossTab,
    dataLabels: (isScalarBar || isFreqBar || chartType === 'stacked_bar') && !isCrossTab,
    dataLabelsInsideOnly: chartType === 'stacked_bar',
    axisRange: (isScalarBar || chartType === 'dumbbell' || chartType === 'line') && !isCrossTab,
    divergingLayout: chartType === 'stacked_bar',
    errorBand: chartType === 'line',
    lineStyle: chartType === 'line',
    lineOverlay: chartType === 'horizontal_bar' && !isFreq,
    axisTransform: isScalarBar || chartType === 'dumbbell' || chartType === 'line',
    crossTabColumn: isCrossTab,
    crossTabDisplay: isCrossTab,
  }
}

// ── Chart type detection ───────────────────────────────────────────────────────

export type ChartType =
  | 'heatmap' | 'horizontal_bar' | 'stacked_bar' | 'vertical_bar'
  | 'dumbbell' | 'table' | 'line' | 'frequency_table' | 'cross_tab'

export type MetricType = MetricTypeFromApi

type MetricLike = Pick<MetricDefinitionResponse | MetricDefinitionSummaryResponse,
  'metric_type' | 'grouping_column_id'>

export function detectChartType(metrics: MetricLike[]): ChartType | null {
  if (metrics.length === 0) return null

  const allFreqDist = metrics.every(m => m.metric_type === 'frequency_distribution')
  if (allFreqDist) return 'heatmap'

  const allScalar = metrics.every(m =>
    m.metric_type === 'proportion' || m.metric_type === 'mean'
  )
  const allGrouped = metrics.every(m => m.grouping_column_id != null)
  if (allScalar && allGrouped) return 'dumbbell'

  const allUngrouped = metrics.every(m =>
    (m.metric_type === 'proportion' || m.metric_type === 'mean' || m.metric_type === 'domain_aggregate') &&
    m.grouping_column_id == null
  )
  if (allUngrouped) return 'horizontal_bar'

  return null
}

export function isMetricCompatible(
  candidate: MetricLike,
  currentSelection: MetricLike[],
): boolean {
  if (currentSelection.length === 0) return true

  const currentType = detectChartType(currentSelection)
  if (!currentType) return false

  switch (currentType) {
    case 'heatmap':
      return candidate.metric_type === 'frequency_distribution'
    case 'dumbbell':
      return (
        (candidate.metric_type === 'proportion' || candidate.metric_type === 'mean') &&
        candidate.grouping_column_id != null
      )
    case 'horizontal_bar':
      return (
        (candidate.metric_type === 'proportion' ||
          candidate.metric_type === 'mean' ||
          candidate.metric_type === 'domain_aggregate') &&
        candidate.grouping_column_id == null
      )
    default:
      return false
  }
}

// ── N computation types ───────────────────────────────────────────────────────

export interface ChartNInfo {
  chartN: number
  hasVaryingN: boolean
}

export interface DumbbellNInfo extends ChartNInfo {
  groupNs: Record<string, number>
  hasVaryingGroupN: Record<string, boolean>
}

// ── Data shaping types ─────────────────────────────────────────────────────────

export interface BarDatum {
  label: string
  fullLabel?: string
  value: number
  count?: number
  percentage?: number
  n?: number
  color?: string
  metricId?: number
  ciLower?: number
  ciUpper?: number
}

export interface HeatmapCell {
  count: number
  percentage: number
}

export interface HeatmapRow {
  label: string
  fullLabel?: string
  metricLabel?: string
  groupColor?: string
  metricId: number
  cells: (HeatmapCell | null)[]
  totalN: number
  groupLabel?: string
  isGroupEnd?: boolean
}

export interface HeatmapData {
  rows: HeatmapRow[]
  columnLabels: string[]
}

export interface DumbbellDot {
  groupValue: string
  value: number
  n: number
  ciLower?: number
  ciUpper?: number
}

export interface DumbbellRow {
  label: string
  fullLabel?: string
  metricId: number
  dots: DumbbellDot[]
}

export interface DumbbellData {
  rows: DumbbellRow[]
  groupValues: string[]
}

export interface GroupedFrequencySection {
  metricId: number
  metricName: string
  metricFullLabel?: string
  groups: { groupValue: string; bars: BarDatum[] }[]
}

export interface GroupedScalarSection {
  metricId: number
  metricName: string
  metricFullLabel?: string
  groups: { groupValue: string; value: number; n: number; ciLower?: number; ciUpper?: number }[]
}

/** Extract sorted unique group values from metrics (numeric-aware, #406). */
export function getGroupValues(metrics: MetricDefinitionResponse[]): string[] {
  const s = new Set<string>()
  for (const m of metrics) {
    for (const r of m.results) {
      if (r.group_value != null) s.add(r.group_value)
    }
  }
  return Array.from(s).sort(compareValueLabels)
}

/** Check if any metrics have grouped (multi-result) data. */
export function isGroupedMetrics(metrics: MetricDefinitionResponse[]): boolean {
  return metrics.some(m => m.results.length > 1 && m.results.some(r => r.group_value != null))
}

// ── Data shaping functions ─────────────────────────────────────────────────────

/** Build unified response/column labels from all results across metrics. */
export function buildUnifiedLabels(
  metrics: MetricDefinitionResponse[],
  options?: { hiddenLabels?: string[]; reverseScale?: boolean },
): string[] {
  const hidden = options?.hiddenLabels ? new Set(options.hiddenLabels) : null
  let labels: string[] = []
  const seen = new Set<string>()
  for (const m of metrics) {
    for (const r of m.results) {
      const scaleOrder: string[] = (r.result_data as JsonRecord).scale_order || []
      for (const label of scaleOrder) {
        if (!seen.has(label) && (!hidden || !hidden.has(label))) {
          seen.add(label)
          labels.push(label)
        }
      }
    }
  }
  if (options?.reverseScale) labels = [...labels].reverse()
  return labels
}

/**
 * Shape a single frequency_distribution metric into bar data.
 */
export function shapeFrequencyBars(
  metric: MetricDefinitionResponse,
  options?: { hiddenLabels?: string[]; reverseScale?: boolean },
): BarDatum[] {
  if (metric.results.length === 0) return []
  const result = metric.results[0]
  const rd = result.result_data as JsonRecord
  let scaleOrder: string[] = rd.scale_order || []
  const counts: Record<string, number> = rd.counts || {}
  const percentages: Record<string, number> = rd.percentages || {}

  const hidden = options?.hiddenLabels ? new Set(options.hiddenLabels) : null
  if (hidden) scaleOrder = scaleOrder.filter(l => !hidden.has(l))
  if (options?.reverseScale) scaleOrder = [...scaleOrder].reverse()

  return scaleOrder.map(label => ({
    label,
    value: percentages[label] ?? 0,
    count: counts[label] ?? 0,
    percentage: percentages[label] ?? 0,
    n: result.valid_n,
  }))
}

/**
 * Shape multiple ungrouped scalar metrics (proportion/mean/domain_aggregate) into bars.
 */
export function shapeScalarBars(
  metrics: MetricDefinitionResponse[],
  colorMap?: Map<number, string>,
  labelMap?: Map<number, string>,
): BarDatum[] {
  return metrics
    .filter(m => m.results.length > 0)
    .map(m => {
      const rd = m.results[0].result_data as JsonRecord
      const value = rd.percentage ?? rd.mean ?? rd.aggregate_value ?? 0
      const fullLabel = metricDisplayLabel(m)
      const displayLabel = labelMap?.get(m.id) ?? fullLabel
      return {
        label: displayLabel,
        fullLabel,
        value,
        count: rd.count ?? undefined,
        percentage: rd.percentage ?? undefined,
        n: m.results[0].valid_n,
        color: colorMap?.get(m.input_source_id),
        metricId: m.id,
        ciLower: rd.ci_lower ?? undefined,
        ciUpper: rd.ci_upper ?? undefined,
      }
    })
}

/**
 * Shape grouped scalar metrics (proportion/mean/domain_aggregate) into sections
 * for clustered bar rendering. Each metric becomes a section with bars per group value.
 */
export function shapeGroupedScalarBars(
  metrics: MetricDefinitionResponse[],
  groupValues: string[],
  labelMap?: Map<number, string>,
): GroupedScalarSection[] {
  return metrics
    .filter(m => m.results.length > 0)
    .map(m => {
      const fl = metricDisplayLabel(m)
      const dl = labelMap?.get(m.id) ?? fl
      const groups: GroupedScalarSection['groups'] = []
      for (const gv of groupValues) {
        const result = m.results.find(r => r.group_value === gv)
        if (!result) continue
        const rd = result.result_data as JsonRecord
        groups.push({
          groupValue: gv,
          value: rd.percentage ?? rd.mean ?? rd.aggregate_value ?? 0,
          n: result.valid_n,
          ciLower: rd.ci_lower ?? undefined,
          ciUpper: rd.ci_upper ?? undefined,
        })
      }
      return { metricId: m.id, metricName: dl, metricFullLabel: fl, groups }
    })
}

/**
 * Shape multiple frequency_distribution metrics into a heatmap table.
 * Unifies scale_order across all metrics. Supports grouped data.
 */
export function shapeHeatmapRows(
  metrics: MetricDefinitionResponse[],
  options?: { hiddenLabels?: string[]; reverseScale?: boolean; hiddenGroupValues?: string[]; groupOrganization?: GroupOrganization; sortOrder?: SortOrder; groupTextColors?: Record<string, string> },
  labelMap?: Map<number, string>,
): HeatmapData {
  const isGrouped = isGroupedMetrics(metrics)
  const columnLabels = buildUnifiedLabels(metrics, options)

  if (!isGrouped) {
    // Ungrouped path — original behavior
    const rows: HeatmapRow[] = metrics.map(m => {
      const fl = metricDisplayLabel(m)
      const dl = labelMap?.get(m.id) ?? fl
      if (m.results.length === 0) {
        return {
          label: dl,
          fullLabel: fl,
          metricId: m.id,
          cells: columnLabels.map(() => null),
          totalN: 0,
        }
      }

      const rd = m.results[0].result_data as JsonRecord
      const counts: Record<string, number> = rd.counts || {}
      const percentages: Record<string, number> = rd.percentages || {}
      const metricLabels = new Set<string>(rd.scale_order || [])

      return {
        label: dl,
        fullLabel: fl,
        metricId: m.id,
        cells: columnLabels.map(colLabel => {
          if (!metricLabels.has(colLabel)) return null
          return {
            count: counts[colLabel] ?? 0,
            percentage: percentages[colLabel] ?? 0,
          }
        }),
        totalN: m.results[0].valid_n,
      }
    })

    return { rows, columnLabels }
  }

  // Grouped path — expand each (metric, group_value) into a row
  const allGroupValues = getGroupValues(metrics)
  const filteredGroupValues = options?.hiddenGroupValues?.length
    ? allGroupValues.filter(gv => !options.hiddenGroupValues!.includes(gv))
    : allGroupValues
  const groupValues = options?.sortOrder
    ? sortGroupValues(filteredGroupValues, options.sortOrder, metrics)
    : filteredGroupValues
  const rows: HeatmapRow[] = []
  const organization = options?.groupOrganization || 'variable-first'

  const gtc = options?.groupTextColors

  const buildRow = (m: MetricDefinitionResponse, r: typeof m.results[0], isLast: boolean) => {
    const fl = metricDisplayLabel(m)
    const dl = labelMap?.get(m.id) ?? fl
    const rd = r.result_data as JsonRecord
    const counts: Record<string, number> = rd.counts || {}
    const percentages: Record<string, number> = rd.percentages || {}
    const metricLabels = new Set<string>(rd.scale_order || [])
    const label = organization === 'group-first'
      ? `${r.group_value}: ${dl}`
      : `${dl} (${r.group_value})`
    const fullLabel = organization === 'group-first'
      ? `${r.group_value}: ${fl}`
      : `${fl} (${r.group_value})`
    return {
      label,
      fullLabel,
      metricLabel: dl,
      groupColor: gtc?.[r.group_value!],
      metricId: m.id,
      cells: columnLabels.map(colLabel => {
        if (!metricLabels.has(colLabel)) return null
        return { count: counts[colLabel] ?? 0, percentage: percentages[colLabel] ?? 0 }
      }),
      totalN: r.valid_n,
      groupLabel: r.group_value!,
      isGroupEnd: isLast,
    }
  }

  if (organization === 'group-first') {
    for (const gv of groupValues) {
      const metricsWithGroup = metrics.filter(m =>
        m.results.some(r => r.group_value === gv)
      )
      metricsWithGroup.forEach((m, mi) => {
        const r = m.results.find(r => r.group_value === gv)
        if (!r) return
        rows.push(buildRow(m, r, mi === metricsWithGroup.length - 1))
      })
    }
  } else {
    for (const m of metrics) {
      const fl = metricDisplayLabel(m)
      const dl = labelMap?.get(m.id) ?? fl
      const groupedResults = m.results
        .filter(r => r.group_value != null && groupValues.includes(r.group_value))
        .sort((a, b) => groupValues.indexOf(a.group_value!) - groupValues.indexOf(b.group_value!))

      if (groupedResults.length === 0) {
        rows.push({
          label: dl,
          fullLabel: fl,
          metricId: m.id,
          cells: columnLabels.map(() => null),
          totalN: 0,
        })
        continue
      }

      groupedResults.forEach((r, gi) => {
        rows.push(buildRow(m, r, gi === groupedResults.length - 1))
      })
    }
  }

  return { rows, columnLabels }
}

/**
 * Shape a single frequency_distribution metric with grouped results into clustered bar sections.
 */
export function shapeGroupedFrequencyBars(
  metric: MetricDefinitionResponse,
  groupValues: string[],
  options?: { hiddenLabels?: string[]; reverseScale?: boolean },
  labelMap?: Map<number, string>,
): GroupedFrequencySection {
  const hidden = options?.hiddenLabels ? new Set(options.hiddenLabels) : null
  const groups: GroupedFrequencySection['groups'] = []

  for (const gv of groupValues) {
    const result = metric.results.find(r => r.group_value === gv)
    if (!result) {
      groups.push({ groupValue: gv, bars: [] })
      continue
    }
    const rd = result.result_data as JsonRecord
    let scaleOrder: string[] = rd.scale_order || []
    const counts: Record<string, number> = rd.counts || {}
    const percentages: Record<string, number> = rd.percentages || {}

    if (hidden) scaleOrder = scaleOrder.filter(l => !hidden.has(l))
    if (options?.reverseScale) scaleOrder = [...scaleOrder].reverse()

    groups.push({
      groupValue: gv,
      bars: scaleOrder.map(label => ({
        label,
        value: percentages[label] ?? 0,
        count: counts[label] ?? 0,
        percentage: percentages[label] ?? 0,
        n: result.valid_n,
      })),
    })
  }

  const fl = metricDisplayLabel(metric)
  const dl = labelMap?.get(metric.id) ?? fl
  return { metricId: metric.id, metricName: dl, metricFullLabel: fl, groups }
}

/**
 * Shape grouped proportion/mean metrics into dumbbell chart data.
 */
export function shapeDumbbellRows(
  metrics: MetricDefinitionResponse[],
  labelMap?: Map<number, string>,
  options?: { hiddenGroupValues?: string[]; sortOrder?: SortOrder },
): DumbbellData {
  // Collect all unique group values across metrics
  const groupSet = new Set<string>()
  for (const m of metrics) {
    for (const r of m.results) {
      if (r.group_value != null) groupSet.add(r.group_value)
    }
  }
  const allGroupValues = Array.from(groupSet).sort(compareValueLabels)
  const filteredGroupValues = options?.hiddenGroupValues?.length
    ? allGroupValues.filter(gv => !options.hiddenGroupValues!.includes(gv))
    : allGroupValues
  const groupValues = options?.sortOrder
    ? sortGroupValues(filteredGroupValues, options.sortOrder, metrics)
    : filteredGroupValues

  const rows: DumbbellRow[] = metrics.map(m => {
    const fl = metricDisplayLabel(m)
    const dl = labelMap?.get(m.id) ?? fl
    return {
      label: dl,
      fullLabel: fl,
      metricId: m.id,
      dots: m.results
        .filter(r => r.group_value != null && groupValues.includes(r.group_value))
        .map(r => {
          const d = r.result_data as JsonRecord
          return {
            groupValue: r.group_value!,
            value: d.percentage ?? d.mean ?? 0,
            n: r.valid_n,
            ciLower: d.ci_lower ?? undefined,
            ciUpper: d.ci_upper ?? undefined,
          }
        })
        .sort((a, b) => groupValues.indexOf(a.groupValue) - groupValues.indexOf(b.groupValue)),
    }
  })

  return { rows, groupValues }
}

/**
 * Build a map of columnId → domain hex color.
 * Maps each question member to its parent domain's color.
 */
export function buildColumnDomainColorMap(
  domains: AnalysisDomainResponse[],
): Map<number, string> {
  const colorMap = new Map<number, string>()

  for (const domain of domains) {
    if (!domain.color) continue
    // Map domain ID directly for domain_aggregate metrics (input_source_id = domain.id).
    // Domain IDs and column IDs are from different tables; overlap is safe because
    // shapeScalarBars only looks up m.input_source_id which is type-specific.
    colorMap.set(domain.id, domain.color)
    for (const member of domain.members) {
      if (member.member_type === 'column') {
        colorMap.set(member.member_id, domain.color)
      }
    }
  }

  return colorMap
}

// ── N computation functions ───────────────────────────────────────────────────

/** Compute chart-level N and whether it varies across bars. */
export function computeBarChartN(bars: BarDatum[]): ChartNInfo {
  const ns = bars.map(b => b.n).filter((n): n is number => n != null)
  if (ns.length === 0) return { chartN: 0, hasVaryingN: false }
  const chartN = Math.max(...ns)
  const hasVaryingN = ns.some(n => n !== chartN)
  return { chartN, hasVaryingN }
}

/** Compute chart-level N for per-question frequency bars (avoids shaping into heatmap). */
export function computeFreqBarChartN(metrics: MetricDefinitionResponse[]): ChartNInfo {
  const ns = metrics
    .flatMap(m => m.results)
    .filter(r => r.valid_n > 0)
    .map(r => r.valid_n)
  if (ns.length === 0) return { chartN: 0, hasVaryingN: false }
  const chartN = Math.max(...ns)
  const hasVaryingN = ns.some(n => n !== chartN)
  return { chartN, hasVaryingN }
}

/** Compute chart-level N for grouped scalar bar sections. */
export function computeGroupedScalarChartN(sections: GroupedScalarSection[]): ChartNInfo {
  const ns = sections.flatMap(s => s.groups.map(g => g.n)).filter(n => n > 0)
  if (ns.length === 0) return { chartN: 0, hasVaryingN: false }
  const chartN = Math.max(...ns)
  const hasVaryingN = ns.some(n => n !== chartN)
  return { chartN, hasVaryingN }
}

/** Compute chart-level N and whether it varies across heatmap rows. */
export function computeHeatmapChartN(data: HeatmapData): ChartNInfo {
  const ns = data.rows.map(r => r.totalN).filter(n => n > 0)
  if (ns.length === 0) return { chartN: 0, hasVaryingN: false }
  const chartN = Math.max(...ns)
  const hasVaryingN = ns.some(n => n !== chartN)
  return { chartN, hasVaryingN }
}

/** Compute chart-level N, per-group N, and whether each varies across dumbbell rows. */
export function computeDumbbellChartN(data: DumbbellData): DumbbellNInfo {
  const allNs: number[] = []
  const groupNsMap: Record<string, number[]> = {}

  for (const gv of data.groupValues) {
    groupNsMap[gv] = []
  }
  for (const row of data.rows) {
    for (const dot of row.dots) {
      allNs.push(dot.n)
      if (groupNsMap[dot.groupValue]) {
        groupNsMap[dot.groupValue].push(dot.n)
      }
    }
  }

  const chartN = allNs.length > 0 ? Math.max(...allNs) : 0
  const hasVaryingN = allNs.some(n => n !== chartN)

  const groupNs: Record<string, number> = {}
  const hasVaryingGroupN: Record<string, boolean> = {}
  for (const gv of data.groupValues) {
    const ns = groupNsMap[gv]
    if (ns.length === 0) {
      groupNs[gv] = 0
      hasVaryingGroupN[gv] = false
    } else {
      groupNs[gv] = Math.max(...ns)
      hasVaryingGroupN[gv] = ns.some(n => n !== groupNs[gv])
    }
  }

  return { chartN, hasVaryingN, groupNs, hasVaryingGroupN }
}

// ── Chart type applicability ────────────────────────────────────────────────

export interface ChartTypeInfo {
  available: ChartType[]
  default: ChartType
  /** null = compatible as-is, MetricType[] = must switch to one of these */
  requiresMetricTypeChange: Partial<Record<ChartType, MetricType[] | null>>
  /** Reason a chart type is shown but disabled (e.g., scale incompatibility) */
  disabledReasons: Partial<Record<ChartType, string>>
}

/**
 * Determine which chart types are available for a given metric type,
 * whether grouping is active, and how many items are selected.
 */
export function getApplicableChartTypes(
  currentMetricType: string,
  hasGrouping: boolean,
  itemCount: number,
  scaleCompatible: boolean = true,
): ChartTypeInfo {
  const available: ChartType[] = []
  const reqChange: Partial<Record<ChartType, MetricType[] | null>> = {}
  const disabledReasons: Partial<Record<ChartType, string>> = {}

  if (currentMetricType === 'frequency_distribution') {
    if (scaleCompatible) {
      available.push('heatmap', 'stacked_bar', 'horizontal_bar')
      reqChange.heatmap = null
      reqChange.stacked_bar = null
    } else {
      // Mixed scales: disable heatmap and stacked_bar but keep them visible
      available.push('horizontal_bar')
      disabledReasons.heatmap = 'Requires variables with the same response scale'
      disabledReasons.stacked_bar = 'Requires variables with the same response scale'
    }
    reqChange.horizontal_bar = null
    if (itemCount === 1) {
      available.push('vertical_bar')
      reqChange.vertical_bar = null
      available.push('cross_tab')
      reqChange.cross_tab = null
    }
    available.push('frequency_table')
    reqChange.frequency_table = null
    // table requires switching to scalar metric
    reqChange.table = ['mean', 'proportion']
    if (hasGrouping) {
      available.push('dumbbell')
      reqChange.dumbbell = ['mean', 'proportion']
    }
  } else {
    // scalar metrics: proportion, mean, domain_aggregate
    available.push('horizontal_bar')
    reqChange.horizontal_bar = null
    available.push('vertical_bar')
    reqChange.vertical_bar = null
    if (itemCount >= 2) {
      available.push('line')
      reqChange.line = null
    }
    if (hasGrouping) {
      available.push('dumbbell')
      reqChange.dumbbell = null
    }
    if (itemCount === 1) {
      available.push('cross_tab')
      reqChange.cross_tab = ['frequency_distribution']
    }
    available.push('table')
    reqChange.table = null
    available.push('frequency_table')
    reqChange.frequency_table = ['frequency_distribution']
    // heatmap + stacked_bar require freq_dist
    reqChange.heatmap = ['frequency_distribution']
    reqChange.stacked_bar = ['frequency_distribution']
  }

  // Default logic
  let defaultType: ChartType
  if (currentMetricType === 'frequency_distribution') {
    defaultType = (itemCount >= 2 && scaleCompatible) ? 'heatmap' : 'horizontal_bar'
  } else if (hasGrouping) {
    defaultType = 'dumbbell'
  } else {
    defaultType = 'horizontal_bar'
  }

  return { available, default: defaultType, requiresMetricTypeChange: reqChange, disabledReasons }
}

// ── Stacked bar data ────────────────────────────────────────────────────────

export interface StackedBarRow {
  label: string
  fullLabel?: string
  metricLabel?: string
  groupColor?: string
  metricId: number
  segments: { label: string; count: number; percentage: number }[]
  totalN: number
  groupLabel?: string
  isGroupEnd?: boolean
}

export interface StackedBarData {
  rows: StackedBarRow[]
  responseLabels: string[]
  colors: Record<string, string>
}

/**
 * Shape multiple frequency_distribution metrics into stacked bar data.
 * Unifies response labels across metrics (same logic as shapeHeatmapRows).
 * Supports grouped data.
 */
export function shapeStackedBars(
  metrics: MetricDefinitionResponse[],
  paletteName?: string,
  options?: { hiddenLabels?: string[]; reverseScale?: boolean; customColors?: Record<string, string>; hiddenGroupValues?: string[]; groupOrganization?: GroupOrganization; sortOrder?: SortOrder; groupTextColors?: Record<string, string> },
  labelMap?: Map<number, string>,
): StackedBarData {
  const isGrouped = isGroupedMetrics(metrics)
  const responseLabels = buildUnifiedLabels(metrics, options)

  // Assign colors from the selected palette (or default categorical)
  const palette = resolveColorPalette(paletteName || 'default')
  const colors: Record<string, string> = {}
  responseLabels.forEach((label, i) => {
    colors[label] = options?.customColors?.[label] ?? palette[i % palette.length]
  })

  if (!isGrouped) {
    // Ungrouped path — original behavior
    const rows: StackedBarRow[] = metrics.map(m => {
      const fl = metricDisplayLabel(m)
      const dl = labelMap?.get(m.id) ?? fl
      if (m.results.length === 0) {
        return {
          label: dl,
          fullLabel: fl,
          metricId: m.id,
          segments: responseLabels.map(l => ({ label: l, count: 0, percentage: 0 })),
          totalN: 0,
        }
      }
      const rd = m.results[0].result_data as JsonRecord
      const counts: Record<string, number> = rd.counts || {}
      const percentages: Record<string, number> = rd.percentages || {}
      return {
        label: dl,
        fullLabel: fl,
        metricId: m.id,
        segments: responseLabels.map(l => ({
          label: l,
          count: counts[l] ?? 0,
          percentage: percentages[l] ?? 0,
        })),
        totalN: m.results[0].valid_n,
      }
    })

    return { rows, responseLabels, colors }
  }

  // Grouped path — expand each (metric, group_value) into a row
  const allGroupValues = getGroupValues(metrics)
  const filteredGroupValues = options?.hiddenGroupValues?.length
    ? allGroupValues.filter(gv => !options.hiddenGroupValues!.includes(gv))
    : allGroupValues
  const groupValuesArr = options?.sortOrder
    ? sortGroupValues(filteredGroupValues, options.sortOrder, metrics)
    : filteredGroupValues
  const rows: StackedBarRow[] = []
  const organization = options?.groupOrganization || 'variable-first'
  const sgtc = options?.groupTextColors

  const buildRow = (m: MetricDefinitionResponse, r: typeof m.results[0], isLast: boolean) => {
    const fl = metricDisplayLabel(m)
    const dl = labelMap?.get(m.id) ?? fl
    const rd = r.result_data as JsonRecord
    const counts: Record<string, number> = rd.counts || {}
    const percentages: Record<string, number> = rd.percentages || {}
    const label = organization === 'group-first'
      ? `${r.group_value}: ${dl}`
      : `${dl} (${r.group_value})`
    const fullLabel = organization === 'group-first'
      ? `${r.group_value}: ${fl}`
      : `${fl} (${r.group_value})`
    return {
      label,
      fullLabel,
      metricLabel: dl,
      groupColor: sgtc?.[r.group_value!],
      metricId: m.id,
      segments: responseLabels.map(l => ({
        label: l,
        count: counts[l] ?? 0,
        percentage: percentages[l] ?? 0,
      })),
      totalN: r.valid_n,
      groupLabel: r.group_value!,
      isGroupEnd: isLast,
    }
  }

  if (organization === 'group-first') {
    for (const gv of groupValuesArr) {
      const metricsWithGroup = metrics.filter(m =>
        m.results.some(r => r.group_value === gv)
      )
      metricsWithGroup.forEach((m, mi) => {
        const r = m.results.find(r => r.group_value === gv)
        if (!r) return
        rows.push(buildRow(m, r, mi === metricsWithGroup.length - 1))
      })
    }
  } else {
    for (const m of metrics) {
      const fl = metricDisplayLabel(m)
      const dl = labelMap?.get(m.id) ?? fl
      const groupedResults = m.results
        .filter(r => r.group_value != null && groupValuesArr.includes(r.group_value))
        .sort((a, b) => groupValuesArr.indexOf(a.group_value!) - groupValuesArr.indexOf(b.group_value!))

      if (groupedResults.length === 0) {
        rows.push({
          label: dl,
          fullLabel: fl,
          metricId: m.id,
          segments: responseLabels.map(l => ({ label: l, count: 0, percentage: 0 })),
          totalN: 0,
        })
        continue
      }

      groupedResults.forEach((r, gi) => {
        rows.push(buildRow(m, r, gi === groupedResults.length - 1))
      })
    }
  }

  return { rows, responseLabels, colors }
}

/**
 * Compute chart-level N for stacked bar chart.
 * Note: reads from StackedBarData.rows produced by shapeStackedBars() — separator
 * rows for visual spacing are added in the chart component and don't appear here.
 */
export function computeStackedBarChartN(data: StackedBarData): ChartNInfo {
  const ns = data.rows.map(r => r.totalN).filter(n => n > 0)
  if (ns.length === 0) return { chartN: 0, hasVaryingN: false }
  const chartN = Math.max(...ns)
  const hasVaryingN = ns.some(n => n !== chartN)
  return { chartN, hasVaryingN }
}

// ── Summary statistics data ─────────────────────────────────────────────────

export interface SummaryStatsRow {
  label: string
  fullLabel?: string
  metricId: number
  n: number
  mean: number | null
  sd: number | null
  se: number | null
  min: number | null
  max: number | null
  median: number | null
  ciLower: number | null
  ciUpper: number | null
}

/**
 * Shape scalar metrics (mean/proportion/domain_aggregate) into summary statistics rows.
 */
export function shapeSummaryStats(
  metrics: MetricDefinitionResponse[],
  labelMap?: Map<number, string>,
  metricType?: string,
): SummaryStatsRow[] {
  return metrics
    .filter(m => m.results.length > 0)
    .map(m => {
      const rd = m.results[0].result_data as JsonRecord
      const fl = metricDisplayLabel(m)
      const dl = labelMap?.get(m.id) ?? fl
      const n = m.results[0].valid_n
      const mean = rd.mean ?? rd.aggregate_value ?? rd.percentage ?? null

      // Standard Error computation
      let se: number | null = null
      if (metricType === 'proportion' && rd.percentage != null && n > 0) {
        const p = rd.percentage / 100
        se = Math.sqrt(p * (1 - p) / n) * 100
      } else if ((metricType === 'mean' || metricType === 'domain_aggregate') && rd.std_dev != null && n > 0) {
        se = rd.std_dev / Math.sqrt(n)
      }

      return {
        label: dl,
        fullLabel: fl,
        metricId: m.id,
        n,
        mean,
        sd: rd.std_dev ?? null,
        se,
        min: rd.min ?? null,
        max: rd.max ?? null,
        median: rd.median ?? null,
        ciLower: rd.ci_lower ?? null,
        ciUpper: rd.ci_upper ?? null,
      }
    })
}

// ── Diverging stacked bar (Likert plot) ─────────────────────────────────────

export interface DivergingCenterResult {
  centerLabel: string | null
  mode: 'center' | 'boundary'
}

/**
 * Detect the center point for a diverging (Likert) stacked bar layout.
 * Odd scales: center label = middle item, mode = 'center' (split 50/50).
 * Even scales: center = null, mode = 'boundary' (split between middle items).
 * Fewer than 3 items → not applicable.
 */
export function detectDivergingCenter(responseLabels: string[]): DivergingCenterResult {
  if (responseLabels.length < 3) return { centerLabel: null, mode: 'boundary' }
  if (responseLabels.length % 2 === 1) {
    const midIndex = Math.floor(responseLabels.length / 2)
    return { centerLabel: responseLabels[midIndex], mode: 'center' }
  }
  return { centerLabel: null, mode: 'boundary' }
}

export interface DivergingSegment {
  label: string
  value: number  // signed: negative for left, positive for right, split for center
  absValue: number
  side: 'left' | 'center' | 'right'
  color: string
}

export interface DivergingBarRow {
  label: string
  fullLabel?: string
  metricLabel?: string
  groupColor?: string
  metricId: number
  totalN: number
  groupLabel?: string
  isGroupEnd?: boolean
  segments: Record<string, number>   // dataKey → signed value
  counts: Record<string, number>     // dataKey → unsigned count
  percentages: Record<string, number> // dataKey → unsigned percentage
}

export interface DivergingStackedBarData {
  rows: DivergingBarRow[]
  responseLabels: string[]  // full ordered list for legend
  leftLabels: string[]      // labels extending left (outside-in order)
  rightLabels: string[]     // labels extending right (inside-out order)
  centerLabel: string | null
  centerMode: 'center' | 'boundary'
  colors: Record<string, string>
  maxExtent: number         // symmetric domain limit
  hasMixedScales: boolean
}

/**
 * Transform standard StackedBarData into diverging layout data.
 * Left segments are negative values, right are positive, center (if any) is split 50/50.
 */
export function shapeDivergingStackedBars(
  data: StackedBarData,
  centerLabel: string | null,
  centerMode: 'center' | 'boundary',
  hasMixedScales: boolean,
): DivergingStackedBarData {
  const { rows, responseLabels, colors } = data

  // Find split point in the response labels
  let centerIndex = centerLabel ? responseLabels.indexOf(centerLabel) : -1
  if (centerMode === 'boundary') {
    // Even scale: split at midpoint
    centerIndex = Math.floor(responseLabels.length / 2) - 1  // labels 0..centerIndex are left
  }

  const leftLabels: string[] = []
  const rightLabels: string[] = []

  if (centerMode === 'center' && centerIndex >= 0) {
    // Odd: labels before center go left, after go right
    for (let i = 0; i < centerIndex; i++) leftLabels.push(responseLabels[i])
    for (let i = centerIndex + 1; i < responseLabels.length; i++) rightLabels.push(responseLabels[i])
  } else {
    // Even: labels 0..centerIndex go left, centerIndex+1..end go right
    for (let i = 0; i <= centerIndex; i++) leftLabels.push(responseLabels[i])
    for (let i = centerIndex + 1; i < responseLabels.length; i++) rightLabels.push(responseLabels[i])
  }

  // Reverse left labels so they stack outside-in (most negative outside)
  const leftLabelsReversed = [...leftLabels].reverse()

  let maxExtent = 0

  const divergingRows: DivergingBarRow[] = rows.map(row => {
    const segments: Record<string, number> = {}
    const counts: Record<string, number> = {}
    const percentages: Record<string, number> = {}

    // Left segments: negative values
    for (const label of leftLabelsReversed) {
      const seg = row.segments.find(s => s.label === label)
      const pct = seg?.percentage ?? 0
      segments[label] = -pct
      counts[label] = seg?.count ?? 0
      percentages[label] = pct
    }

    // Center segment: split 50/50
    if (centerLabel && centerMode === 'center') {
      const seg = row.segments.find(s => s.label === centerLabel)
      const pct = seg?.percentage ?? 0
      segments[`${centerLabel}_left`] = -(pct / 2)
      segments[`${centerLabel}_right`] = pct / 2
      counts[centerLabel] = seg?.count ?? 0
      percentages[centerLabel] = pct
    }

    // Right segments: positive values
    for (const label of rightLabels) {
      const seg = row.segments.find(s => s.label === label)
      const pct = seg?.percentage ?? 0
      segments[label] = pct
      counts[label] = seg?.count ?? 0
      percentages[label] = pct
    }

    // Compute extent for this row
    let leftSum = 0
    let rightSum = 0
    for (const label of leftLabelsReversed) leftSum += Math.abs(segments[label] ?? 0)
    if (centerLabel && centerMode === 'center') leftSum += Math.abs(segments[`${centerLabel}_left`] ?? 0)
    for (const label of rightLabels) rightSum += segments[label] ?? 0
    if (centerLabel && centerMode === 'center') rightSum += segments[`${centerLabel}_right`] ?? 0
    maxExtent = Math.max(maxExtent, leftSum, rightSum)

    return {
      label: row.label,
      fullLabel: row.fullLabel,
      metricLabel: row.metricLabel,
      groupColor: row.groupColor,
      metricId: row.metricId,
      totalN: row.totalN,
      groupLabel: row.groupLabel,
      isGroupEnd: row.isGroupEnd,
      segments,
      counts,
      percentages,
    }
  })

  // Round up maxExtent to nearest 10 for clean axis
  maxExtent = Math.ceil(maxExtent / 10) * 10
  if (maxExtent < 10) maxExtent = 10

  return {
    rows: divergingRows,
    responseLabels,
    leftLabels: leftLabelsReversed,
    rightLabels,
    centerLabel: centerMode === 'center' ? centerLabel : null,
    centerMode,
    colors,
    maxExtent,
    hasMixedScales,
  }
}

// ── Line chart data ─────────────────────────────────────────────────────────

export const LINE_DASH_PATTERNS = [undefined, '5 3', '2 4', '8 3 2 3'] as const

export interface LineChartPoint {
  label: string
  fullLabel?: string
  metricId: number
  value: number
  n: number
  ciLower?: number
  ciUpper?: number
  ciRange?: [number, number]
  color?: string
}

export interface LineChartSeries {
  groupValue: string | null  // null = ungrouped
  points: LineChartPoint[]
}

export interface LineChartData {
  series: LineChartSeries[]
  xLabels: string[]
}

/**
 * Shape scalar metrics into line chart data.
 * Ungrouped: single series. Grouped: one series per group value.
 */
export function shapeLineChart(
  metrics: MetricDefinitionResponse[],
  colorMap?: Map<number, string>,
  labelMap?: Map<number, string>,
  options?: { hiddenGroupValues?: string[]; sortOrder?: SortOrder },
): LineChartData {
  const xLabels = metrics.map(m => labelMap?.get(m.id) ?? metricDisplayLabel(m))
  const grouped = isGroupedMetrics(metrics)

  if (!grouped) {
    const points: LineChartPoint[] = metrics
      .filter(m => m.results.length > 0)
      .map(m => {
        const r = m.results[0]
        const rd = r.result_data as JsonRecord
        const value = rd.percentage ?? rd.mean ?? rd.aggregate_value ?? 0
        const fl = metricDisplayLabel(m)
        const dl = labelMap?.get(m.id) ?? fl
        return {
          label: dl,
          fullLabel: fl,
          metricId: m.id,
          value,
          n: r.valid_n,
          ciLower: rd.ci_lower ?? undefined,
          ciUpper: rd.ci_upper ?? undefined,
          ciRange: rd.ci_lower != null && rd.ci_upper != null
            ? [rd.ci_lower, rd.ci_upper] as [number, number]
            : undefined,
          color: colorMap?.get(m.input_source_id),
        }
      })
    return { series: [{ groupValue: null, points }], xLabels }
  }

  // Grouped: one series per group value
  const allGroupVals = getGroupValues(metrics)
  const hidden = options?.hiddenGroupValues ? new Set(options.hiddenGroupValues) : null
  const filtered = hidden ? allGroupVals.filter(gv => !hidden.has(gv)) : allGroupVals
  const groupVals = options?.sortOrder
    ? sortGroupValues(filtered, options.sortOrder, metrics)
    : filtered

  const series: LineChartSeries[] = groupVals.map(gv => {
    const points: LineChartPoint[] = metrics.map(m => {
      const r = m.results.find(res => res.group_value === gv)
      const fl = metricDisplayLabel(m)
      const dl = labelMap?.get(m.id) ?? fl
      if (!r) return { label: dl, fullLabel: fl, metricId: m.id, value: 0, n: 0 }
      const rd = r.result_data as JsonRecord
      return {
        label: dl,
        fullLabel: fl,
        metricId: m.id,
        value: rd.percentage ?? rd.mean ?? rd.aggregate_value ?? 0,
        n: r.valid_n,
        ciLower: rd.ci_lower ?? undefined,
        ciUpper: rd.ci_upper ?? undefined,
        ciRange: rd.ci_lower != null && rd.ci_upper != null
          ? [rd.ci_lower, rd.ci_upper] as [number, number]
          : undefined,
      }
    })
    return { groupValue: gv, points }
  })

  return { series, xLabels }
}

/** Compute chart-level N for line chart. */
export function computeLineChartN(data: LineChartData): DumbbellNInfo {
  const allNs: number[] = []
  const groupNsMap: Record<string, number[]> = {}

  for (const s of data.series) {
    const key = s.groupValue ?? '_ungrouped'
    if (!groupNsMap[key]) groupNsMap[key] = []
    for (const p of s.points) {
      if (p.n > 0) {
        allNs.push(p.n)
        groupNsMap[key].push(p.n)
      }
    }
  }

  const chartN = allNs.length > 0 ? Math.max(...allNs) : 0
  const hasVaryingN = allNs.some(n => n !== chartN)

  const groupNs: Record<string, number> = {}
  const hasVaryingGroupN: Record<string, boolean> = {}
  for (const [key, ns] of Object.entries(groupNsMap)) {
    if (ns.length === 0) {
      groupNs[key] = 0
      hasVaryingGroupN[key] = false
    } else {
      groupNs[key] = Math.max(...ns)
      hasVaryingGroupN[key] = ns.some(n => n !== groupNs[key])
    }
  }

  return { chartN, hasVaryingN, groupNs, hasVaryingGroupN }
}

// ── Frequency table data ────────────────────────────────────────────────────

export interface FrequencyTableRow {
  label: string
  count: number
  percent: number
  validPercent: number
  cumulativeCount: number
  cumulativeValidPercent: number
}

export interface FrequencyTableMetric {
  label: string
  fullLabel?: string
  metricId: number
  groupValue?: string
  totalValid: number
  totalMissing: number
  totalAll: number
  rows: FrequencyTableRow[]
}

/**
 * Shape frequency_distribution metrics into SPSS-style frequency table data.
 */
export function shapeFrequencyTable(
  metrics: MetricDefinitionResponse[],
  labelMap?: Map<number, string>,
  options?: { reverseScale?: boolean; hiddenLabels?: string[]; groupValue?: string },
): FrequencyTableMetric[] {
  const hidden = options?.hiddenLabels ? new Set(options.hiddenLabels) : null

  const results: FrequencyTableMetric[] = []
  for (const m of metrics) {
    if (m.results.length === 0) continue
    const fl = metricDisplayLabel(m)
    const dl = labelMap?.get(m.id) ?? fl

    // Find the matching result (for grouped data)
    const result = options?.groupValue
      ? m.results.find(r => r.group_value === options.groupValue)
      : m.results.find(r => r.group_value == null) || m.results[0]
    if (!result) continue

    const rd = result.result_data as JsonRecord
    let scaleOrder: string[] = rd.scale_order || []
    const counts: Record<string, number> = rd.counts || {}

    // Subtract hidden label counts from totals so percentages sum to 100%
    const hiddenCount = hidden
      ? scaleOrder.filter(l => hidden.has(l)).reduce((sum, l) => sum + (counts[l] ?? 0), 0)
      : 0

    if (hidden) scaleOrder = scaleOrder.filter(l => !hidden.has(l))
    if (options?.reverseScale) scaleOrder = [...scaleOrder].reverse()

    const rawValidN: number = result.valid_n
    const rawTotalN: number = rd.total_n ?? rawValidN
    const validN = rawValidN - hiddenCount
    const totalN = rawTotalN - hiddenCount
    const missingN = rawTotalN - rawValidN

    // Compute rows with cumulative sums
    let cumCount = 0
    let cumValidPct = 0

    const rows: FrequencyTableRow[] = scaleOrder.map(label => {
      const count = counts[label] ?? 0
      const pct = totalN > 0 ? (count / totalN) * 100 : 0
      const validPct = validN > 0 ? (count / validN) * 100 : 0
      cumCount += count
      cumValidPct += validPct
      return {
        label,
        count,
        percent: pct,
        validPercent: validPct,
        cumulativeCount: cumCount,
        cumulativeValidPercent: cumValidPct,
      }
    })

    results.push({
      label: dl,
      fullLabel: fl,
      metricId: m.id,
      groupValue: options?.groupValue,
      totalValid: validN,
      totalMissing: missingN,
      totalAll: totalN,
      rows,
    })
  }
  return results
}

// ── Log axis utilities ──────────────────────────────────────────────────────

/**
 * Compute a safe domain for log-scale rendering.
 * Finds the smallest positive value and rounds down to the nearest power of 10.
 * Returns [minPositive, maxValue] or null if no positive data.
 */
export function computeLogDomain(values: number[]): [number, number] | null {
  const positives = values.filter(v => v > 0)
  if (positives.length === 0) return null
  const minVal = Math.min(...positives)
  const maxVal = Math.max(...positives)
  // Round min down to nearest power of 10
  const minLog = Math.pow(10, Math.floor(Math.log10(minVal)))
  // Round max up to nearest power of 10
  const maxLog = Math.pow(10, Math.ceil(Math.log10(maxVal)))
  return [minLog, Math.max(maxLog, minLog * 10)]
}

// ── Shared formatting utilities ──────────────────────────────────────────────

/** Format p-value: <.001 or leading-zero stripped 3-decimal. */
export function formatP(p: number): string {
  if (p < 0.001) return '<.001'
  const s = p.toFixed(3)
  return s.startsWith('0.') ? s.slice(1) : s
}

/**
 * Full APA inline p-value string WITH the comparison operator, for tooltips and
 * inline strips that read "p ...". Use this anywhere you'd otherwise write
 * `p = ${formatP(p)}` — that produced the malformed `p = <.001` (#429). Table
 * CELLS under a "p" column header keep bare `formatP` (the header supplies "p").
 */
export function formatPValue(p: number): string {
  return p < 0.001 ? 'p < .001' : `p = ${formatP(p)}`
}

/** Return significance star string based on enabled levels. */
export function getSignificanceStars(
  p: number,
  levels: { show_05: boolean; show_01: boolean; show_001: boolean },
): string {
  if (levels.show_001 && p < 0.001) return '***'
  if (levels.show_01 && p < 0.01) return '**'
  if (levels.show_05 && p < 0.05) return '*'
  return ''
}

/** Deterministic jitter offset from row ID. */
export function jitterOffset(rowId: number): number {
  const hash = ((rowId * 2654435761) & 0xFFFFFFFF) >>> 0
  return (hash / 0xFFFFFFFF) * 0.3 - 0.15
}

// ── Comparison data shapers ─────────────────────────────────────────────────

/**
 * Shape GroupComparisonResponse rows into DumbbellData for the DumbbellChart.
 */
export function shapeComparisonDumbbell(
  rows: { label: string; full_label: string; source_id: number; group_stats: { group: string; mean: number; n: number; ci_lower: number | null; ci_upper: number | null }[] }[],
  groups: string[],
): DumbbellData {
  return {
    groupValues: groups,
    rows: rows.map(row => ({
      label: row.label,
      fullLabel: row.full_label,
      metricId: row.source_id,
      dots: row.group_stats
        .filter(gs => groups.includes(gs.group) && gs.n > 0)
        .map(gs => ({
          groupValue: gs.group,
          value: gs.mean,
          n: gs.n,
          ciLower: gs.ci_lower ?? gs.mean,
          ciUpper: gs.ci_upper ?? gs.mean,
        })),
    })),
  }
}

/**
 * Shape GroupComparisonResponse rows into GroupedScalarSection[] for GroupedScalarBarChart.
 */
export function shapeComparisonGroupedBars(
  rows: { label: string; full_label: string; source_id: number; group_stats: { group: string; mean: number; n: number; ci_lower: number | null; ci_upper: number | null }[] }[],
  groups: string[],
): GroupedScalarSection[] {
  return rows.map(row => ({
    metricId: row.source_id,
    metricName: row.label,
    metricFullLabel: row.full_label,
    groups: row.group_stats
      .filter(gs => groups.includes(gs.group) && gs.n > 0)
      .map(gs => ({
        groupValue: gs.group,
        value: gs.mean,
        n: gs.n,
        ciLower: gs.ci_lower ?? gs.mean,
        ciUpper: gs.ci_upper ?? gs.mean,
      })),
  }))
}
