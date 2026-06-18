import { useState, useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { parseIntParam } from '@/lib/utils'
import type {
  QualTab,
  QualCodeMode,
  QualChartType,
  QualValueMode,
  QualDenominatorMode,
  QualSortOrder,
  QualOrientation,
  QualRelView,
  QualCooccurrenceLevel,
  QualComparisonChartMode,
  QualContentMode,
  QuoteGroupBy,
  QuoteSort,
  QuoteDensity,
  QuoteLayout,
} from '@/lib/qual-analysis-types'
import { DEFAULT_FORMATTING, type ChartFormatting } from '@/lib/chart-data'
import type { MaterialResponse } from '@/lib/api'

function getDefaultForKey(key: string): string {
  switch (key) {
    case 'tab': return 'descriptives'
    case 'codeMode': return 'codes'
    case 'excl': return '1'
    case 'chart': return 'heatmap'
    case 'val': return 'count'
    case 'denom': return 'total'
    case 'sort': return 'import'
    case 'orient': return 'sr'
    case 'relView': return 'cooccurrence'
    case 'coLevel': return 'segment'
    case 'contentMode': return 'by-code'
    case 'showProp': return '0'
    case 'compMode': return 'table'
    case 'coPreset': return 'green'
    case 'compPalette': return 'default'
    case 'showEffect': return '1'
    case 'showChartN': return ''
    case 'showSum': return '1'
    case 'showRowN': return '1'
    case 'sGroupBy': return 'code'
    case 'sSort': return 'source'
    case 'sDensity': return 'quote'
    case 'sLayout': return 'auto'
    case 'qbHideCodes': return ''
    case 'qbHideUncoded': return ''
    case 'qbHideConvs': return ''
    case 'qbHideCcols': return ''
    case 'qbHideDocs': return ''
    default: return ''
  }
}

export interface QualitativeAnalysisState {
  // Top-level
  tab: QualTab
  source: 'all' | 'conversations' | 'text'

  // Code selection
  codeMode: QualCodeMode
  selectedCodeIds: Set<number>

  // Source selection
  selectedConversationIds: Set<number>
  selectedTextColumnIds: Set<number>
  selectedDocumentIds: Set<number>

  // Filters
  excludeFacilitator: boolean
  participantIds: number[]

  // Descriptives
  chartType: QualChartType
  valueMode: QualValueMode
  denominatorMode: QualDenominatorMode
  sortOrder: QualSortOrder
  orientation: QualOrientation

  // Relationships
  relView: QualRelView
  cooccurrenceLevel: QualCooccurrenceLevel
  showProportion: boolean
  cooccurrencePreset: string
  comparisonChartMode: QualComparisonChartMode
  comparisonPalette: string
  showEffectSize: boolean
  groupBy: string | null

  // Content
  contentMode: QualContentMode
  contentCodeId: number | null
  contentSource: string | null

  // Quote Board
  quoteGroupBy: QuoteGroupBy
  quoteSort: QuoteSort
  quoteDensity: QuoteDensity
  quoteLayout: QuoteLayout

  // Quote Board exclude filters
  qbHiddenCodeIds: Set<number>
  qbHideUncoded: boolean
  qbHiddenConversationIds: Set<number>
  qbHiddenTextColumnIds: Set<number>
  qbHiddenDocumentIds: Set<number>

  // Text annotations (not URL-persisted — saved via palette only)
  descTitle: string
  descSubtitle: string
  descFootnote: string
  relTitle: string
  relSubtitle: string
  relFootnote: string

  // Heatmap / Summary table annotations
  showSummaryRow: boolean
  showRowN: boolean

  // Chart N
  showChartN: boolean

  // Formatting (not URL-persisted)
  formatting: ChartFormatting
  customOrder: number[]

  // Palette
  activeMaterialId: number | null
}

export interface QualitativeAnalysisActions {
  setTab: (tab: QualTab) => void
  setSource: (source: 'all' | 'conversations' | 'text') => void
  setCodeMode: (mode: QualCodeMode) => void
  setSelectedCodeIds: (ids: Set<number>) => void
  setSelectedConversationIds: (ids: Set<number>) => void
  setSelectedTextColumnIds: (ids: Set<number>) => void
  setSelectedDocumentIds: (ids: Set<number>) => void
  setAllSourceIds: (convIds: Set<number>, ccolIds: Set<number>, docIds: Set<number>) => void
  setExcludeFacilitator: (exclude: boolean) => void
  setParticipantIds: (ids: number[]) => void
  setChartType: (type: QualChartType) => void
  setValueMode: (mode: QualValueMode) => void
  setDenominatorMode: (mode: QualDenominatorMode) => void
  setSortOrder: (order: QualSortOrder) => void
  setOrientation: (orient: QualOrientation) => void
  setRelView: (view: QualRelView) => void
  setCooccurrenceLevel: (level: QualCooccurrenceLevel) => void
  setShowProportion: (show: boolean) => void
  setCooccurrencePreset: (preset: string) => void
  setComparisonChartMode: (mode: QualComparisonChartMode) => void
  setComparisonPalette: (palette: string) => void
  setShowEffectSize: (show: boolean) => void
  setGroupBy: (groupBy: string | null) => void
  setDescTitle: (v: string) => void
  setDescSubtitle: (v: string) => void
  setDescFootnote: (v: string) => void
  setRelTitle: (v: string) => void
  setRelSubtitle: (v: string) => void
  setRelFootnote: (v: string) => void
  setShowSummaryRow: (v: boolean) => void
  setShowRowN: (v: boolean) => void
  setShowChartN: (v: boolean) => void
  setContentMode: (mode: QualContentMode) => void
  setContentCodeId: (codeId: number | null) => void
  setContentSource: (source: string | null) => void
  setQuoteGroupBy: (v: QuoteGroupBy) => void
  setQuoteSort: (v: QuoteSort) => void
  setQuoteDensity: (v: QuoteDensity) => void
  setQuoteLayout: (v: QuoteLayout) => void
  setQbHiddenCodeIds: (ids: Set<number>) => void
  setQbHideUncoded: (v: boolean) => void
  setQbHiddenConversationIds: (ids: Set<number>) => void
  setQbHiddenTextColumnIds: (ids: Set<number>) => void
  setQbHiddenDocumentIds: (ids: Set<number>) => void
  clearQbFilters: () => void
  setFormatting: (f: ChartFormatting) => void
  onFormattingChange: (patch: Partial<ChartFormatting>) => void
  setCustomOrder: (ids: number[]) => void
  viewCodeInContent: (codeId: number) => void
  buildCurrentConfig: () => Record<string, unknown>
  loadMaterial: (element: MaterialResponse) => void
  setUrlParam: (key: string, value: string) => void
}

function parseIds(raw: string): Set<number> {
  if (!raw) return new Set()
  const ids = raw.split(',').map(Number).filter(n => !isNaN(n) && n > 0)
  return new Set(ids)
}

function serializeIds(ids: Set<number>): string {
  return Array.from(ids).sort((a, b) => a - b).join(',')
}

export function useQualitativeAnalysis(): QualitativeAnalysisState & QualitativeAnalysisActions {
  const [searchParams, setSearchParams] = useSearchParams()
  const [formatting, setFormatting] = useState<ChartFormatting>({ ...DEFAULT_FORMATTING })

  // Text annotations (per-tab, not URL-persisted — saved via palette only)
  const [descTitle, setDescTitle] = useState('')
  const [descSubtitle, setDescSubtitle] = useState('')
  const [descFootnote, setDescFootnote] = useState('')
  const [relTitle, setRelTitle] = useState('')
  const [relSubtitle, setRelSubtitle] = useState('')
  const [relFootnote, setRelFootnote] = useState('')

  // ── Read URL params (stable primitive deps) ──────────────────────────

  const tabRaw = searchParams.get('tab') || 'descriptives'
  const sourceRaw = searchParams.get('source') || 'all'
  const codeModeRaw = searchParams.get('codeMode') || 'codes'
  const codesRaw = searchParams.get('codes') ?? ''
  const convsRaw = searchParams.get('convs') ?? ''
  const ccolsRaw = searchParams.get('ccols') ?? ''
  const docsRaw = searchParams.get('docs') ?? ''
  const exclRaw = searchParams.get('excl')
  const pidsRaw = searchParams.get('pids') ?? ''
  const chartRaw = searchParams.get('chart') || 'heatmap'
  const valRaw = searchParams.get('val') || 'count'
  const denomRaw = searchParams.get('denom') || 'total'
  const sortRaw = searchParams.get('sort') || 'import'
  const orientRaw = searchParams.get('orient') || 'sr'
  const relViewRaw = searchParams.get('relView') || 'cooccurrence'
  const coLevelRaw = searchParams.get('coLevel') || 'segment'
  const showPropRaw = searchParams.get('showProp') ?? '0'
  const coPresetRaw = searchParams.get('coPreset') || 'green'
  const compModeRaw = searchParams.get('compMode') || 'table'
  const compPaletteRaw = searchParams.get('compPalette') || 'default'
  const showEffectRaw = searchParams.get('showEffect') ?? '1'
  const showSumRaw = searchParams.get('showSum') ?? '1'
  const showRowNRaw = searchParams.get('showRowN') ?? '1'
  const showChartNRaw = searchParams.get('showChartN') ?? ''
  const groupByRaw = searchParams.get('groupBy') ?? ''
  const contentModeRaw = searchParams.get('contentMode') || 'by-code'
  const contentCodeRaw = searchParams.get('contentCode') ?? ''
  const contentSrcRaw = searchParams.get('contentSrc') ?? ''
  const sGroupByRaw = searchParams.get('sGroupBy') || 'code'
  const sSortRaw = searchParams.get('sSort') || 'source'
  const sDensityRaw = searchParams.get('sDensity') || 'quote'
  const sLayoutRaw = searchParams.get('sLayout') || 'auto'
  const customOrderRaw = searchParams.get('customOrder') ?? ''
  // Backward-compat: accept legacy ?element= bookmarks for one release (#343).
  const elementRaw = (searchParams.get('material') ?? searchParams.get('element')) ?? ''
  const qbHideCodesRaw = searchParams.get('qbHideCodes') ?? ''
  const qbHideUncodedRaw = searchParams.get('qbHideUncoded') ?? ''
  const qbHideConvsRaw = searchParams.get('qbHideConvs') ?? ''
  const qbHideCcolsRaw = searchParams.get('qbHideCcols') ?? ''
  const qbHideDocsRaw = searchParams.get('qbHideDocs') ?? ''

  // ── Derived state ────────────────────────────────────────────────────

  const tab = tabRaw as QualTab
  // Backward compat: treat old 'comments' URL param as 'text'
  const source = (sourceRaw === 'comments' ? 'text' : sourceRaw) as 'all' | 'conversations' | 'text'
  const codeMode = codeModeRaw as QualCodeMode
  const selectedCodeIds = useMemo(() => parseIds(codesRaw), [codesRaw])
  const selectedConversationIds = useMemo(() => parseIds(convsRaw), [convsRaw])
  const selectedTextColumnIds = useMemo(() => parseIds(ccolsRaw), [ccolsRaw])
  const selectedDocumentIds = useMemo(() => parseIds(docsRaw), [docsRaw])
  const excludeFacilitator = exclRaw !== '0'
  const participantIds = useMemo(() => {
    if (!pidsRaw) return [] as number[]
    return pidsRaw.split(',').map(Number).filter(n => !isNaN(n))
  }, [pidsRaw])
  const chartType = chartRaw as QualChartType
  const valueMode = valRaw as QualValueMode
  const denominatorMode = denomRaw as QualDenominatorMode
  const sortOrder = sortRaw as QualSortOrder
  const orientation = (orientRaw === 'cr' ? 'codes-rows' : 'sources-rows') as QualOrientation
  const relView = relViewRaw as QualRelView
  const cooccurrenceLevel = coLevelRaw as QualCooccurrenceLevel
  const showProportion = showPropRaw === '1'
  const cooccurrencePreset = coPresetRaw
  const comparisonChartMode = compModeRaw as QualComparisonChartMode
  const comparisonPalette = compPaletteRaw
  const showEffectSize = showEffectRaw !== '0'
  const showSummaryRow = showSumRaw !== '0'
  const showRowN = showRowNRaw !== '0'
  const showChartN = showChartNRaw === '1'
  const groupBy = groupByRaw || null
  const contentMode = contentModeRaw as QualContentMode
  const contentCodeId = useMemo(() => parseIntParam(contentCodeRaw || null), [contentCodeRaw])
  const contentSource = contentSrcRaw || null
  const quoteGroupBy = sGroupByRaw as QuoteGroupBy
  const quoteSort = sSortRaw as QuoteSort
  const quoteDensity = sDensityRaw as QuoteDensity
  const quoteLayout = sLayoutRaw as QuoteLayout
  const qbHiddenCodeIds = useMemo(() => parseIds(qbHideCodesRaw), [qbHideCodesRaw])
  const qbHideUncoded = qbHideUncodedRaw === '1'
  const qbHiddenConversationIds = useMemo(() => parseIds(qbHideConvsRaw), [qbHideConvsRaw])
  const qbHiddenTextColumnIds = useMemo(() => parseIds(qbHideCcolsRaw), [qbHideCcolsRaw])
  const qbHiddenDocumentIds = useMemo(() => parseIds(qbHideDocsRaw), [qbHideDocsRaw])
  const customOrder = useMemo(() => {
    if (!customOrderRaw) return [] as number[]
    return customOrderRaw.split(',').map(Number).filter(n => !isNaN(n) && n > 0)
  }, [customOrderRaw])
  const activeMaterialId = useMemo(() => parseIntParam(elementRaw || null), [elementRaw])

  // ── URL param helper ─────────────────────────────────────────────────

  const setUrlParam = useCallback((key: string, value: string) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (!value || value === getDefaultForKey(key)) {
        next.delete(key)
      } else {
        next.set(key, value)
      }
      return next
    }, { replace: true })
  }, [setSearchParams])

  // ── Individual setters ───────────────────────────────────────────────

  const setTab = useCallback((v: QualTab) => setUrlParam('tab', v), [setUrlParam])

  const setSource = useCallback((v: 'all' | 'conversations' | 'text') => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (v === 'all') next.delete('source')
      else next.set('source', v)
      return next
    }, { replace: true })
  }, [setSearchParams])

  const setCodeMode = useCallback((v: QualCodeMode) => setUrlParam('codeMode', v), [setUrlParam])

  const setSelectedCodeIds = useCallback((ids: Set<number>) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      const str = serializeIds(ids)
      if (!str) next.delete('codes')
      else next.set('codes', str)
      return next
    }, { replace: true })
  }, [setSearchParams])

  const setSelectedConversationIds = useCallback((ids: Set<number>) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      const str = serializeIds(ids)
      if (!str) next.delete('convs')
      else next.set('convs', str)
      return next
    }, { replace: true })
  }, [setSearchParams])

  const setSelectedTextColumnIds = useCallback((ids: Set<number>) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      const str = serializeIds(ids)
      if (!str) next.delete('ccols')
      else next.set('ccols', str)
      return next
    }, { replace: true })
  }, [setSearchParams])

  const setSelectedDocumentIds = useCallback((ids: Set<number>) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      const str = serializeIds(ids)
      if (!str) next.delete('docs')
      else next.set('docs', str)
      return next
    }, { replace: true })
  }, [setSearchParams])

  const setAllSourceIds = useCallback((convIds: Set<number>, ccolIds: Set<number>, docIds: Set<number>) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      const cs = serializeIds(convIds)
      const cc = serializeIds(ccolIds)
      const ds = serializeIds(docIds)
      if (!cs) next.delete('convs'); else next.set('convs', cs)
      if (!cc) next.delete('ccols'); else next.set('ccols', cc)
      if (!ds) next.delete('docs'); else next.set('docs', ds)
      return next
    }, { replace: true })
  }, [setSearchParams])

  const setExcludeFacilitator = useCallback((exclude: boolean) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (exclude) next.delete('excl')
      else next.set('excl', '0')
      return next
    }, { replace: true })
  }, [setSearchParams])

  const setParticipantIds = useCallback((ids: number[]) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (ids.length === 0) next.delete('pids')
      else next.set('pids', ids.join(','))
      return next
    }, { replace: true })
  }, [setSearchParams])

  const setChartType = useCallback((v: QualChartType) => setUrlParam('chart', v), [setUrlParam])
  const setValueMode = useCallback((v: QualValueMode) => setUrlParam('val', v), [setUrlParam])
  const setDenominatorMode = useCallback((v: QualDenominatorMode) => setUrlParam('denom', v), [setUrlParam])
  const setSortOrder = useCallback((v: QualSortOrder) => setUrlParam('sort', v), [setUrlParam])

  const setOrientation = useCallback((v: QualOrientation) => {
    setUrlParam('orient', v === 'codes-rows' ? 'cr' : 'sr')
  }, [setUrlParam])

  const setRelView = useCallback((v: QualRelView) => setUrlParam('relView', v), [setUrlParam])
  const setCooccurrenceLevel = useCallback((v: QualCooccurrenceLevel) => setUrlParam('coLevel', v), [setUrlParam])
  const setShowProportion = useCallback((v: boolean) => setUrlParam('showProp', v ? '1' : '0'), [setUrlParam])
  const setCooccurrencePreset = useCallback((v: string) => setUrlParam('coPreset', v), [setUrlParam])
  const setComparisonChartMode = useCallback((v: QualComparisonChartMode) => setUrlParam('compMode', v), [setUrlParam])
  const setComparisonPalette = useCallback((v: string) => setUrlParam('compPalette', v), [setUrlParam])
  const setShowEffectSize = useCallback((v: boolean) => setUrlParam('showEffect', v ? '1' : '0'), [setUrlParam])
  const setShowSummaryRow = useCallback((v: boolean) => setUrlParam('showSum', v ? '1' : '0'), [setUrlParam])
  const setShowRowN = useCallback((v: boolean) => setUrlParam('showRowN', v ? '1' : '0'), [setUrlParam])
  const setShowChartN = useCallback((v: boolean) => setUrlParam('showChartN', v ? '1' : ''), [setUrlParam])

  const setGroupBy = useCallback((v: string | null) => setUrlParam('groupBy', v ?? ''), [setUrlParam])
  const setContentMode = useCallback((v: QualContentMode) => setUrlParam('contentMode', v), [setUrlParam])

  const setContentCodeId = useCallback((v: number | null) => {
    setUrlParam('contentCode', v !== null ? String(v) : '')
  }, [setUrlParam])

  const setContentSource = useCallback((v: string | null) => {
    setUrlParam('contentSrc', v ?? '')
  }, [setUrlParam])

  const setQuoteGroupBy = useCallback((v: QuoteGroupBy) => setUrlParam('sGroupBy', v), [setUrlParam])
  const setQuoteSort = useCallback((v: QuoteSort) => setUrlParam('sSort', v), [setUrlParam])
  const setQuoteDensity = useCallback((v: QuoteDensity) => setUrlParam('sDensity', v), [setUrlParam])
  const setQuoteLayout = useCallback((v: QuoteLayout) => setUrlParam('sLayout', v), [setUrlParam])

  const setQbHiddenCodeIds = useCallback((ids: Set<number>) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      const str = serializeIds(ids)
      if (!str) next.delete('qbHideCodes')
      else next.set('qbHideCodes', str)
      return next
    }, { replace: true })
  }, [setSearchParams])

  const setQbHideUncoded = useCallback((v: boolean) => setUrlParam('qbHideUncoded', v ? '1' : ''), [setUrlParam])

  const setQbHiddenConversationIds = useCallback((ids: Set<number>) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      const str = serializeIds(ids)
      if (!str) next.delete('qbHideConvs')
      else next.set('qbHideConvs', str)
      return next
    }, { replace: true })
  }, [setSearchParams])

  const setQbHiddenTextColumnIds = useCallback((ids: Set<number>) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      const str = serializeIds(ids)
      if (!str) next.delete('qbHideCcols')
      else next.set('qbHideCcols', str)
      return next
    }, { replace: true })
  }, [setSearchParams])

  const setQbHiddenDocumentIds = useCallback((ids: Set<number>) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      const str = serializeIds(ids)
      if (!str) next.delete('qbHideDocs')
      else next.set('qbHideDocs', str)
      return next
    }, { replace: true })
  }, [setSearchParams])

  const clearQbFilters = useCallback(() => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.delete('qbHideCodes')
      next.delete('qbHideUncoded')
      next.delete('qbHideConvs')
      next.delete('qbHideCcols')
      next.delete('qbHideDocs')
      return next
    }, { replace: true })
  }, [setSearchParams])

  const onFormattingChange = useCallback((patch: Partial<ChartFormatting>) => {
    setFormatting(prev => ({ ...prev, ...patch }))
  }, [])

  const setCustomOrder = useCallback((ids: number[]) => {
    setUrlParam('customOrder', ids.length > 0 ? ids.join(',') : '')
  }, [setUrlParam])

  // ── Compound actions ─────────────────────────────────────────────────

  const viewCodeInContent = useCallback((codeId: number) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.set('tab', 'content')
      next.set('contentMode', 'by-code')
      next.set('contentCode', String(codeId))
      return next
    }, { replace: true })
  }, [setSearchParams])

  // ── Palette config ───────────────────────────────────────────────────

  const buildCurrentConfig = useCallback((): Record<string, unknown> => {
    const config: Record<string, unknown> = {
      tab,
      source,
      code_mode: codeMode,
      code_ids: Array.from(selectedCodeIds),
      conversation_ids: Array.from(selectedConversationIds),
      text_column_ids: Array.from(selectedTextColumnIds),
      document_ids: Array.from(selectedDocumentIds),
      exclude_facilitator: excludeFacilitator,
      participant_ids: participantIds,
      chart_type: chartType,
      value_mode: valueMode,
      denominator_mode: denominatorMode,
      sort_order: sortOrder,
      orientation: orientRaw,
      rel_view: relView,
      cooccurrence_level: cooccurrenceLevel,
      show_proportion: showProportion,
      cooccurrence_preset: cooccurrencePreset,
      comparison_chart_mode: comparisonChartMode,
      comparison_palette: comparisonPalette,
      show_effect_size: showEffectSize,
      group_by: groupBy,
      content_mode: contentMode,
      content_code_id: contentCodeId,
      content_source: contentSource,
    }
    // Title/subtitle/footnote per-tab
    if (tab === 'relationships') {
      if (relTitle) config.title = relTitle
      if (relSubtitle) config.subtitle = relSubtitle
      if (relFootnote) config.footnote = relFootnote
    } else {
      if (descTitle) config.title = descTitle
      if (descSubtitle) config.subtitle = descSubtitle
      if (descFootnote) config.footnote = descFootnote
    }
    if (!showSummaryRow) config.show_summary_row = false
    if (!showRowN) config.show_row_n = false
    if (showChartN) config.show_chart_n = true
    // Only persist formatting fields that differ from defaults
    const fmtPatch: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(formatting)) {
      if (JSON.stringify(v) !== JSON.stringify(DEFAULT_FORMATTING[k as keyof ChartFormatting])) {
        fmtPatch[k] = v
      }
    }
    if (Object.keys(fmtPatch).length > 0) config.formatting = fmtPatch
    if (customOrder.length > 0) config.custom_order = customOrder
    return config
  }, [
    tab, source, codeMode, selectedCodeIds, selectedConversationIds,
    selectedTextColumnIds, selectedDocumentIds, excludeFacilitator, participantIds,
    chartType, valueMode, denominatorMode, sortOrder, orientRaw,
    relView, cooccurrenceLevel, showProportion, cooccurrencePreset, comparisonChartMode, comparisonPalette, showEffectSize, showSummaryRow, showRowN, showChartN, groupBy, contentMode, contentCodeId, contentSource,
    descTitle, descSubtitle, descFootnote, relTitle, relSubtitle, relFootnote,
    formatting, customOrder,
  ])

  const loadMaterial = useCallback((element: MaterialResponse) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config = (element.config || {}) as Record<string, any>
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.delete('element')  // remove any legacy alias before writing canonical key
      next.set('material', String(element.id))

      // Tab
      if (config.tab && config.tab !== 'descriptives') next.set('tab', config.tab)
      else next.delete('tab')

      // Source
      if (config.source && config.source !== 'all') next.set('source', config.source)
      else next.delete('source')

      // Code selections
      if (config.code_ids?.length > 0) next.set('codes', config.code_ids.join(','))
      else next.delete('codes')

      if (config.code_mode && config.code_mode !== 'codes') next.set('codeMode', config.code_mode)
      else next.delete('codeMode')

      // Source selections
      if (config.conversation_ids?.length > 0) next.set('convs', config.conversation_ids.join(','))
      else next.delete('convs')

      if (config.text_column_ids?.length > 0) next.set('ccols', config.text_column_ids.join(','))
      else next.delete('ccols')

      if (config.document_ids?.length > 0) next.set('docs', config.document_ids.join(','))
      else next.delete('docs')

      // Filters
      if (config.exclude_facilitator === false) next.set('excl', '0')
      else next.delete('excl')

      if (config.participant_ids?.length > 0) next.set('pids', config.participant_ids.join(','))
      else next.delete('pids')

      // Descriptives
      if (config.chart_type && config.chart_type !== 'heatmap') next.set('chart', config.chart_type)
      else next.delete('chart')

      if (config.value_mode && config.value_mode !== 'count') next.set('val', config.value_mode)
      else next.delete('val')

      if (config.denominator_mode && config.denominator_mode !== 'total') next.set('denom', config.denominator_mode)
      else next.delete('denom')

      if (config.sort_order && config.sort_order !== 'import') next.set('sort', config.sort_order)
      else next.delete('sort')

      if (config.orientation && config.orientation !== 'sr') next.set('orient', config.orientation)
      else next.delete('orient')

      // Relationships
      if (config.rel_view && config.rel_view !== 'cooccurrence') next.set('relView', config.rel_view)
      else next.delete('relView')

      if (config.cooccurrence_level && config.cooccurrence_level !== 'segment') next.set('coLevel', config.cooccurrence_level)
      else next.delete('coLevel')

      // Show proportion
      if (config.show_proportion) next.set('showProp', '1')
      else next.delete('showProp')

      // Co-occurrence preset
      if (config.cooccurrence_preset && config.cooccurrence_preset !== 'green') next.set('coPreset', config.cooccurrence_preset)
      else next.delete('coPreset')

      // Comparison chart mode
      if (config.comparison_chart_mode && config.comparison_chart_mode !== 'table') next.set('compMode', config.comparison_chart_mode)
      else next.delete('compMode')

      // Comparison palette
      if (config.comparison_palette && config.comparison_palette !== 'default') next.set('compPalette', config.comparison_palette)
      else next.delete('compPalette')

      // Show effect size
      if (config.show_effect_size === false) next.set('showEffect', '0')
      else next.delete('showEffect')

      if (config.group_by) next.set('groupBy', config.group_by)
      else next.delete('groupBy')

      // Content
      if (config.content_mode && config.content_mode !== 'by-code') next.set('contentMode', config.content_mode)
      else next.delete('contentMode')

      if (config.content_code_id) next.set('contentCode', String(config.content_code_id))
      else next.delete('contentCode')

      if (config.content_source) next.set('contentSrc', config.content_source)
      else next.delete('contentSrc')

      // Custom order
      if (config.custom_order?.length > 0) next.set('customOrder', config.custom_order.join(','))
      else next.delete('customOrder')

      // Summary row / Row N
      if (config.show_summary_row === false) next.set('showSum', '0')
      else next.delete('showSum')

      if (config.show_row_n === false) next.set('showRowN', '0')
      else next.delete('showRowN')

      // Chart N
      if (config.show_chart_n) next.set('showChartN', '1')
      else next.delete('showChartN')

      return next
    }, { replace: true })

    // Restore formatting (non-URL state)
    if (config.formatting) {
      setFormatting({ ...DEFAULT_FORMATTING, ...config.formatting })
    } else {
      setFormatting({ ...DEFAULT_FORMATTING })
    }

    // Restore title/subtitle/footnote (per-tab, non-URL state)
    // Clear both tabs first, then set the target tab's values
    setDescTitle('')
    setDescSubtitle('')
    setDescFootnote('')
    setRelTitle('')
    setRelSubtitle('')
    setRelFootnote('')
    const isRelTab = config.tab === 'relationships'
    if (isRelTab) {
      setRelTitle(config.title || '')
      setRelSubtitle(config.subtitle || '')
      setRelFootnote(config.footnote || '')
    } else {
      setDescTitle(config.title || '')
      setDescSubtitle(config.subtitle || '')
      setDescFootnote(config.footnote || '')
    }
  }, [setSearchParams])

  return {
    // State
    tab,
    source,
    codeMode,
    selectedCodeIds,
    selectedConversationIds,
    selectedTextColumnIds,
    selectedDocumentIds,
    excludeFacilitator,
    participantIds,
    chartType,
    valueMode,
    denominatorMode,
    sortOrder,
    orientation,
    relView,
    cooccurrenceLevel,
    showProportion,
    cooccurrencePreset,
    comparisonChartMode,
    comparisonPalette,
    showEffectSize,
    showSummaryRow,
    showRowN,
    showChartN,
    descTitle,
    descSubtitle,
    descFootnote,
    relTitle,
    relSubtitle,
    relFootnote,
    groupBy,
    contentMode,
    contentCodeId,
    contentSource,
    quoteGroupBy,
    quoteSort,
    quoteDensity,
    quoteLayout,
    qbHiddenCodeIds,
    qbHideUncoded,
    qbHiddenConversationIds,
    qbHiddenTextColumnIds,
    qbHiddenDocumentIds,
    formatting,
    customOrder,
    activeMaterialId,
    // Actions
    setTab,
    setSource,
    setCodeMode,
    setSelectedCodeIds,
    setSelectedConversationIds,
    setSelectedTextColumnIds,
    setSelectedDocumentIds,
    setAllSourceIds,
    setExcludeFacilitator,
    setParticipantIds,
    setChartType,
    setValueMode,
    setDenominatorMode,
    setSortOrder,
    setOrientation,
    setRelView,
    setCooccurrenceLevel,
    setShowProportion,
    setCooccurrencePreset,
    setComparisonChartMode,
    setComparisonPalette,
    setShowEffectSize,
    setShowSummaryRow,
    setShowRowN,
    setShowChartN,
    setDescTitle,
    setDescSubtitle,
    setDescFootnote,
    setRelTitle,
    setRelSubtitle,
    setRelFootnote,
    setGroupBy,
    setContentMode,
    setContentCodeId,
    setContentSource,
    setQuoteGroupBy,
    setQuoteSort,
    setQuoteDensity,
    setQuoteLayout,
    setQbHiddenCodeIds,
    setQbHideUncoded,
    setQbHiddenConversationIds,
    setQbHiddenTextColumnIds,
    setQbHiddenDocumentIds,
    clearQbFilters,
    setFormatting,
    onFormattingChange,
    setCustomOrder,
    viewCodeInContent,
    buildCurrentConfig,
    loadMaterial,
    setUrlParam,
  }
}
