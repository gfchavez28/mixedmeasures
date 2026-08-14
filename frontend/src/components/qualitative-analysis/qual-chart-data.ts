import type {
  SourceFrequenciesResponse,
  SourceEntry,
  SourceKind,
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
  // `SourceKind` + the heatmap's own code-as-row mode (#679: one enumeration).
  sourceType: SourceKind | 'code'
  cells: QualHeatmapCell[]
  totalN: number
}

export interface QualHeatmapData {
  rows: QualHeatmapRow[]
  columnLabels: string[]
  columnIds: number[]
  maxValue: number
}

/**
 * The SOURCE axis. `'custom'` deliberately falls through to import order — the
 * drag list orders CODES, and there is no custom source list to honour (#675).
 */
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
    case 'custom':
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

// ── The code axis (#675) ────────────────────────────────────────────────────

/**
 * Order by an explicit id list: listed ids first in that order, everything else
 * appended in its original order.
 *
 * The rule is `hooks/useAnalysisDerived.ts:74–83`'s, deliberately — the
 * quantitative path has implemented this since it shipped, and the qualitative
 * side had the same authoring UI and the same `custom_order` config key with no
 * consumer at all. An id in the list that no longer exists is skipped, so a
 * deleted code cannot leave a hole.
 */
export function applyCustomOrder<T>(
  items: T[],
  customOrder: number[],
  idOf: (item: T) => number,
): T[] {
  if (customOrder.length === 0) return [...items]
  const remaining = new Map(items.map(item => [idOf(item), item]))
  const out: T[] = []
  for (const id of customOrder) {
    const item = remaining.get(id)
    if (item !== undefined) {
      out.push(item)
      remaining.delete(id)
    }
  }
  for (const item of items) if (remaining.has(idOf(item))) out.push(item)
  return out
}

/**
 * The ONE ordering rule for the code axis, shared by all three shapers.
 *
 * ⚠️ Before #675 only the bar chart ordered codes at all: the heatmap and the
 * stacked bar applied `sortOrder` to their SOURCE axis in both orientations, so
 * "Codes as rows" + any sort left the rows in import order — `alpha` and the two
 * `count` options were as dead as `custom` was, on two charts out of three. This
 * is a pure ADDITION: the source axis keeps the ordering it has always had, and
 * the code axis gains the one it was already being asked for.
 */
function orderCodeAxis<T>(
  items: T[],
  sortOrder: QualSortOrder,
  customOrder: number[],
  accessors: { id: (item: T) => number; label: (item: T) => string; value: (item: T) => number },
): T[] {
  const sorted = [...items]
  switch (sortOrder) {
    case 'alpha':
      sorted.sort((a, b) => accessors.label(a).localeCompare(accessors.label(b)))
      break
    case 'count_desc':
      sorted.sort((a, b) => accessors.value(b) - accessors.value(a))
      break
    case 'count_asc':
      sorted.sort((a, b) => accessors.value(a) - accessors.value(b))
      break
    case 'custom':
      return applyCustomOrder(items, customOrder, accessors.id)
    case 'import':
    default:
      break
  }
  return sorted
}

/**
 * A code's magnitude across the whole selection — what `count_desc`/`count_asc`
 * order the code axis by.
 *
 * Computed through `computeCellValue` against the response totals, i.e. exactly
 * the aggregation `shapeQualBarData` performs for its bars, so a heatmap row and
 * the bar for the same code can never disagree about which is larger. Every code
 * shares the denominator, so this ranks by summed count under `count`/
 * `segment_proportion` and by summed words under `text_coverage`.
 */
function codeMagnitudes(
  response: SourceFrequenciesResponse,
  valueMode: QualValueMode,
  denominatorMode: QualDenominatorMode,
): Map<number, number> {
  const { codes, sources, totals } = response
  const out = new Map<number, number>()
  for (const code of codes) {
    let count = 0
    let wordCount = 0
    for (const src of sources) {
      const ce = src.code_counts?.[String(code.id)]
      if (ce) {
        count += ce.count
        wordCount += ce.word_count
      }
    }
    out.set(code.id, computeCellValue(
      count, wordCount,
      totals.total_segments, totals.total_word_count, totals.coded_segments,
      valueMode, denominatorMode,
    ))
  }
  return out
}

