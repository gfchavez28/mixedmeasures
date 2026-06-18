import type {
  SourceFrequenciesResponse,
  SourceEntry,
} from '@/lib/api'
import type {
  QualValueMode,
  QualDenominatorMode,
  QualOrientation,
  QualSortOrder,
} from '@/lib/qual-analysis-types'
import { getCodeColor } from '@/lib/utils'

/** Shared color palette for multi-series qualitative charts (stacked bars, grouped bars). */
export const QUAL_GROUP_COLORS = [
  '#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6',
  '#ec4899', '#06b6d4', '#f97316', '#14b8a6', '#6366f1',
]

// ── Cell value computation ──────────────────────────────────────────────────

export function computeCellValue(
  rawCount: number,
  codedWordCount: number,
  sourceTotalSegments: number,
  sourceTotalWordCount: number,
  sourceCodedSegments: number,
  valueMode: QualValueMode,
  denominatorMode: QualDenominatorMode,
): number {
  switch (valueMode) {
    case 'count':
      return rawCount
    case 'segment_proportion': {
      const denom = denominatorMode === 'coded' ? sourceCodedSegments : sourceTotalSegments
      return denom > 0 ? rawCount / denom : 0
    }
    case 'text_coverage':
      return sourceTotalWordCount > 0 ? codedWordCount / sourceTotalWordCount : 0
  }
}

// ── Heatmap ─────────────────────────────────────────────────────────────────

export interface QualHeatmapCell {
  displayValue: number
  rawCount: number
  wordCount: number
  columnId: number
  columnLabel: string
}

export interface QualHeatmapRow {
  label: string
  id: number
  sourceType: 'conversation' | 'text_column' | 'document' | 'code'
  cells: QualHeatmapCell[]
  totalN: number
}

export interface QualHeatmapData {
  rows: QualHeatmapRow[]
  columnLabels: string[]
  columnIds: number[]
  maxValue: number
}

function sortSources(sources: SourceEntry[], sortOrder: QualSortOrder): SourceEntry[] {
  const sorted = [...sources]
  switch (sortOrder) {
    case 'alpha':
      sorted.sort((a, b) => a.source_label.localeCompare(b.source_label))
      break
    case 'count_desc':
      sorted.sort((a, b) => b.total_segments - a.total_segments)
      break
    case 'count_asc':
      sorted.sort((a, b) => a.total_segments - b.total_segments)
      break
    case 'import':
    default:
      // Conversations first (by import_order), then comment columns
      sorted.sort((a, b) => {
        if (a.source_type !== b.source_type) {
          return a.source_type === 'conversation' ? -1 : 1
        }
        return (a.import_order ?? 0) - (b.import_order ?? 0)
      })
      break
  }
  return sorted
}

export function shapeQualHeatmapData(
  response: SourceFrequenciesResponse,
  valueMode: QualValueMode,
  denominatorMode: QualDenominatorMode,
  orientation: QualOrientation,
  sortOrder: QualSortOrder,
): QualHeatmapData {
  const { codes, sources } = response
  const sortedSources = sortSources(sources, sortOrder)

  if (orientation === 'sources-rows') {
    // Sources as rows, codes as columns
    let maxValue = 0
    const rows: QualHeatmapRow[] = sortedSources.map(src => {
      const cells: QualHeatmapCell[] = codes.map(code => {
        const entry = src.code_counts?.[String(code.id)]
        const rawCount = entry?.count ?? 0
        const wordCount = entry?.word_count ?? 0
        const displayValue = computeCellValue(
          rawCount, wordCount,
          src.total_segments, src.total_word_count, src.coded_segments,
          valueMode, denominatorMode,
        )
        if (displayValue > maxValue) maxValue = displayValue
        return { displayValue, rawCount, wordCount, columnId: code.id, columnLabel: code.name }
      })
      const totalN = cells.reduce((sum, c) => sum + c.rawCount, 0)
      return {
        label: src.source_label,
        id: src.source_id,
        sourceType: src.source_type,
        cells,
        totalN,
      }
    })
    return {
      rows,
      columnLabels: codes.map(c => c.name),
      columnIds: codes.map(c => c.id),
      maxValue,
    }
  }

  // codes-rows: Codes as rows, sources as columns
  let maxValue = 0
  const rows: QualHeatmapRow[] = codes.map(code => {
    const cells: QualHeatmapCell[] = sortedSources.map(src => {
      const entry = src.code_counts?.[String(code.id)]
      const rawCount = entry?.count ?? 0
      const wordCount = entry?.word_count ?? 0
      const displayValue = computeCellValue(
        rawCount, wordCount,
        src.total_segments, src.total_word_count, src.coded_segments,
        valueMode, denominatorMode,
      )
      if (displayValue > maxValue) maxValue = displayValue
      return { displayValue, rawCount, wordCount, columnId: src.source_id, columnLabel: src.source_label }
    })
    const totalN = cells.reduce((sum, c) => sum + c.rawCount, 0)
    return {
      label: code.name,
      id: code.id,
      sourceType: 'code',
      cells,
      totalN,
    }
  })
  return {
    rows,
    columnLabels: sortedSources.map(s => s.source_label),
    columnIds: sortedSources.map(s => s.source_id),
    maxValue,
  }
}

