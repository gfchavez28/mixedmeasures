import { useState, useMemo, useCallback, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle, useDefaultLayout } from 'react-resizable-panels'
import {
  Download,
  ChevronDown,
  SwatchBook,
  BookOpen,
  Trash2,
  Pencil,
  Filter,
  Focus,
  Clock,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  codesApi,
  categoriesApi,
  codeAnalysisApi,
  conversationsApi,
  documentsApi,
  materialsApi,
  exportApi,
  excerptsApi,
  canvasApi,
  type CodeAnalysisFilterParams,
  type TextColumnInfo,
  type DocumentListItem,
  type SourceFrequenciesRequest,
  type DemographicComparisonRequest,
  type MaterialResponse,
} from '@/lib/api'
import type { DataLabelPosition } from '@/lib/chart-data'
import { invalidateDerivedCounts } from '@/lib/coding-cache'
import type { QualTab, QualContentMode } from '@/lib/qual-analysis-types'
import { useQualitativeAnalysis } from '@/hooks/useQualitativeAnalysis'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import CodePicker from '@/components/qualitative-analysis/CodePicker'
import SourceSelector from '@/components/qualitative-analysis/SourceSelector'
import QualFilterBar from '@/components/qualitative-analysis/QualFilterBar'
import { RelationshipsSidebar, RelationshipsContent } from '@/components/qualitative-analysis/RelationshipsPanel'
import { QuoteBoardSidebar } from '@/components/qualitative-analysis/QuoteBoardPanel'
import { DescriptivesSidebar, DescriptivesContent } from '@/components/qualitative-analysis/DescriptivesPanel'
import BlindScopeNotice from '@/components/qualitative-analysis/BlindScopeNotice'
import ContentByCode from '@/components/qualitative-analysis/ContentByCode'
import ContentBySource from '@/components/qualitative-analysis/ContentBySource'
import QuoteBoardView from '@/components/qualitative-analysis/QuoteBoardView'
import FocusPill from '@/components/qualitative-analysis/FocusPill'
import SendToCanvasMenu from '@/components/canvas/SendToCanvasMenu'
import { getCodeColor } from '@/lib/utils'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import { useCoders } from '@/hooks/useCoders'
import { useAuth } from '@/lib/auth-context'
import CoderFilterPopover from '@/components/CoderFilterPopover'
import SegmentedControl from '@/components/ui/segmented-control'
import { useConsensusStatus } from '@/hooks/useConsensusStatus'
import { useEnsureMaterialCollection } from '@/hooks/useEnsureMaterialCollection'
import ReconciliationGrid from '@/components/qualitative-analysis/ReconciliationGrid'
import IrrMatrix from '@/components/qualitative-analysis/IrrMatrix'
import { isReconciliationTabVisible, isIrrTabVisible } from '@/lib/qual-analysis-types'
import { SELECTED_SEGMENT, SELECTED_ROW } from '@/lib/selection'
import BlindModeToggle from '@/components/BlindModeToggle'
import { useBlindMode } from '@/hooks/useBlindMode'


// ── Constants (hoisted out of component to avoid re-creation per render) ────

const QUAL_TABS: { id: QualTab; label: string }[] = [
  { id: 'content', label: 'Content' },
  { id: 'descriptives', label: 'Descriptives' },
  { id: 'relationships', label: 'Relationships' },
  { id: 'reconciliation', label: 'Reconciliation' },
  { id: 'irr', label: 'Reliability' },
  { id: 'quoteboard', label: 'Quote Board' },
]

const SOURCE_MODES = ['all', 'conversations', 'text'] as const

const CONTENT_MODES: QualContentMode[] = ['by-code', 'by-source']
const CONTENT_MODE_LABELS: Record<QualContentMode, string> = {
  'by-code': 'By Code', 'by-source': 'By Source',
}

const CHART_TYPE_LABELS: Record<string, string> = {
  heatmap: 'Heatmap', bar: 'Horizontal Bar', stacked_bar: 'Stacked Bar',
  summary: 'Summary Table', saturation: 'Saturation',
}

// ── Main View ──────────────────────────────────────────────────────────────