/** The response's code entries, in the order the code axis should render them. */
function sortResponseCodes<T extends { id: number; name: string }>(
  codes: T[],
  sortOrder: QualSortOrder,
  customOrder: number[],
  magnitudes: Map<number, number>,
): T[] {
  return orderCodeAxis(codes, sortOrder, customOrder, {
    id: c => c.id,
    label: c => c.name,
    value: c => magnitudes.get(c.id) ?? 0,
  })
}

export function shapeQualHeatmapData(
  response: SourceFrequenciesResponse,
  valueMode: QualValueMode,
  denominatorMode: QualDenominatorMode,
  orientation: QualOrientation,
  sortOrder: QualSortOrder,
  customOrder: number[],
): QualHeatmapData {
  const { sources } = response
  const sortedSources = sortSources(sources, sortOrder)
  // #675: the code axis is ordered in BOTH orientations — as rows when codes are
  // the rows, as columns when they are the columns. It used to be neither.
  const codes = sortResponseCodes(
    response.codes, sortOrder, customOrder,
    codeMagnitudes(response, valueMode, denominatorMode),
  )

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
  customOrder: number[],
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
  return sortBarData(bars, sortOrder, customOrder)
}

/**
 * Resolve the data entry behind a recharts Bar label/click callback (#504).
 *
 * recharts compacts zero-dimension rects out of its rendered list
 * (`computeBarRectangles` → `.filter(Boolean)`), so the `index` it passes to
 * label renderers and click handlers enumerates RENDERED bars — indexing the
 * full data array with it shifts every entry after a zero-value bar. Resolve
 * against the rendered (non-zero) order first, cross-checked with the
 * callback's own `value`; fall back to the data order if a future recharts
 * stops compacting. Returns null when no entry matches (no label drawn).
 */
export function resolveRenderedBarEntry<T extends { value: number }>(
  entries: T[],
  renderedIndex: number,
  renderedValue: number,
): T | null {
  const rendered = entries.filter(e => e.value !== 0)
  let entry: T | undefined = rendered[renderedIndex]
  if (!entry || entry.value !== renderedValue) entry = entries[renderedIndex]
  if (!entry || entry.value !== renderedValue || entry.value === 0) return null
  return entry
}

/**
 * The bar chart's bars ARE the code axis, so it routes through the same rule as
 * the heatmap and the stacked bar. `value` is already the aggregate
 * `codeMagnitudes` computes, so passing it directly keeps the two identical
 * without recomputing.
 */
function sortBarData(
  bars: QualBarDatum[],
  sortOrder: QualSortOrder,
  customOrder: number[],
): QualBarDatum[] {
  return orderCodeAxis(bars, sortOrder, customOrder, {
    id: b => b.codeId,
    label: b => b.fullLabel,
    value: b => b.value,
  })
}

// ── Summary table ───────────────────────────────────────────────────────────

export interface QualCodeSummaryRow {
  codeId: number
  codeName: string
  codeColor: string
  categoryName: string | null
  totalCount: number
  segmentProportion: number
  /**
   * "% of Coded" — #745. Computed HERE, from the same payload as `totalCount`,
   * because the two are one fact: the count of segments carrying this code, and
   * that count as a share of the coded segments it was counted in.
   *
   * ⚠️ `null` means "no coded segments in this selection", which is not 0%. The
   * renderer must not collapse the two (#689's convention, and the falsy-zero
   * trap: `pct ? … : '—'` prints "—" for a real measured zero).
   */
  segmentPercentage: number | null
  textCoverage: number
  sourceCount: number
  totalSources: number
  /**
   * Per-kind reach — #749. Every one of these used to come from the
   * `code-frequencies` payload while the row's `totalCount` came from this one.
   * The two endpoints read an unselected kind differently ("none of that kind"
   * here, "ALL of that kind" there), so a conversations-only selection printed
   * Conv. columns scoped to the selection beside Obs. columns scoped to the
   * whole project — and the Texts/Records columns could not be scoped at all,
   * because `/frequencies` declares no `text_column_ids` parameter.
   *
   * Three of these are per-source roll-ups and are derived below.
   * `participantCount` and `recordCount` are NOT derivable — one participant
   * speaks across conversations, one record can be coded in several columns —
   * so they ride the payload per code (or per CATEGORY, keyed identically).
   */
  conversationCount: number
  documentCount: number
  observationCount: number
  textCount: number
  participantCount: number
  recordCount: number
}