// ── Bar chart ───────────────────────────────────────────────────────────────

export interface QualBarDatum {
  label: string
  fullLabel: string
  value: number
  count: number
  color: string
  codeId: number
  categoryName: string | null
}

export function shapeQualBarData(
  response: SourceFrequenciesResponse,
  valueMode: QualValueMode,
  denominatorMode: QualDenominatorMode,
  sortOrder: QualSortOrder,
): QualBarDatum[] {
  const { codes, sources, totals } = response

  // Per-code (or per-category when backend returns category-level data) aggregation across all sources
  const bars: QualBarDatum[] = codes.map(code => {
    let count = 0
    let wordCount = 0
    for (const src of sources) {
      const ce = src.code_counts?.[String(code.id)]
      if (ce) {
        count += ce.count
        wordCount += ce.word_count
      }
    }
    const value = computeCellValue(count, wordCount, totals.total_segments, totals.total_word_count, totals.coded_segments, valueMode, denominatorMode)
    return {
      label: code.name.length > 30 ? code.name.slice(0, 27) + '\u2026' : code.name,
      fullLabel: code.name,
      value,
      count,
      color: getCodeColor(code),
      codeId: code.id,
      categoryName: code.category_name,
    }
  })
  return sortBarData(bars, sortOrder)
}

function sortBarData(bars: QualBarDatum[], sortOrder: QualSortOrder): QualBarDatum[] {
  const sorted = [...bars]
  switch (sortOrder) {
    case 'alpha':
      sorted.sort((a, b) => a.fullLabel.localeCompare(b.fullLabel))
      break
    case 'count_desc':
      sorted.sort((a, b) => b.value - a.value)
      break
    case 'count_asc':
      sorted.sort((a, b) => a.value - b.value)
      break
    default:
      break // import order = original order from API
  }
  return sorted
}

// ── Summary table ───────────────────────────────────────────────────────────

export interface QualCodeSummaryRow {
  codeId: number
  codeName: string
  codeColor: string
  categoryName: string | null
  totalCount: number
  segmentProportion: number
  textCoverage: number
  sourceCount: number
  totalSources: number
  conversationCount: number
  totalConversations: number
}

export interface QualSourceSummaryRow {
  sourceId: number
  sourceLabel: string
  sourceType: 'conversation' | 'text_column' | 'document'
  totalCodes: number
  uniqueCodes: number
  codedSegments: number
  codesPerSegment: number
  avgSegmentLength: number
}

export function shapeQualCodeSummary(
  response: SourceFrequenciesResponse,
): QualCodeSummaryRow[] {
  const { codes, sources, totals } = response
  return codes.map(code => {
    let totalCount = 0
    let totalWordCount = 0
    let convCount = 0
    let srcCount = 0
    for (const src of sources) {
      const ce = src.code_counts?.[String(code.id)]
      if (ce && ce.count > 0) {
        totalCount += ce.count
        totalWordCount += ce.word_count
        srcCount++
        if (src.source_type === 'conversation') convCount++
      }
    }
    return {
      codeId: code.id,
      codeName: code.name,
      codeColor: getCodeColor(code),
      categoryName: code.category_name,
      totalCount,
      segmentProportion: totals.total_segments > 0 ? totalCount / totals.total_segments : 0,
      textCoverage: totals.total_word_count > 0 ? totalWordCount / totals.total_word_count : 0,
      sourceCount: srcCount,
      totalSources: sources.length,
      conversationCount: convCount,
      totalConversations: totals.total_conversations,
    }
  })
}

export function shapeQualSourceSummary(
  response: SourceFrequenciesResponse,
): QualSourceSummaryRow[] {
  const { codes, sources } = response
  return sources.map(src => {
    let totalCodes = 0
    let uniqueCodes = 0
    for (const code of codes) {
      const ce = src.code_counts?.[String(code.id)]
      if (ce && ce.count > 0) {
        totalCodes += ce.count
        uniqueCodes++
      }
    }
    return {
      sourceId: src.source_id,
      sourceLabel: src.source_label,
      sourceType: src.source_type,
      totalCodes,
      uniqueCodes,
      codedSegments: src.coded_segments,
      codesPerSegment: src.coded_segments > 0 ? totalCodes / src.coded_segments : 0,
      avgSegmentLength: src.total_segments > 0 ? src.total_word_count / src.total_segments : 0,
    }
  })
}