export default function QualitativeAnalysisView() {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const pid = Number(projectId)
  const queryClient = useQueryClient()

  const qa = useQualitativeAnalysis()
  const { openCodebook } = useProjectLayout()
  const { coders, multiCoder } = useCoders()
  const { user } = useAuth()
  const { blind, toggleReveal } = useBlindMode(pid)
  const self = user?.id ?? null
  const [srAnnouncement, setSrAnnouncement] = useState('')

  // Track J · J1 item 4 — hook stores the INCLUDE list (empty = all); the popover
  // works in HIDE-set terms. Convert at this boundary.
  const coderInclude = qa.coderIds
  const coderIncludeCsv = coderInclude.length ? coderInclude.join(',') : undefined
  // Blind mode (DEC-G): analysis surfaces show self-only while blind (the coder filter
  // is forced to just-me + hidden, and the comparison tabs are gated off below).
  // Memoized so the [self] array keeps a stable ref (else downstream useMemo deps churn).
  const effectiveCoderInclude = useMemo(
    () => (blind && self != null ? [self] : coderInclude),
    [blind, self, coderInclude],
  )
  const effectiveCoderIncludeCsv = blind && self != null ? String(self) : coderIncludeCsv
  const hiddenCoders = useMemo(
    () => coderInclude.length
      ? new Set(coders.filter(c => !coderInclude.includes(c.id)).map(c => c.id))
      : new Set<number>(),
    [coders, coderInclude],
  )
  const handleCoderFilterChange = useCallback((hidden: Set<number>) => {
    qa.setCoderIds(hidden.size === 0 ? [] : coders.filter(c => !hidden.has(c.id)).map(c => c.id))
  }, [coders, qa])

  // Track J · J2-5 — consensus-layer status drives the layer selector.
  const { data: consensusStatus } = useConsensusStatus(pid)
  const consensusAvailable = !!consensusStatus?.exists
  // If consensus stops existing (e.g. a coder was removed), fall back to the human
  // layer so the analysis never silently renders an empty consensus view.
  useEffect(() => {
    if (qa.layerScope === 'consensus' && !consensusAvailable) qa.setLayerScope('human')
  }, [consensusAvailable, qa.layerScope, qa.setLayerScope]) // eslint-disable-line react-hooks/exhaustive-deps

  // Track J · J2-5 M-1 — the Reconciliation tab is gated on multi-coder + an existing
  // consensus layer. QUAL_TABS is a module const, so the visible set is derived here.
  const reconciliationVisible = isReconciliationTabVisible(multiCoder, consensusAvailable, blind)
  const irrVisible = isIrrTabVisible(multiCoder, blind)
  const visibleTabs = useMemo(
    () => QUAL_TABS.filter(t =>
      (t.id !== 'reconciliation' || reconciliationVisible) &&
      (t.id !== 'irr' || irrVisible),
    ),
    [reconciliationVisible, irrVisible],
  )
  // Reveal-requiring tabs (Reconciliation/IRR) bounce to Content when they go invisible,
  // gated so a legitimate deep link isn't kicked on the first unsettled frame
  // (reconciliation: consensus-status SETTLED; irr: coders roster loaded — coders.length>0,
  // always ≥1 once settled).
  //
  // #476 — EXCEPT when the tab went invisible because the active coder just SWITCHED while
  // you were revealed. A coder switch is about whose layer you edit, not a request to
  // re-blind, so carry the reveal to the new coder (logged as a session carry-over per
  // DEC-G) instead of bouncing. The per-coder blind default is preserved for every OTHER
  // entry into these tabs.
  const prevSelfRef = useRef(self)
  const wasRevealedRef = useRef(!blind)
  useEffect(() => {
    const switched = prevSelfRef.current !== self
    prevSelfRef.current = self
    const onReconcile = qa.tab === 'reconciliation' && consensusStatus !== undefined && !reconciliationVisible
    const onIrr = qa.tab === 'irr' && coders.length > 0 && !irrVisible
    if (onReconcile || onIrr) {
      // Carry only when the invisibility is a blind re-entry FROM the switch (for
      // reconciliation, consensus must still exist — revealing can't resurrect a missing
      // consensus layer, so bounce in that case).
      const carry = switched && wasRevealedRef.current && blind && multiCoder &&
        (qa.tab === 'irr' || consensusAvailable)
      if (carry) toggleReveal('coder-switch')
      else qa.setTab('content')
    }
    // Track reveal state for the NEXT switch — skip the switch frame so the carry check
    // above reads the PRE-switch value.
    if (!switched) wasRevealedRef.current = !blind
  }, [self, qa.tab, consensusStatus, coders.length, reconciliationVisible, irrVisible, blind, multiCoder, consensusAvailable, toggleReveal, qa.setTab]) // eslint-disable-line react-hooks/exhaustive-deps

  // Sidebar section independent collapse
  const [materialsOpen, setMaterialsOpen] = useState(false)
  const [codesOpen, setCodesOpen] = useState(true)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [exportsOpen, setExportsOpen] = useState(false)
  const [showBoardNotes, setShowBoardNotes] = useState(true)
  const [showBoardCodes, setShowBoardCodes] = useState(true)
  const [showBoardSpeaker, setShowBoardSpeaker] = useState(true)
  const [showBoardSource, setShowBoardSource] = useState(true)
  const [focusedCodeId, setFocusedCodeId] = useState<number | null>(null)

  // Resizable panel layout persistence
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: 'qual-analysis-panels',
    storage: localStorage,
  })

  // Track last-used analysis type for hub page
  useEffect(() => {
    localStorage.setItem(`mm-last-analysis-${pid}`, 'qualitative')
  }, [pid])

  // Backward compat: redirect ?contentMode=starred → ?tab=quoteboard
  useEffect(() => {
    if ((qa.contentMode as string) === 'starred') {
      qa.setTab('quoteboard')
      qa.setContentMode('by-code')
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-switch away from stacked bar when entering category mode (overlap breaks stacking)
  useEffect(() => {
    if (qa.codeMode === 'categories' && qa.chartType === 'stacked_bar') {
      qa.setChartType('heatmap')
    }
  }, [qa.codeMode]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-coerce dataLabels when switching to stacked_bar (which only supports inside/none)
  useEffect(() => {
    if (qa.chartType === 'stacked_bar' && qa.formatting.dataLabels === 'outside') {
      qa.onFormattingChange({ dataLabels: 'none' as DataLabelPosition })
    }
  }, [qa.chartType]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Data queries ──────────────────────────────────────────────────────

  const { data: codesData, isLoading: codesLoading } = useQuery({
    queryKey: ['codes', pid],
    queryFn: () => codesApi.list(pid),
    enabled: !!pid,
  })

  const { data: categoriesData } = useQuery({
    queryKey: ['categories', pid],
    queryFn: () => categoriesApi.list(pid, true),
    enabled: !!pid,
  })

  const { data: conversationsData, isLoading: convsLoading } = useQuery({
    queryKey: ['conversations', pid],
    queryFn: () => conversationsApi.list(pid),
    enabled: !!pid,
  })

  const { data: textColumnsData } = useQuery({
    queryKey: ['qual-text-columns', pid],
    queryFn: () => codeAnalysisApi.textColumnsWithCoding(pid),
    enabled: !!pid,
  })

  const { data: documentsData } = useQuery({
    queryKey: ['documents', pid],
    queryFn: () => documentsApi.list(pid),
    enabled: !!pid,
  })

  // Palette queries
  const { data: collectionsData } = useQuery({
    queryKey: ['material-collections', pid],
    queryFn: () => materialsApi.list(pid),
    enabled: !!pid,
  })

  const defaultPalette = collectionsData?.collections?.[0] ?? null
  const defaultCollectionId = defaultPalette?.id ?? null
  // Lazily creates the default "Materials" collection on first save for a
  // collection-less project so "Add to Materials" is never a dead-end (#469b).
  const ensureCollectionId = useEnsureMaterialCollection(pid, defaultCollectionId)

  const { data: collectionDetail } = useQuery({
    queryKey: ['material-collection-detail', pid, defaultCollectionId],
    queryFn: () => materialsApi.get(pid, defaultCollectionId!),
    enabled: !!pid && !!defaultCollectionId,
  })

  const materials = collectionDetail?.materials ?? []

  // Auto-load material when navigating from canvas with ?element=ID
  const autoLoadedRef = useRef<number | null>(null)
  useEffect(() => {
    if (!qa.activeMaterialId || !materials.length) return
    if (qa.selectedCodeIds.size > 0) return // already has chart state
    if (autoLoadedRef.current === qa.activeMaterialId) return
    const el = materials.find(e => e.id === qa.activeMaterialId)
    if (el) {
      autoLoadedRef.current = qa.activeMaterialId
      qa.loadMaterial(el)
    }
  }, [qa.activeMaterialId, materials, qa.selectedCodeIds.size, qa.loadMaterial]) // eslint-disable-line react-hooks/exhaustive-deps

  // Build filter params for existing endpoints
  const filterParams: CodeAnalysisFilterParams = useMemo(() => ({
    exclude_facilitator: qa.excludeFacilitator,
    conversation_ids: qa.selectedConversationIds.size > 0 ? Array.from(qa.selectedConversationIds).join(',') : undefined,
    participant_ids: qa.participantIds.length > 0 ? qa.participantIds.join(',') : undefined,
    text_column_ids: qa.selectedTextColumnIds.size > 0 ? Array.from(qa.selectedTextColumnIds).join(',') : undefined,
    document_ids: qa.selectedDocumentIds.size > 0 ? Array.from(qa.selectedDocumentIds).join(',') : undefined,
    source: qa.source,
    level: qa.tab === 'relationships' ? qa.cooccurrenceLevel : undefined,
    coder_ids: effectiveCoderIncludeCsv,
    layer_scope: qa.layerScope,
  }), [qa.excludeFacilitator, qa.selectedConversationIds, qa.participantIds, qa.selectedTextColumnIds, qa.selectedDocumentIds, qa.source, qa.tab, qa.cooccurrenceLevel, effectiveCoderIncludeCsv, qa.layerScope])

  const quoteFilterParams = useMemo(() => ({
    participant_ids: qa.participantIds.length > 0 ? qa.participantIds.join(',') : undefined,
  }), [qa.participantIds])

  // Lift quote query so sidebar can filter sources to only those with quotes
  const { data: quoteData } = useQuery({
    queryKey: ['excerpts-quoted', pid, ...Object.values(quoteFilterParams).filter(Boolean)],
    queryFn: () => excerptsApi.listQuoted(pid, quoteFilterParams),
    enabled: !!pid && qa.tab === 'quoteboard',
  })

  const { data: freqData } = useQuery({
    queryKey: ['code-frequencies', pid, qa.excludeFacilitator, Array.from(qa.selectedConversationIds).join(','), qa.participantIds.join(','), qa.source, Array.from(qa.selectedTextColumnIds).join(','), Array.from(qa.selectedDocumentIds).join(','), effectiveCoderIncludeCsv ?? '', qa.layerScope],
    queryFn: () => codeAnalysisApi.frequencies(pid, filterParams),
    enabled: !!pid,
  })

  // Source frequencies for Descriptives charts (heatmap, bar, stacked bar, summary)
  const sourceFreqRequest: SourceFrequenciesRequest = useMemo(() => ({
    code_ids: qa.selectedCodeIds.size > 0 ? Array.from(qa.selectedCodeIds) : [],
    conversation_ids: qa.selectedConversationIds.size > 0 ? Array.from(qa.selectedConversationIds) : [],
    text_column_ids: qa.selectedTextColumnIds.size > 0 ? Array.from(qa.selectedTextColumnIds) : [],
    document_ids: qa.selectedDocumentIds.size > 0 ? Array.from(qa.selectedDocumentIds) : [],
    exclude_facilitator: qa.excludeFacilitator,
    participant_ids: qa.participantIds.length > 0 ? qa.participantIds : undefined,
    group_by_subtype: qa.chartType === 'bar' && qa.groupBy ? qa.groupBy : undefined,
    aggregation: qa.codeMode === 'categories' ? 'category' : undefined,
    coder_ids: effectiveCoderInclude.length ? effectiveCoderInclude : null,
    layer_scope: qa.layerScope,
  }), [qa.selectedCodeIds, qa.selectedConversationIds, qa.selectedTextColumnIds, qa.selectedDocumentIds, qa.excludeFacilitator, qa.participantIds, qa.chartType, qa.groupBy, qa.codeMode, effectiveCoderInclude, qa.layerScope])

  const { data: sourceFreqData, isLoading: sourceFreqLoading } = useQuery({
    queryKey: ['qual-source-frequencies', pid,
      Array.from(qa.selectedCodeIds).sort().join(','),
      Array.from(qa.selectedConversationIds).sort().join(','),
      Array.from(qa.selectedTextColumnIds).sort().join(','),
      Array.from(qa.selectedDocumentIds).sort().join(','),
      qa.excludeFacilitator,
      qa.participantIds.join(','),
      qa.chartType === 'bar' ? qa.groupBy : null,
      qa.codeMode,
      effectiveCoderIncludeCsv ?? '',
      qa.layerScope,
    ],
    queryFn: () => codeAnalysisApi.sourceFrequencies(pid, sourceFreqRequest),
    enabled: !!pid && qa.tab === 'descriptives' && qa.chartType !== 'saturation'
      && qa.selectedCodeIds.size > 0
      && (qa.selectedConversationIds.size > 0 || qa.selectedTextColumnIds.size > 0 || qa.selectedDocumentIds.size > 0),
  })

  // Saturation query
  const { data: saturationData, isLoading: saturationLoading } = useQuery({
    queryKey: ['qual-saturation', pid, qa.excludeFacilitator, qa.codeMode === 'categories',
      Array.from(qa.selectedConversationIds).sort().join(','),
      Array.from(qa.selectedDocumentIds).sort().join(','),
      effectiveCoderIncludeCsv ?? '',
      qa.layerScope,
    ],
    queryFn: () => codeAnalysisApi.saturation(pid, {
      exclude_facilitator: qa.excludeFacilitator,
      category_level: qa.codeMode === 'categories',
      conversation_ids: qa.selectedConversationIds.size > 0 ? Array.from(qa.selectedConversationIds).join(',') : undefined,
      document_ids: qa.selectedDocumentIds.size > 0 ? Array.from(qa.selectedDocumentIds).join(',') : undefined,
      coder_ids: effectiveCoderIncludeCsv,
      layer_scope: qa.layerScope,
    }),
    enabled: !!pid && qa.tab === 'descriptives' && qa.chartType === 'saturation',
  })

  // Demographic filters for comparison group-by dropdown
  const { data: demoFiltersData } = useQuery({
    queryKey: ['demographic-filters', pid],
    queryFn: () => codeAnalysisApi.demographicFilters(pid),
    enabled: !!pid,
  })

  const demoFilters = demoFiltersData?.filters ?? []

  // Demographic comparison query
  const comparisonRequest: DemographicComparisonRequest | null = useMemo(() => {
    if (!qa.groupBy) return null
    return {
      group_by_subtype: qa.groupBy,
      code_ids: qa.selectedCodeIds.size > 0 ? Array.from(qa.selectedCodeIds) : undefined,
      conversation_ids: qa.selectedConversationIds.size > 0 ? Array.from(qa.selectedConversationIds) : undefined,
      text_column_ids: qa.selectedTextColumnIds.size > 0 ? Array.from(qa.selectedTextColumnIds) : undefined,
      exclude_facilitator: qa.excludeFacilitator,
      participant_ids: qa.participantIds.length > 0 ? qa.participantIds : undefined,
      coder_ids: effectiveCoderInclude.length ? effectiveCoderInclude : null,
      layer_scope: qa.layerScope,
    }
  }, [qa.groupBy, qa.selectedCodeIds, qa.selectedConversationIds, qa.selectedTextColumnIds, qa.excludeFacilitator, qa.participantIds, effectiveCoderInclude, qa.layerScope])

  const { data: comparisonData, isLoading: comparisonLoading } = useQuery({
    queryKey: [
      'qual-demographic-comparison', pid,
      qa.groupBy,
      Array.from(qa.selectedCodeIds).sort().join(','),
      Array.from(qa.selectedConversationIds).sort().join(','),
      Array.from(qa.selectedTextColumnIds).sort().join(','),
      qa.excludeFacilitator,
      qa.participantIds.join(','),
      effectiveCoderIncludeCsv ?? '',
      qa.layerScope,
    ],
    queryFn: () => codeAnalysisApi.demographicComparison(pid, comparisonRequest!),
    enabled: !!pid && qa.tab === 'relationships' && qa.relView === 'comparisons' && !!comparisonRequest,
  })

  // Co-occurrence N (reported by QualCooccurrence via onDataLoad callback)
  const [cooccurrenceN, setCooccurrenceN] = useState<number | null>(null)

  const codes = useMemo(() => codesData?.codes ?? [], [codesData?.codes])
  const categories = categoriesData?.categories ?? []
  const conversations = useMemo(() => conversationsData?.conversations ?? [], [conversationsData?.conversations])
  const textColumns: TextColumnInfo[] = useMemo(() => textColumnsData ?? [], [textColumnsData])
  const documents: DocumentListItem[] = useMemo(() => documentsData ?? [], [documentsData])

  // QB: filter sources to only those with quoted excerpts
  const qbConversations = useMemo(() => {
    if (!quoteData) return conversations
    const ids = new Set(quoteData.excerpts.filter(e => e.conversation_id).map(e => e.conversation_id!))
    return conversations.filter(c => ids.has(c.id))
  }, [conversations, quoteData])

  const qbTextColumns = useMemo(() => {
    if (!quoteData) return textColumns
    const ids = new Set(quoteData.excerpts.filter(e => e.column_id).map(e => e.column_id!))
    return textColumns.filter(c => ids.has(c.column_id))
  }, [textColumns, quoteData])

  const qbDocuments = useMemo(() => {
    if (!quoteData) return documents
    const ids = new Set(quoteData.excerpts.filter(e => e.document_id).map(e => e.document_id!))
    return documents.filter(d => ids.has(d.id))
  }, [documents, quoteData])

  // Content tab: filter codes and sources by Lens/Sources sidebar selections
  // On Content tab, empty selection = nothing shown (user must check items).
  // On other tabs, empty selection = show all (legacy behavior).
  const isContentTab = qa.tab === 'content'

  const contentCodes = useMemo(() => {
    if (qa.selectedCodeIds.size === 0) return isContentTab ? [] : codes
    return codes.filter(c => qa.selectedCodeIds.has(c.id))
  }, [codes, qa.selectedCodeIds, isContentTab])

  const contentConversations = useMemo(() => {
    if (qa.selectedConversationIds.size === 0) return isContentTab ? [] : conversations
    return conversations.filter(c => qa.selectedConversationIds.has(c.id))
  }, [conversations, qa.selectedConversationIds, isContentTab])

  const contentTextColumns = useMemo(() => {
    if (qa.selectedTextColumnIds.size === 0) return isContentTab ? [] : textColumns
    return textColumns.filter(c => qa.selectedTextColumnIds.has(c.column_id))
  }, [textColumns, qa.selectedTextColumnIds, isContentTab])

  const contentDocuments = useMemo(() => {
    if (qa.selectedDocumentIds.size === 0) return isContentTab ? [] : documents
    return documents.filter(d => qa.selectedDocumentIds.has(d.id))
  }, [documents, qa.selectedDocumentIds, isContentTab])

  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- freqData?.frequencies is intentionally more specific than freqData
  const contentFrequencies = useMemo(() => {
    if (!freqData?.frequencies) return undefined
    if (qa.selectedCodeIds.size === 0) return isContentTab ? [] : freqData.frequencies
    return freqData.frequencies.filter(f => qa.selectedCodeIds.has(f.code_id))
  }, [freqData?.frequencies, qa.selectedCodeIds, isContentTab])

  // Auto-clear drilled Content state when sidebar selection removes the active item
  useEffect(() => {
    if (qa.contentCodeId != null && qa.selectedCodeIds.size > 0 && !qa.selectedCodeIds.has(qa.contentCodeId)) {
      qa.setContentCodeId(null)
    }
  }, [qa.contentCodeId, qa.selectedCodeIds]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!qa.contentSource) return
    if (qa.contentSource.startsWith('c:')) {
      const id = Number(qa.contentSource.slice(2))
      if (qa.selectedConversationIds.size > 0 && !qa.selectedConversationIds.has(id)) {
        qa.setContentSource(null)
      }
    } else if (qa.contentSource.startsWith('cc:')) {
      const id = Number(qa.contentSource.slice(3))
      if (qa.selectedTextColumnIds.size > 0 && !qa.selectedTextColumnIds.has(id)) {
        qa.setContentSource(null)
      }
    } else if (qa.contentSource.startsWith('d:')) {
      const id = Number(qa.contentSource.slice(2))
      if (qa.selectedDocumentIds.size > 0 && !qa.selectedDocumentIds.has(id)) {
        qa.setContentSource(null)
      }
    }
  }, [qa.contentSource, qa.selectedConversationIds, qa.selectedTextColumnIds, qa.selectedDocumentIds]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-select all codes and sources when entering Content tab with empty selections.
  // Includes data arrays so auto-select fires when data arrives after tab switch.
  useEffect(() => {
    if (qa.tab !== 'content') return
    if (qa.selectedCodeIds.size === 0 && codes.length > 0) {
      qa.setSelectedCodeIds(new Set(codes.filter(c => c.is_active).map(c => c.id)))
    }
    if (qa.selectedConversationIds.size === 0 && conversations.length > 0) {
      qa.setSelectedConversationIds(new Set(conversations.map(c => c.id)))
    }
    if (qa.selectedTextColumnIds.size === 0 && textColumns.length > 0) {
      qa.setSelectedTextColumnIds(new Set(textColumns.map(c => c.column_id)))
    }
    if (qa.selectedDocumentIds.size === 0 && documents.length > 0) {
      qa.setSelectedDocumentIds(new Set(documents.map(d => d.id)))
    }
  }, [qa.tab, codes.length, conversations.length, textColumns.length, documents.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Focus mode (Quote Board + Content tab) ─────────────────────────
  const focusedCode = useMemo(
    () => focusedCodeId != null ? codes.find(c => c.id === focusedCodeId) : undefined,
    [focusedCodeId, codes],
  )
  const focusedCodeColor = focusedCode ? getCodeColor(focusedCode) : '#6b7280'

  const handleFocusCode = useCallback((codeId: number) => {
    setFocusedCodeId(prev => {
      const next = prev === codeId ? null : codeId
      const codeName = codes.find(c => c.id === codeId)?.name
      if (next != null && codeName) {
        setSrAnnouncement(`Highlighting items with code: ${codeName}`)
      } else {
        setSrAnnouncement('Focus cleared, showing all items')
      }
      return next
    })
  }, [codes, setSrAnnouncement])

  // Auto-clear focus when leaving custom sort (Quote Board only)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset local focus state when sort/tab changes
    if (qa.quoteSort !== 'custom' && qa.tab === 'quoteboard') setFocusedCodeId(null)
  }, [qa.quoteSort, qa.tab])

  // Auto-clear focus when switching tabs
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset local focus state on tab switch
    setFocusedCodeId(null)
  }, [qa.tab])

  // Escape key clears focus
  useEffect(() => {
    if (focusedCodeId == null) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setFocusedCodeId(null)
        setSrAnnouncement('Focus cleared, showing all items')
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [focusedCodeId, setSrAnnouncement])

  // ── Material mutations ────────────────────────────────────────────────

  const addToMaterialsMutation = useMutation({
    mutationFn: ({ collectionId, ...data }: { collectionId: number; material_type: string; config: Record<string, unknown>; auto_name: string; source_tab?: string }) =>
      materialsApi.createMaterial(pid, collectionId, data),
    onSuccess: (created) => {
      // Scope to the project (not a specific collectionId) so this still invalidates
      // the right detail query when the collection was lazily created this save (#469b).
      queryClient.invalidateQueries({ queryKey: ['material-collection-detail', pid] })
      queryClient.invalidateQueries({ queryKey: ['material-collections', pid] })
      qa.setUrlParam('element', '')  // clear any legacy alias
      qa.setUrlParam('material', String(created.id))
      toast.success('Added to Materials')
    },
    onError: () => toast.error('Failed to save material'),
  })

  const renameMaterialMutation = useMutation({
    mutationFn: ({ materialId, name }: { materialId: number; name: string }) =>
      materialsApi.updateMaterial(pid, defaultCollectionId!, materialId, { custom_name: name || null }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['material-collection-detail', pid, defaultCollectionId] })
      queryClient.invalidateQueries({ queryKey: ['materials-all', pid] })
    },
  })

  const deleteMaterialMutation = useMutation({
    mutationFn: (materialId: number) =>
      materialsApi.deleteMaterial(pid, defaultCollectionId!, materialId),
    onSuccess: (_, deletedId) => {
      queryClient.invalidateQueries({ queryKey: ['material-collection-detail', pid, defaultCollectionId] })
      queryClient.invalidateQueries({ queryKey: ['material-collections', pid] })
      if (qa.activeMaterialId === deletedId) {
        qa.setUrlParam('material', '')
        qa.setUrlParam('element', '')  // legacy alias
      }
    },
    onError: () => toast.error('Failed to delete material'),
  })

  const sendToCanvasMut = useMutation({
    mutationFn: ({ canvasId, el }: { canvasId: number; el: MaterialResponse }) =>
      canvasApi.addPendingItem(pid, canvasId, {
        item_type: 'material',
        source_id: el.id,
      }),
    onSuccess: (_data, vars) => {
      toast.success('Added to canvas')
      queryClient.invalidateQueries({ queryKey: ['canvas', pid, vars.canvasId] })
    },
  })

  const handleSendMaterialToCanvas = useCallback((el: MaterialResponse, canvasId: number) => {
    sendToCanvasMut.mutate({ canvasId, el })
  }, [sendToCanvasMut])

  const handleSendMaterialToNewCanvas = useCallback(async (el: MaterialResponse, canvasName: string) => {
    const canvas = await canvasApi.create(pid, canvasName)
    queryClient.invalidateQueries({ queryKey: ['canvases', pid] })
    sendToCanvasMut.mutate({ canvasId: canvas.id, el })
  }, [pid, queryClient, sendToCanvasMut])

  const sendExcerptToCanvasMut = useMutation({
    mutationFn: ({ canvasId, excerptId }: { canvasId: number; excerptId: number }) =>
      canvasApi.addPendingItem(pid, canvasId, {
        item_type: 'excerpt',
        source_id: excerptId,
      }),
    onSuccess: (_data, vars) => {
      toast.success('Excerpt added to canvas')
      queryClient.invalidateQueries({ queryKey: ['canvas', pid, vars.canvasId] })
    },
  })

  const handleSendExcerptToCanvas = useCallback((excerptId: number, canvasId: number) => {
    sendExcerptToCanvasMut.mutate({ canvasId, excerptId })
  }, [sendExcerptToCanvasMut])

  const handleSendExcerptToNewCanvas = useCallback(async (excerptId: number, canvasName: string) => {
    const canvas = await canvasApi.create(pid, canvasName)
    queryClient.invalidateQueries({ queryKey: ['canvases', pid] })
    sendExcerptToCanvasMut.mutate({ canvasId: canvas.id, excerptId })
  }, [pid, queryClient, sendExcerptToCanvasMut])

  // ── Derived values ────────────────────────────────────────────────────

  const generateAutoName = useCallback(() => {
    const selectedCount = qa.selectedCodeIds.size
    if (selectedCount === 0) return 'All codes'
    if (selectedCount === 1) {
      const codeId = Array.from(qa.selectedCodeIds)[0]
      const code = codes.find(c => c.id === codeId)
      return code?.name ?? 'Analysis'
    }
    return `${selectedCount} codes`
  }, [qa.selectedCodeIds, codes])

  const getMaterialType = useCallback(() => {
    if (qa.tab === 'descriptives') {
      const typeMap: Record<string, string> = { bar: 'qual_bar_chart' }
      return typeMap[qa.chartType] ?? `qual_${qa.chartType}`
    }
    if (qa.tab === 'relationships') {
      if (qa.relView === 'cooccurrence') return 'qual_cooccurrence'
      return qa.comparisonChartMode === 'bar' ? 'qual_comparison_bar' : 'qual_comparison_table'
    }
    return 'qual_content'
  }, [qa.tab, qa.chartType, qa.relView, qa.comparisonChartMode])

  const getSourceTab = useCallback(() => {
    if (qa.tab === 'relationships') return qa.relView === 'cooccurrence' ? 'qualitative_relationships' : 'qualitative_comparisons'
    return `qualitative_${qa.tab}`
  }, [qa.tab, qa.relView])

  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- qa.buildCurrentConfig is stable but compiler infers full qa object
  const handleAddToMaterials = useCallback(async () => {
    const collectionId = await ensureCollectionId()
    const config = qa.buildCurrentConfig()
    addToMaterialsMutation.mutate({
      collectionId,
      material_type: getMaterialType(),
      config,
      auto_name: generateAutoName(),
      source_tab: getSourceTab(),
    })
  }, [ensureCollectionId, qa.buildCurrentConfig, addToMaterialsMutation, getMaterialType, generateAutoName, getSourceTab]) // eslint-disable-line react-hooks/exhaustive-deps -- qa destructured access; individual properties listed

  const handleDescriptivesExport = useCallback(() => {
    const params: Record<string, string> = {}
    if (qa.selectedCodeIds.size > 0) params.code_ids = Array.from(qa.selectedCodeIds).join(',')
    if (qa.selectedConversationIds.size > 0) params.conversation_ids = Array.from(qa.selectedConversationIds).join(',')
    if (qa.selectedTextColumnIds.size > 0) params.text_column_ids = Array.from(qa.selectedTextColumnIds).join(',')
    if (qa.selectedDocumentIds.size > 0) params.document_ids = Array.from(qa.selectedDocumentIds).join(',')
    if (qa.excludeFacilitator) params.exclude_facilitator = 'true'
    if (qa.participantIds.length > 0) params.participant_ids = qa.participantIds.join(',')
    // #499: carry the EFFECTIVE (blind-forced) coder/layer scope so the CSV
    // matches the on-screen numbers.
    if (effectiveCoderIncludeCsv) params.coder_ids = effectiveCoderIncludeCsv
    if (qa.layerScope) params.layer_scope = qa.layerScope
    exportApi.sourceFrequenciesCsv(pid, params)
  }, [pid, qa.selectedCodeIds, qa.selectedConversationIds, qa.selectedTextColumnIds, qa.selectedDocumentIds, qa.excludeFacilitator, qa.participantIds, effectiveCoderIncludeCsv, qa.layerScope])

  const conversationSourceCount = useMemo(
    () => conversations.filter(c => qa.selectedConversationIds.size === 0 || qa.selectedConversationIds.has(c.id)).length,
    [conversations, qa.selectedConversationIds],
  )

  // N values for Chart N display
  const descriptivesN = sourceFreqData?.totals?.coded_segments ?? null
  const comparisonN = useMemo(() => {
    if (!comparisonData?.group_totals) return null
    return Object.values(comparisonData.group_totals)
      .reduce((sum, g) => sum + g.total_segments, 0)
  }, [comparisonData])

  const handleCooccurrenceDataLoad = useCallback((info: { totalSegments: number; totalComments: number }) => {
    setCooccurrenceN(info.totalSegments + info.totalComments)
  }, [])

  const handleCodeChange = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['excerpts-quoted', pid] })
    queryClient.invalidateQueries({ queryKey: ['code-frequencies', pid] })
    queryClient.invalidateQueries({ queryKey: ['codes', pid] })
    queryClient.invalidateQueries({ queryKey: ['code-segments-context', pid] })
    queryClient.invalidateQueries({ queryKey: ['code-texts-context', pid] })
    queryClient.invalidateQueries({ queryKey: ['conversation-segments-readonly', pid] })
    queryClient.invalidateQueries({ queryKey: ['text-column-readonly', pid] })
    invalidateDerivedCounts(queryClient, pid, { metrics: true })  // #450: cross-surface counts (Content tab codes text + segments)
  }, [queryClient, pid])

  const hasActiveQbFilters = qa.qbHiddenCodeIds.size > 0 || qa.qbHideUncoded || qa.qbHiddenConversationIds.size > 0 || qa.qbHiddenTextColumnIds.size > 0 || qa.qbHiddenDocumentIds.size > 0
  const qbFilterCount = qa.qbHiddenCodeIds.size + qa.qbHiddenConversationIds.size + qa.qbHiddenTextColumnIds.size + qa.qbHiddenDocumentIds.size + (qa.qbHideUncoded ? 1 : 0)

  // ── Tab navigation ────────────────────────────────────────────────────

  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- qa.tab/qa.setTab are stable but compiler infers full qa object
  const handleTabKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    const idx = visibleTabs.findIndex(t => t.id === qa.tab)
    let next: typeof visibleTabs[number] | undefined
    switch (e.key) {
      case 'ArrowRight':
        next = visibleTabs[(idx + 1) % visibleTabs.length]
        break
      case 'ArrowLeft':
        next = visibleTabs[(idx - 1 + visibleTabs.length) % visibleTabs.length]
        break
      case 'Home':
        next = visibleTabs[0]
        break
      case 'End':
        next = visibleTabs[visibleTabs.length - 1]
        break
      default:
        return
    }
    e.preventDefault()
    qa.setTab(next.id)
    setSrAnnouncement(`${next.label} tab selected`)
    const target = (e.currentTarget as HTMLDivElement).querySelector(`[data-tab="${next.id}"]`) as HTMLButtonElement | null
    target?.focus()
  }, [qa.tab, qa.setTab, visibleTabs]) // eslint-disable-line react-hooks/exhaustive-deps -- qa destructured access; individual properties listed

  // Source mode keyboard nav (for sidebar segmented control)
  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- qa.source/qa.setSource are stable but compiler infers full qa object
  const handleSourceKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    const idx = SOURCE_MODES.indexOf(qa.source)
    let next: typeof SOURCE_MODES[number] | undefined
    switch (e.key) {
      case 'ArrowRight':
        next = SOURCE_MODES[(idx + 1) % SOURCE_MODES.length]
        break
      case 'ArrowLeft':
        next = SOURCE_MODES[(idx - 1 + SOURCE_MODES.length) % SOURCE_MODES.length]
        break
      case 'Home':
        next = SOURCE_MODES[0]
        break
      case 'End':
        next = SOURCE_MODES[SOURCE_MODES.length - 1]
        break
      default:
        return
    }
    e.preventDefault()
    qa.setSource(next)
    setSrAnnouncement(`Showing ${next === 'all' ? 'all sources' : next}`)
    const target = (e.currentTarget as HTMLDivElement).querySelector(`[data-source="${next}"]`) as HTMLButtonElement | null
    target?.focus()
  }, [qa.source, qa.setSource]) // eslint-disable-line react-hooks/exhaustive-deps -- qa destructured access; individual properties listed


  const handleComparisonExport = useCallback(() => {
    if (!qa.groupBy) return
    const params: Record<string, string> = { group_by_subtype: qa.groupBy }
    if (qa.selectedCodeIds.size > 0) params.code_ids = Array.from(qa.selectedCodeIds).join(',')
    if (qa.selectedConversationIds.size > 0) params.conversation_ids = Array.from(qa.selectedConversationIds).join(',')
    if (qa.selectedTextColumnIds.size > 0) params.text_column_ids = Array.from(qa.selectedTextColumnIds).join(',')
    if (qa.excludeFacilitator) params.exclude_facilitator = 'true'
    if (qa.participantIds.length > 0) params.participant_ids = qa.participantIds.join(',')
    // #499: carry the EFFECTIVE (blind-forced) coder/layer scope so the CSV
    // matches the on-screen numbers.
    if (effectiveCoderIncludeCsv) params.coder_ids = effectiveCoderIncludeCsv
    if (qa.layerScope) params.layer_scope = qa.layerScope
    exportApi.demographicComparisonCsv(pid, params)
  }, [pid, qa.groupBy, qa.selectedCodeIds, qa.selectedConversationIds, qa.selectedTextColumnIds, qa.excludeFacilitator, qa.participantIds, effectiveCoderIncludeCsv, qa.layerScope])

  // Content mode keyboard nav
  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- qa.contentMode/qa.setContentMode are stable but compiler infers full qa object
  const handleContentModeKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    const idx = CONTENT_MODES.indexOf(qa.contentMode)
    let next: QualContentMode | undefined
    switch (e.key) {
      case 'ArrowRight':
        next = CONTENT_MODES[(idx + 1) % CONTENT_MODES.length]
        break
      case 'ArrowLeft':
        next = CONTENT_MODES[(idx - 1 + CONTENT_MODES.length) % CONTENT_MODES.length]
        break
      case 'Home':
        next = CONTENT_MODES[0]
        break
      case 'End':
        next = CONTENT_MODES[CONTENT_MODES.length - 1]
        break
      default:
        return
    }
    e.preventDefault()
    qa.setContentMode(next)
    setSrAnnouncement(`${CONTENT_MODE_LABELS[next]} selected`)
    const target = (e.currentTarget as HTMLDivElement).querySelector(`[data-contentmode="${next}"]`) as HTMLElement | null
    target?.focus()
  }, [qa.contentMode, qa.setContentMode]) // eslint-disable-line react-hooks/exhaustive-deps -- qa destructured access; individual properties listed

  // Screen reader announcements for chart type / value mode / orientation changes
  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- qa.setChartType is stable but compiler infers full qa object
  const handleChartTypeChange = useCallback((type: typeof qa.chartType) => {
    qa.setChartType(type)
    setSrAnnouncement(`Chart type changed to ${CHART_TYPE_LABELS[type] || type}`)
  }, [qa.setChartType]) // eslint-disable-line react-hooks/exhaustive-deps -- qa destructured access
  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- qa.setValueMode is stable but compiler infers full qa object
  const handleValueModeChange = useCallback((mode: typeof qa.valueMode) => {
    qa.setValueMode(mode)
    const labels: Record<string, string> = { count: 'Count', segment_proportion: 'Proportion', text_coverage: 'Word Coverage' }
    setSrAnnouncement(`Value mode changed to ${labels[mode] || mode}`)
  }, [qa.setValueMode]) // eslint-disable-line react-hooks/exhaustive-deps -- qa destructured access
  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- qa.setOrientation is stable but compiler infers full qa object
  const handleOrientationChange = useCallback((orient: typeof qa.orientation) => {
    qa.setOrientation(orient)
    setSrAnnouncement(`Orientation changed to ${orient === 'sources-rows' ? 'sources as rows' : 'codes as rows'}`)
  }, [qa.setOrientation]) // eslint-disable-line react-hooks/exhaustive-deps -- qa destructured access

  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- qa.setContentCodeId is stable but compiler infers full qa object
  const handleContentCodeSelect = useCallback((codeId: number) => {
    if (codeId === 0) {
      qa.setContentCodeId(null)
    } else {
      qa.setContentCodeId(codeId)
    }
  }, [qa.setContentCodeId]) // eslint-disable-line react-hooks/exhaustive-deps -- qa destructured access

  // ── Loading state ─────────────────────────────────────────────────────

  if (codesLoading || convsLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-mm-text-muted">Loading...</p>
      </div>
    )
  }

  // ── Empty states ──────────────────────────────────────────────────────

  const hasActiveCode = codes.some(c => c.is_active)
  if (conversations.length === 0 && !hasActiveCode) {
    return (
      <div className="h-full">
        <div className="max-w-md mx-auto mt-24 text-center">
          <p className="text-mm-text-muted">No conversations or coded text yet.</p>
          <Button className="mt-4" onClick={() => navigate(`/projects/${pid}/conversations/import`)}>
            Import Conversations
          </Button>
        </div>
      </div>
    )
  }

  if (!hasActiveCode) {
    return (
      <div className="h-full">
        <div className="max-w-md mx-auto mt-24 text-center">
          <p className="text-mm-text-muted">No codes created yet. Start coding conversations or text to see analysis.</p>
        </div>
      </div>
    )
  }

  const hasCoding = freqData && (freqData.total_coded_segments > 0 || freqData.total_coded_texts > 0)
  const hasCodeSelection = qa.selectedCodeIds.size > 0
  const hasSourceSelection = qa.selectedConversationIds.size > 0 || qa.selectedTextColumnIds.size > 0 || qa.selectedDocumentIds.size > 0
  const hasQualSelection = hasCodeSelection && hasSourceSelection
  const hasDemographicFilters = demoFilters.length > 0

  // Determine content code ID (from hook or from palette)

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="bg-mm-surface border-b px-4 py-3 flex items-center gap-3 flex-shrink-0">
        <h1 className="text-lg font-semibold">
          {qa.activeMaterialId
            ? (materials.find(e => e.id === qa.activeMaterialId)?.custom_name
              || materials.find(e => e.id === qa.activeMaterialId)?.auto_name
              || 'Qualitative Analysis')
            : 'Qualitative Analysis'
          }
        </h1>
        <div className="flex-1" />
        {/* Coding-layer selector (Track J · J2-5) — offered only when a consensus
            layer exists for this project (DEC-A); it also surfaces which layer is active. */}
        {multiCoder && consensusAvailable && qa.tab !== 'reconciliation' && qa.tab !== 'irr' && (
          <div className="flex items-center gap-2">
            <SegmentedControl
              options={([
                { value: 'human', label: 'Coders' },
                { value: 'consensus', label: 'Consensus' },
              ] as { value: 'human' | 'consensus'; label: string }[])}
              value={qa.layerScope}
              onChange={qa.setLayerScope}
              ariaLabel="Coding layer"
              idPrefix="layer"
            />
            {qa.layerScope === 'consensus' && (consensusStatus?.stale_count ?? 0) > 0 && (
              <span
                className="inline-flex items-center gap-1 text-xs text-mm-text-muted"
                title="Recent coding changed; the consensus layer is recomputing in the background."
              >
                <Clock className="w-3.5 h-3.5" aria-hidden="true" />
                Consensus may be out of date
              </span>
            )}
          </div>
        )}
        {/* Per-coder visibility filter (Track J · J1) — moot on the single consensus layer (UX-2)
            and on Reconciliation (which shows every coder + consensus side-by-side). */}
        {multiCoder && !blind && qa.layerScope !== 'consensus' && qa.tab !== 'reconciliation' && qa.tab !== 'irr' && (
          <CoderFilterPopover
            coders={coders}
            activeCoderId={user?.id ?? null}
            hidden={hiddenCoders}
            onChange={handleCoderFilterChange}
          />
        )}
        {/* Blind-mode toggle (DEC-G): while blind, analysis shows self-only + the
            comparison tabs are hidden; revealing here un-blinds everywhere + logs. */}
        {multiCoder && <BlindModeToggle blind={blind} onToggle={toggleReveal} surface="analysis" />}
        <Button variant="ghost" size="sm" className="text-mm-text-muted" onClick={openCodebook}>
          <BookOpen className="w-4 h-4 mr-1" />
          Codebook
        </Button>
        {qa.tab !== 'quoteboard' && qa.tab !== 'reconciliation' && qa.tab !== 'irr' && (
          <Button variant="outline" size="sm" onClick={() => exportApi.codeFrequencies(pid, filterParams)} title="Export code frequencies as CSV">
            <Download className="w-3 h-3 mr-1" /> Export CSV
          </Button>
        )}
        {qa.tab !== 'content' && qa.tab !== 'quoteboard' && qa.tab !== 'reconciliation' && qa.tab !== 'irr' && (
          <Button size="sm" onClick={handleAddToMaterials} disabled={addToMaterialsMutation.isPending}>
            <SwatchBook className="w-3 h-3 mr-1" />
            Add to Materials
          </Button>
        )}
      </div>

      {/* Tab bar */}
      <div
        className="bg-mm-surface border-b px-6 flex items-end gap-0 flex-shrink-0"
        role="tablist"
        aria-label="Analysis view"
        onKeyDown={handleTabKeyDown}
      >
        {visibleTabs.map(t => {
          const isActive = qa.tab === t.id
          return (
            <button
              key={t.id}
              id={`tab-${t.id}`}
              role="tab"
              data-tab={t.id}
              aria-selected={isActive}
              aria-controls="qual-tabpanel"
              tabIndex={isActive ? 0 : -1}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${
                isActive
                  ? 'border-mm-accent text-mm-text'
                  : 'border-transparent text-mm-text-muted hover:text-mm-text-secondary hover:border-mm-border-subtle'
              }`}
              onClick={() => { qa.setTab(t.id); setSrAnnouncement(`${t.label} tab selected`) }}
            >
              {t.label}
            </button>
          )
        })}
      </div>

      {/* Screen reader announcements */}
      <div aria-live="polite" className="sr-only">{srAnnouncement}</div>

      {/* Body — Reconciliation/Reliability hide every sidebar section, so bypass the
          PanelGroup entirely on those tabs and use the full width instead of reserving
          an empty ~22% gutter (#442). Bypassing (vs conditionally dropping the sidebar
          Panel) keeps react-resizable-panels' persisted layout intact for the other tabs. */}
      {qa.tab === 'reconciliation' || qa.tab === 'irr' ? (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex-1 overflow-y-auto p-4" role="tabpanel" id="qual-tabpanel" aria-labelledby={`tab-${qa.tab}`}>
            {qa.tab === 'reconciliation' ? (
              <ReconciliationGrid
                projectId={pid}
                codes={codes}
                currentUserId={user?.id ?? null}
                staleCount={consensusStatus?.stale_count ?? 0}
                setSrAnnouncement={setSrAnnouncement}
              />
            ) : (
              <IrrMatrix projectId={pid} codes={codes} />
            )}
          </div>
        </div>
      ) : (
      <PanelGroup
        orientation="horizontal"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
        className="flex-1"
      >
        {/* Sidebar */}
        <Panel id="sidebar" defaultSize="22" minSize="15" maxSize="32">
          <div className="h-full bg-mm-surface border-r flex flex-col overflow-y-auto">
            {/* Section 1: Palette (hidden on Quote Board) */}
            {qa.tab !== 'quoteboard' && <div className={`border-b shrink-0 ${materialsOpen ? 'max-h-[200px]' : ''}`}>
              <button
                className={`w-full flex items-center gap-1.5 px-3 py-2 bg-mm-bg hover:bg-mm-surface-hover border-b text-sm font-medium transition-colors shrink-0 ${materialsOpen ? 'text-mm-blue-text' : 'text-mm-text'}`}
                onClick={() => setMaterialsOpen(prev => !prev)}
                aria-expanded={materialsOpen}
              >
                <ChevronDown className={`w-4 h-4 text-mm-text-muted transition-transform ${!materialsOpen ? '-rotate-90' : ''}`} aria-hidden="true" />
                <SwatchBook className="w-4 h-4 text-mm-text-muted" />
                Materials
                <span className="text-xs text-mm-text-faint ml-auto">{materials.length}</span>
              </button>
              {materialsOpen && (
                <div className="p-2">
                  {materials.length === 0 ? (
                    <div className="text-xs text-mm-text-faint py-1 px-1">
                      Use &ldquo;Add to Materials&rdquo; to save configurations
                    </div>
                  ) : (
                    <div className="space-y-0.5 max-h-[140px] overflow-y-auto">
                      {materials.map(el => (
                        <ContextMenu key={el.id}>
                          <ContextMenuTrigger asChild>
                            <button
                              className={`w-full text-left px-2 py-1.5 text-sm rounded flex items-center gap-1.5 ${
                                el.id === qa.activeMaterialId
                                  ? `${SELECTED_ROW} font-medium`
                                  : 'hover:bg-mm-surface-hover text-mm-text'
                              }`}
                              onClick={() => qa.loadMaterial(el)}
                            >
                              <SwatchBook className="w-3 h-3 flex-shrink-0" />
                              <span className="flex-1 truncate">
                                {el.custom_name || el.auto_name}
                              </span>
                              {el.source_tab !== 'descriptives' && (
                                <span className="text-[10px] text-mm-text-faint uppercase">
                                  {el.source_tab}
                                </span>
                              )}
                            </button>
                          </ContextMenuTrigger>
                          <ContextMenuContent>
                            <SendToCanvasMenu
                              projectId={pid}
                              onSend={(canvasId) => handleSendMaterialToCanvas(el, canvasId)}
                              onSendNew={(name) => handleSendMaterialToNewCanvas(el, name)}
                            />
                            <ContextMenuSeparator />
                            <ContextMenuItem
                              onClick={() => {
                                const name = window.prompt('Rename material:', el.custom_name || el.auto_name)
                                if (name != null) renameMaterialMutation.mutate({ materialId: el.id, name })
                              }}
                            >
                              <Pencil className="w-3 h-3 mr-2" /> Rename
                            </ContextMenuItem>
                            <ContextMenuItem
                              className="text-red-600"
                              onClick={() => deleteMaterialMutation.mutate(el.id)}
                            >
                              <Trash2 className="w-3 h-3 mr-2" /> Remove
                            </ContextMenuItem>
                          </ContextMenuContent>
                        </ContextMenu>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>}

            {/* Section 2: Codes (hidden on Quote Board) */}
            {qa.tab !== 'quoteboard' && <div className={`flex flex-col ${!codesOpen ? 'shrink-0' : 'flex-1 min-h-0'}`}>
              <button
                className={`w-full flex items-center gap-1.5 px-3 py-2 bg-mm-bg hover:bg-mm-surface-hover border-b text-sm font-medium transition-colors shrink-0 ${codesOpen ? 'text-mm-blue-text' : 'text-mm-text'}`}
                onClick={() => setCodesOpen(prev => !prev)}
                aria-expanded={codesOpen}
              >
                <ChevronDown className={`w-4 h-4 text-mm-text-muted transition-transform ${!codesOpen ? '-rotate-90' : ''}`} aria-hidden="true" />
                <Focus className="w-4 h-4 text-mm-text-muted" />
                Lens
                <span className="text-xs text-mm-text-faint ml-auto">{codes.filter(c => c.is_active).length}</span>
              </button>
              {codesOpen && (
                <div className="flex-1 min-h-0 pt-2">
                  <CodePicker
                    mode={qa.codeMode}
                    onModeChange={qa.setCodeMode}
                    selectedCodeIds={qa.selectedCodeIds}
                    onSelectionChange={qa.setSelectedCodeIds}
                    onViewCode={qa.viewCodeInContent}
                    codes={codes}
                    categories={categories}
                    frequencies={freqData?.frequencies}
                    source={qa.source}
                    activeTab={qa.tab}
                    projectId={pid}
                  />
                </div>
              )}
            </div>}

            {/* Section 3: Sources (hidden on Quote Board) */}
            {qa.tab !== 'quoteboard' && <div className={`border-t ${!sourcesOpen ? 'shrink-0' : 'flex-1 min-h-0 flex flex-col'}`}>
              <button
                className={`w-full flex items-center gap-1.5 px-3 py-2 bg-mm-bg hover:bg-mm-surface-hover border-b text-sm font-medium transition-colors shrink-0 ${sourcesOpen ? 'text-mm-blue-text' : 'text-mm-text'}`}
                onClick={() => setSourcesOpen(prev => !prev)}
                aria-expanded={sourcesOpen}
              >
                <ChevronDown className={`w-4 h-4 text-mm-text-muted transition-transform ${!sourcesOpen ? '-rotate-90' : ''}`} aria-hidden="true" />
                Sources
                <span className="text-xs text-mm-text-faint ml-auto">
                  {conversations.length + textColumns.length + documents.length}
                </span>
              </button>
              {sourcesOpen && (
                <div className="flex-1 min-h-0 overflow-y-auto pt-2">
                  {/* Source mode segmented control */}
                  <div className="px-3 pb-2 space-y-2">
                    <div
                      className="inline-flex rounded-md border bg-mm-bg p-0.5 w-full"
                      role="tablist"
                      aria-label="Source mode"
                      onKeyDown={handleSourceKeyDown}
                    >
                      {SOURCE_MODES.map(s => {
                        const isActive = qa.source === s
                        // #521/#520: 'conversations' mode has ALWAYS included document
                        // segments (backend source semantics) — the old "Conv." label hid
                        // documents entirely, and "Comments" was Comment→Text residue.
                        const label = s === 'all' ? 'All' : s === 'conversations' ? 'Conv. + Docs' : 'Texts'
                        const description = s === 'all'
                          ? 'All sources'
                          : s === 'conversations'
                            ? 'Conversation and document segments'
                            : 'Open-text dataset responses'
                        return (
                          <button
                            key={s}
                            role="tab"
                            data-source={s}
                            aria-selected={isActive}
                            tabIndex={isActive ? 0 : -1}
                            title={description}
                            className={`flex-1 px-2 py-1.5 text-xs rounded-sm transition-colors ${
                              isActive
                                ? 'bg-mm-surface shadow-xs text-mm-text font-medium'
                                : 'text-mm-text-muted hover:text-mm-text-secondary'
                            }`}
                            onClick={() => { qa.setSource(s); setSrAnnouncement(`Showing ${description.toLowerCase()}`) }}
                          >
                            {label}
                          </button>
                        )
                      })}
                    </div>
                    <label className={`flex items-center gap-2 text-xs ${qa.source === 'text' ? 'text-mm-text-faint' : 'text-mm-text-secondary'} cursor-pointer`}>
                      <Checkbox
                        checked={qa.excludeFacilitator}
                        onCheckedChange={v => qa.setExcludeFacilitator(v === true)}
                        disabled={qa.source === 'text'}
                      />
                      Exclude facilitator
                    </label>
                  </div>
                  <SourceSelector
                    conversations={qa.source === 'text' ? [] : conversations}
                    textColumns={qa.source === 'conversations' ? [] : textColumns}
                    documents={qa.source === 'text' ? [] : documents}
                    selectedConversationIds={qa.selectedConversationIds}
                    selectedTextColumnIds={qa.selectedTextColumnIds}
                    selectedDocumentIds={qa.selectedDocumentIds}
                    onConversationChange={qa.setSelectedConversationIds}
                    onTextColumnChange={qa.setSelectedTextColumnIds}
                    onDocumentChange={qa.setSelectedDocumentIds}
                    onAllSourcesChange={qa.setAllSourceIds}
                  />
                </div>
              )}
            </div>}

            {/* Section 4: Filters (only shown when demographic filters exist) */}
            {hasDemographicFilters && (
            <div className="border-t shrink-0">
              <button
                className={`w-full flex items-center gap-1.5 px-3 py-2 bg-mm-bg hover:bg-mm-surface-hover border-b text-sm font-medium transition-colors shrink-0 ${filtersOpen ? 'text-mm-blue-text' : 'text-mm-text'}`}
                onClick={() => setFiltersOpen(prev => !prev)}
                aria-expanded={filtersOpen}
              >
                <ChevronDown className={`w-4 h-4 text-mm-text-muted transition-transform ${!filtersOpen ? '-rotate-90' : ''}`} aria-hidden="true" />
                <Filter className="w-4 h-4 text-mm-text-muted" />
                Filters
                {qa.participantIds.length > 0 && (
                  <span className="text-xs bg-mm-blue/20 text-mm-blue-text rounded-full px-1.5 py-0.5 leading-none ml-auto">
                    {qa.participantIds.length}
                  </span>
                )}
              </button>
              {filtersOpen && (
                <div className="p-2 overflow-visible">
                  <QualFilterBar
                    projectId={pid}
                    participantIds={qa.participantIds}
                    onParticipantIdsChange={qa.setParticipantIds}
                  />
                </div>
              )}
            </div>
            )}

            {/* Quote Board: Hide from Board + Board Options */}
            {qa.tab === 'quoteboard' && (
              <QuoteBoardSidebar
                qa={qa}
                codes={codes}
                categories={categories}
                qbConversations={qbConversations}
                qbTextColumns={qbTextColumns}
                qbDocuments={qbDocuments}
                hasActiveQbFilters={hasActiveQbFilters}
                qbFilterCount={qbFilterCount}
                showBoardNotes={showBoardNotes}
                showBoardCodes={showBoardCodes}
                showBoardSpeaker={showBoardSpeaker}
                showBoardSource={showBoardSource}
                setShowBoardNotes={setShowBoardNotes}
                setShowBoardCodes={setShowBoardCodes}
                setShowBoardSpeaker={setShowBoardSpeaker}
                setShowBoardSource={setShowBoardSource}
              />
            )}

            {/* Section 5: Chart Options (Descriptives only) */}
            {qa.tab === 'descriptives' && (
              <DescriptivesSidebar
                qa={qa}
                codes={codes}
                demoFilters={demoFilters}
                onValueModeChange={handleValueModeChange}
                onOrientationChange={handleOrientationChange}
              />
            )}

            {/* Section 5b: Relationships sub-view toggle + Chart Options */}
            {qa.tab === 'relationships' && (
              <RelationshipsSidebar
                qa={qa}
                demoFilters={demoFilters}
                setSrAnnouncement={setSrAnnouncement}
              />
            )}

            {/* Section 6: Exports (hidden on Quote Board) */}
            {qa.tab !== 'quoteboard' && <div className="border-t shrink-0">
              <button
                className={`w-full flex items-center gap-1.5 px-3 py-2 bg-mm-bg hover:bg-mm-surface-hover border-b text-sm font-medium transition-colors shrink-0 ${exportsOpen ? 'text-mm-blue-text' : 'text-mm-text'}`}
                onClick={() => setExportsOpen(prev => !prev)}
                aria-expanded={exportsOpen}
              >
                <ChevronDown className={`w-4 h-4 text-mm-text-muted transition-transform ${!exportsOpen ? '-rotate-90' : ''}`} aria-hidden="true" />
                <Download className="w-4 h-4 text-mm-text-muted" />
                Exports
              </button>
              {exportsOpen && (
                <div className="p-2 space-y-0.5">
                  <button className="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-mm-text-secondary hover:bg-mm-surface-hover rounded transition-colors" onClick={() => exportApi.codeFrequencies(pid, filterParams)}>
                    <Download className="w-3 h-3 text-mm-text-faint" /> Frequencies CSV
                  </button>
                  <button className="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-mm-text-secondary hover:bg-mm-surface-hover rounded transition-colors" onClick={() => exportApi.codedSegments(pid, filterParams)}>
                    <Download className="w-3 h-3 text-mm-text-faint" /> Segments CSV
                  </button>
                  <button className="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-mm-text-secondary hover:bg-mm-surface-hover rounded transition-colors" onClick={() => exportApi.codeCooccurrence(pid, filterParams)}>
                    <Download className="w-3 h-3 text-mm-text-faint" /> Co-occurrence CSV
                  </button>
                  <button className="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-mm-text-secondary hover:bg-mm-surface-hover rounded transition-colors" onClick={handleDescriptivesExport}>
                    <Download className="w-3 h-3 text-mm-text-faint" /> Source Data CSV
                  </button>
                  <button className="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-mm-text-secondary hover:bg-mm-surface-hover rounded transition-colors" onClick={handleComparisonExport} disabled={!qa.groupBy}>
                    <Download className="w-3 h-3 text-mm-text-faint" /> Comparison CSV
                  </button>
                </div>
              )}
            </div>}
          </div>
        </Panel>

        {/* Resize handle */}
        <PanelResizeHandle className="w-1.5 bg-mm-bg hover:bg-mm-blue/20 active:bg-mm-blue/30 transition-colors cursor-col-resize flex items-center justify-center">
          <div className="w-0.5 h-8 rounded-full bg-mm-border-medium" />
        </PanelResizeHandle>

        {/* Main content */}
        <Panel id="main" defaultSize="78" minSize="50">
          <div className="h-full flex flex-col">
            {/* Tab content */}
            <div className="flex-1 overflow-y-auto p-4" role="tabpanel" id="qual-tabpanel" aria-labelledby={`tab-${qa.tab}`}>
              {/* Reconciliation/Reliability render full-width above (outside this
                  PanelGroup), so this switch only handles the sidebar-bearing tabs. */}
              {!hasCoding ? (
                <div className="text-center py-16">
                  {/* #517: while blind this emptiness only means YOUR coding is empty —
                      "nothing has been coded yet" would misread as lost colleague work. */}
                  <BlindScopeNotice blind={blind} onReveal={toggleReveal} className="max-w-xl mx-auto mb-6 text-left">
                    Blind mode is on — these charts count only your own coding.
                    Colleagues' work is hidden and doesn't appear in these numbers.
                  </BlindScopeNotice>
                  <p className="text-mm-text-muted">
                    {blind
                      ? 'No coding visible to you matches this selection yet.'
                      : qa.source === 'text'
                        ? 'No text has been coded yet.'
                        : qa.source === 'all'
                          ? 'No segments or text has been coded yet.'
                          : 'No segments have been coded yet.'}
                  </p>
                  <p className="text-sm text-mm-text-faint mt-1">
                    {qa.source === 'text'
                      ? 'Open the Text Coding tab to start coding open-ended responses.'
                      : qa.source === 'all'
                        ? 'Code conversations or open-ended responses to see analysis here.'
                        : 'Open a conversation and start applying codes to see analysis here.'}
                  </p>
                </div>
              ) : (
                <>
                  {/* Blind-scope notice (#517): while blind these charts count only
                      the viewer's own coding — without this the heatmap/co-occurrence
                      render as an unexplained near-empty grid while source lists show
                      all-coder coverage. Content-by-code carries its own notice. */}
                  {(qa.tab === 'descriptives' || qa.tab === 'relationships') && (
                    <BlindScopeNotice blind={blind} onReveal={toggleReveal} className="mx-3 mt-3">
                      Blind mode is on — these charts count only your own coding.
                      Source lists and the codebook include every coder.
                    </BlindScopeNotice>
                  )}
                  {/* Descriptives tab */}
                  {qa.tab === 'descriptives' && (
                    <DescriptivesContent
                      qa={qa}
                      codes={codes}
                      hasQualSelection={hasQualSelection}
                      hasCodeSelection={hasCodeSelection}
                      hasSourceSelection={hasSourceSelection}
                      conversationSourceCount={conversationSourceCount}
                      descriptivesN={descriptivesN}
                      sourceFreqData={sourceFreqData}
                      sourceFreqLoading={sourceFreqLoading}
                      saturationData={saturationData}
                      saturationLoading={saturationLoading}
                      freqData={freqData}
                      onChartTypeChange={handleChartTypeChange}
                    />
                  )}

                  {/* Content tab */}
                  {qa.tab === 'content' && (
                    <div>
                      {/* Internal mode toggle */}
                      <div className="flex items-center gap-3 mb-4">
                        <div
                          className="inline-flex rounded-md border bg-mm-bg p-0.5"
                          role="tablist"
                          aria-label="Content browsing mode"
                          onKeyDown={handleContentModeKeyDown}
                        >
                          {CONTENT_MODES.map(mode => {
                            const isActive = qa.contentMode === mode
                            const label = CONTENT_MODE_LABELS[mode]
                            return (
                              <button
                                key={mode}
                                role="tab"
                                data-contentmode={mode}
                                aria-selected={isActive}
                                tabIndex={isActive ? 0 : -1}
                                className={`px-3 py-1.5 text-xs rounded-sm transition-colors ${
                                  isActive
                                    ? `${SELECTED_SEGMENT} shadow-xs`
                                    : 'text-mm-text-muted hover:text-mm-text-secondary'
                                }`}
                                onClick={() => {
                                  qa.setContentMode(mode)
                                  setSrAnnouncement(`${label} selected`)
                                }}
                              >
                                {label}
                              </button>
                            )
                          })}
                        </div>

                        {/* Focus mode indicator pill */}
                        {focusedCodeId != null && focusedCode && (
                          <FocusPill
                            codeName={focusedCode.name}
                            codeColor={focusedCodeColor}
                            onClear={() => handleFocusCode(focusedCodeId)}
                          />
                        )}
                      </div>

                      {qa.contentMode === 'by-code' ? (
                        <ContentByCode
                          projectId={pid}
                          codes={contentCodes}
                          allCodes={codes}
                          frequencies={contentFrequencies}
                          selectedContentCodeId={qa.contentCodeId}
                          onCodeSelect={handleContentCodeSelect}
                          filterParams={filterParams}
                          source={qa.source}
                          hasConversations={contentConversations.length > 0}
                          hasCommentColumns={contentTextColumns.length > 0}
                          hasDocuments={contentDocuments.length > 0}
                          focusedCodeId={focusedCodeId}
                          onFocusCode={handleFocusCode}
                          onCodeChange={handleCodeChange}
                          blind={blind && multiCoder && qa.layerScope !== 'consensus'}
                          onReveal={toggleReveal}
                        />
                      ) : (
                        <ContentBySource
                          projectId={pid}
                          codes={codes}
                          allCodes={codes}
                          conversations={contentConversations}
                          textColumns={contentTextColumns}
                          documents={contentDocuments}
                          selectedSourceId={qa.contentSource}
                          onSourceSelect={(src) => qa.setContentSource(src)}
                          onCodeClick={qa.viewCodeInContent}
                          source={qa.source}
                          excludeFacilitator={qa.excludeFacilitator}
                          focusedCodeId={focusedCodeId}
                          onFocusCode={handleFocusCode}
                          onCodeChange={handleCodeChange}
                        />
                      )}
                    </div>
                  )}

                  {/* Quote Board tab */}
                  {qa.tab === 'quoteboard' && (
                    <QuoteBoardView
                      projectId={pid}
                      codes={codes}
                      filterParams={quoteFilterParams}
                      quoteData={quoteData}
                      groupBy={qa.quoteGroupBy}
                      sortMode={qa.quoteSort}
                      density={qa.quoteDensity}
                      layout={qa.quoteLayout}
                      showNotes={showBoardNotes}
                      showCodes={showBoardCodes}
                      showSpeaker={showBoardSpeaker}
                      showSource={showBoardSource}
                      setSrAnnouncement={setSrAnnouncement}
                      hiddenCodeIds={qa.qbHiddenCodeIds}
                      hideUncoded={qa.qbHideUncoded}
                      hiddenConversationIds={qa.qbHiddenConversationIds}
                      hiddenTextColumnIds={qa.qbHiddenTextColumnIds}
                      hiddenDocumentIds={qa.qbHiddenDocumentIds}
                      hasActiveFilters={hasActiveQbFilters}
                      onClearFilters={qa.clearQbFilters}
                      onCodeChange={handleCodeChange}
                      onFocusCode={handleFocusCode}
                      focusedCodeId={focusedCodeId}
                      onSendToCanvas={handleSendExcerptToCanvas}
                      onSendToNewCanvas={handleSendExcerptToNewCanvas}
                    />
                  )}

                  {/* Relationships tab */}
                  {qa.tab === 'relationships' && (
                    <RelationshipsContent
                      pid={pid}
                      qa={qa}
                      codes={codes}
                      filterParams={filterParams}
                      demoFilters={demoFilters}
                      cooccurrenceN={cooccurrenceN}
                      comparisonData={comparisonData}
                      comparisonLoading={comparisonLoading}
                      comparisonN={comparisonN}
                      onCooccurrenceDataLoad={handleCooccurrenceDataLoad}
                    />
                  )}
                </>
              )}
            </div>
          </div>
        </Panel>
      </PanelGroup>
      )}
    </div>
  )
}