/**
 * A share as a percentage, or `null` when the denominator is zero.
 *
 * `null` is "not computable", which is not 0% — the #689 convention. A renderer
 * that collapses them tells the researcher a code reached none of their sources
 * when the truth is that there were no sources to reach.
 */
export function sharePercent(part: number, whole: number): number | null {
  return whole > 0 ? (part / whole) * 100 : null
}

export interface QualSourceSummaryRow {
  sourceId: number
  sourceLabel: string
  sourceType: SourceKind
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
    let srcCount = 0
    // Per-kind reach (#749). Conversations/documents/observations count the
    // SOURCES this code appears in; text columns sum the coded TEXTS, because
    // that is the grain the Texts column has always shown (and the grain the
    // backend's per-column `count` carries).
    let conversationCount = 0
    let documentCount = 0
    let observationCount = 0
    let textCount = 0
    for (const src of sources) {
      const ce = src.code_counts?.[String(code.id)]
      if (ce && ce.count > 0) {
        totalCount += ce.count
        totalWordCount += ce.word_count
        srcCount++
        switch (src.source_type) {
          case 'conversation': conversationCount++; break
          case 'document': documentCount++; break
          case 'observation': observationCount++; break
          case 'text_column': textCount += ce.count; break
        }
      }
    }
    return {
      codeId: code.id,
      codeName: code.name,
      codeColor: getCodeColor(code),
      categoryName: code.category_name,
      totalCount,
      segmentProportion: totals.total_segments > 0 ? totalCount / totals.total_segments : 0,
      // #745: the percentage rides the SAME payload as the count above it.
      // It used to come from the code-frequencies endpoint, which reads an
      // absent id list as "all of that kind" while this one reads an empty list
      // as "none" — so a conversations-only selection had its Count summed over
      // 2 conversations and its % computed over those conversations PLUS every
      // observation in the project. Measured on the dev corpus: every code read
      // `Count 0` beside `25.0%`, with `Sources 0/2`.
      // ⚠️ `totals.total_segments` (above) and `totals.coded_segments` (here)
      // are different denominators on purpose — "share of all segments" vs
      // "share of the coded ones".
      segmentPercentage: totals.coded_segments > 0
        ? (totalCount / totals.coded_segments) * 100
        : null,
      textCoverage: totals.total_word_count > 0 ? totalWordCount / totals.total_word_count : 0,
      sourceCount: srcCount,
      totalSources: sources.length,
      conversationCount,
      documentCount,
      observationCount,
      textCount,
      participantCount: code.participant_count ?? 0,
      recordCount: code.record_count ?? 0,
    }
  })
}

/**
 * The denominator for each per-kind percentage — #749.
 *
 * Every one is "how many of this kind are in the SELECTION", so each percentage
 * is a share of a set the numerator is drawn from. The old Conv. denominator
 * was conversations carrying ANY coding, which made "% Conv." a ratio between
 * two differently-scoped counts.
 */
export function summaryKindTotals(response: SourceFrequenciesResponse) {
  const t = response.totals
  return {
    conversation: t.total_conversations,
    document: t.total_documents,
    observation: t.total_observations,
    text: t.coded_texts,
    participant: t.total_participants,
    record: t.total_records,
  }
}

/**
 * The source kinds actually present in this response (#679).
 *
 * The summary table renders a count/% pair per kind, and this is what decides
 * which pairs exist. Derived from the sources the backend returned rather than
 * from the mode tabs, so the columns follow the researcher's SELECTION: an
 * observations-only selection gets Obs. columns and no Conv. columns, instead
 * of the old fixed pair of groups that had no `showDoc` or `showObs` at all and
 * reported "Conv. 1, Participants 11" for a selection containing neither.
 */
export function presentSourceKinds(
  response: SourceFrequenciesResponse,
): Set<SourceKind> {
  return new Set(response.sources.map(s => s.source_type))
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
  customOrder: number[] = [],
): QualStackedBarData {
  const { sources } = response
  const sortedSources = sortSources(sources, sortOrder)
  // #675: bars when codes are the rows, stack + legend order when they are not.
  const codes = sortResponseCodes(
    response.codes, sortOrder, customOrder,
    codeMagnitudes(response, valueMode, denominatorMode),
  )

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