// ── Stacked bar ─────────────────────────────────────────────────────────────

export interface QualStackedBarRow {
  label: string
  id: number
  segments: Record<string, number>  // keyed by code name or source label
  total: number
}

export interface QualStackedBarData {
  rows: QualStackedBarRow[]
  segmentLabels: string[]
  colors: Record<string, string>
}

export function shapeQualStackedBarData(
  response: SourceFrequenciesResponse,
  orientation: QualOrientation,
  sortOrder: QualSortOrder,
  valueMode: QualValueMode = 'count',
  denominatorMode: QualDenominatorMode = 'total',
): QualStackedBarData {
  const { codes, sources } = response
  const sortedSources = sortSources(sources, sortOrder)

  if (orientation === 'sources-rows') {
    // Each source is a bar, segments colored by code
    const segmentLabels = codes.map(c => c.name)
    const colors: Record<string, string> = {}
    for (const c of codes) colors[c.name] = getCodeColor(c)

    const rows: QualStackedBarRow[] = sortedSources.map(src => {
      const segments: Record<string, number> = {}
      let total = 0
      for (const code of codes) {
        const ce = src.code_counts?.[String(code.id)]
        const rawCount = ce?.count ?? 0
        const wordCount = ce?.word_count ?? 0
        const value = computeCellValue(
          rawCount, wordCount,
          src.total_segments, src.total_word_count, src.coded_segments,
          valueMode, denominatorMode,
        )
        segments[code.name] = value
        total += value
      }
      return { label: src.source_label, id: src.source_id, segments, total }
    })
    return { rows, segmentLabels, colors }
  }

  // Each code is a bar, segments colored by source
  const segmentLabels = sortedSources.map(s => s.source_label)
  const colors: Record<string, string> = {}
  for (let i = 0; i < sortedSources.length; i++) {
    colors[sortedSources[i].source_label] = QUAL_GROUP_COLORS[i % QUAL_GROUP_COLORS.length]
  }

  const rows: QualStackedBarRow[] = codes.map(code => {
    const segments: Record<string, number> = {}
    let total = 0
    for (const src of sortedSources) {
      const ce = src.code_counts?.[String(code.id)]
      const rawCount = ce?.count ?? 0
      const wordCount = ce?.word_count ?? 0
      const value = computeCellValue(
        rawCount, wordCount,
        src.total_segments, src.total_word_count, src.coded_segments,
        valueMode, denominatorMode,
      )
      segments[src.source_label] = value
      total += value
    }
    return { label: code.name, id: code.id, segments, total }
  })
  return { rows, segmentLabels, colors }
}

// ── Value formatting ────────────────────────────────────────────────────────

export function formatCellValue(value: number, valueMode: QualValueMode): string {
  if (valueMode === 'count') return String(Math.round(value))
  return (value * 100).toFixed(1) + '%'
}

export function getValueModeLabel(valueMode: QualValueMode): string {
  switch (valueMode) {
    case 'count': return 'Count'
    case 'segment_proportion': return 'Proportion'
    case 'text_coverage': return 'Word Coverage'
  }
}

// ── Heatmap cell color ──────────────────────────────────────────────────────

const QUAL_HEATMAP_PRESETS: Record<string, { hue: number; saturation: number }> = {
  green:  { hue: 142, saturation: 76 },
  blue:   { hue: 217, saturation: 91 },
  red:    { hue: 0,   saturation: 84 },
  purple: { hue: 270, saturation: 67 },
  orange: { hue: 25,  saturation: 95 },
  amber:  { hue: 45,  saturation: 93 },
}

export const QUAL_HEATMAP_LABELS: Record<string, string> = {
  green: 'Green',
  blue: 'Blue',
  red: 'Red',
  purple: 'Purple',
  orange: 'Orange',
  amber: 'Amber',
}

export function getHeatmapCellStyle(
  value: number,
  maxValue: number,
  isDark: boolean,
  preset: string = 'green',
): React.CSSProperties {
  if (maxValue === 0 || value === 0) return {}
  const intensity = value / maxValue

  const { hue, saturation } = QUAL_HEATMAP_PRESETS[preset] ?? QUAL_HEATMAP_PRESETS.green
  const neutralL = isDark ? 16 : 96
  const deepL = isDark ? 30 : 36
  const L = neutralL - intensity * (neutralL - deepL)
  const textColor = L < 55 ? '#ffffff' : '#1a1a1a'
  return { backgroundColor: `hsl(${hue}, ${saturation}%, ${L}%)`, color: textColor }
}
