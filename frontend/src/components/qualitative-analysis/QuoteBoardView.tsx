import { memo, useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Search, X, Copy, Download, Quote, EyeOff, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCorners,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  rectSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import {
  excerptsApi,
  quoteBoardApi,
  type Code,
  type QuoteBoardConfig,
  type QuotedExcerptItem,
  type QuotedExcerptsParams,
  type QuotedExcerptsResponse,
} from '@/lib/api'
import type { QuoteGroupBy, QuoteSort, QuoteDensity, QuoteLayout } from '@/lib/qual-analysis-types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { getCodeColor } from '@/lib/utils'
import { escapeCsvField } from '@/lib/csv'
import QuoteCard, { formatAttribution } from '@/components/qualitative-analysis/QuoteCard'
import FocusPill from '@/components/qualitative-analysis/FocusPill'

interface QuoteBoardViewProps {
  projectId: number
  codes: Code[]
  filterParams: QuotedExcerptsParams
  quoteData?: QuotedExcerptsResponse
  groupBy: QuoteGroupBy
  sortMode: QuoteSort
  density: QuoteDensity
  layout?: QuoteLayout
  showNotes?: boolean
  showCodes?: boolean
  showSpeaker?: boolean
  showSource?: boolean
  setSrAnnouncement: (msg: string) => void
  // Quote Board exclude filters (optional — only passed when rendered as QB tab)
  hiddenCodeIds?: Set<number>
  hideUncoded?: boolean
  hiddenConversationIds?: Set<number>
  hiddenTextColumnIds?: Set<number>
  hiddenDocumentIds?: Set<number>
  hasActiveFilters?: boolean
  onClearFilters?: () => void
  onCodeChange?: () => void
  onFocusCode?: (codeId: number) => void
  focusedCodeId?: number | null
  onSendToCanvas?: (excerptId: number, canvasId: number, canvasName: string) => void
  onSendToNewCanvas?: (excerptId: number, canvasName: string) => void
}

interface GroupedSection {
  key: string
  label: string
  items: QuotedExcerptItem[]
}

function getGridTemplate(layout: QuoteLayout): string {
  switch (layout) {
    case '1': return '1fr'
    case '2': return 'repeat(2, 1fr)'
    default: return 'repeat(auto-fill, minmax(340px, 1fr))'
  }
}

function sortExcerpts(items: QuotedExcerptItem[], mode: QuoteSort): QuotedExcerptItem[] {
  if (mode === 'custom') return items // custom order handled externally
  const sorted = [...items]
  switch (mode) {
    case 'source':
      return sorted.sort((a, b) => {
        // Conversations first, then comments
        if (a.source_type !== b.source_type) return a.source_type === 'segment' ? -1 : 1
        if (a.source_type === 'segment') {
          const sortA = a.conversation_sort_key ?? 0
          const sortB = b.conversation_sort_key ?? 0
          if (sortA !== sortB) return sortA - sortB
          return (a.sequence_order ?? 0) - (b.sequence_order ?? 0)
        }
        // Comments: by column name then source_name
        const colCmp = (a.column_name ?? '').localeCompare(b.column_name ?? '')
        if (colCmp !== 0) return colCmp
        return a.source_name.localeCompare(b.source_name)
      })
    case 'date':
      return sorted.sort((a, b) => {
        const dateA = a.conversation_date || a.created_at
        const dateB = b.conversation_date || b.created_at
        return dateA.localeCompare(dateB)
      })
    case 'quoted':
      return sorted.sort((a, b) => b.created_at.localeCompare(a.created_at))
    default:
      return sorted
  }
}

/** Apply saved custom order: known IDs in saved order, new IDs appended */
function applyCustomOrder(items: QuotedExcerptItem[], savedOrder: number[]): QuotedExcerptItem[] {
  if (!savedOrder || savedOrder.length === 0) return items
  const byId = new Map(items.map(e => [e.excerpt_id, e]))
  const ordered: QuotedExcerptItem[] = []
  for (const id of savedOrder) {
    const e = byId.get(id)
    if (e) {
      ordered.push(e)
      byId.delete(id)
    }
  }
  // Append new items not in saved order
  for (const e of items) {
    if (byId.has(e.excerpt_id)) {
      ordered.push(e)
    }
  }
  return ordered
}

function buildGroups(
  excerpts: QuotedExcerptItem[],
  groupBy: QuoteGroupBy,
  sortMode: QuoteSort,
  codes: Code[],
  customOrders: Record<string, number[]>,
): GroupedSection[] {
  const applySort = (items: QuotedExcerptItem[], sectionKey: string) => {
    if (sortMode === 'custom') {
      const saved = customOrders[sectionKey] ?? []
      // Seed with source order when no saved order exists
      if (saved.length === 0) return sortExcerpts(items, 'source')
      return applyCustomOrder(items, saved)
    }
    return sortExcerpts(items, sortMode)
  }

  if (groupBy === 'none') {
    return [{ key: 'all', label: '', items: applySort(excerpts, 'all') }]
  }

  if (groupBy === 'code') {
    const sections: GroupedSection[] = []
    // Use codebook order
    for (const code of codes) {
      const matching = excerpts.filter(e => e.applied_code_ids.includes(code.id))
      if (matching.length > 0) {
        const key = `code-${code.id}`
        sections.push({ key, label: code.name, items: applySort(matching, key) })
      }
    }
    // Excerpts with no codes
    const uncoded = excerpts.filter(e => e.applied_code_ids.length === 0)
    if (uncoded.length > 0) {
      sections.push({ key: 'code-uncoded', label: 'Uncoded', items: applySort(uncoded, 'code-uncoded') })
    }
    return sections
  }

  if (groupBy === 'category') {
    const categoryMap = new Map<string, { id: number | null; name: string; codes: Set<number> }>()
    for (const code of codes) {
      const catKey = code.category_id ? `cat-${code.category_id}` : 'cat-uncategorized'
      const catName = code.category_name ?? 'Uncategorized'
      if (!categoryMap.has(catKey)) {
        categoryMap.set(catKey, { id: code.category_id, name: catName, codes: new Set() })
      }
      categoryMap.get(catKey)!.codes.add(code.id)
    }

    const sections: GroupedSection[] = []
    for (const [catKey, cat] of categoryMap) {
      const matching = excerpts.filter(e =>
        e.applied_code_ids.some(cid => cat.codes.has(cid))
      )
      if (matching.length > 0) {
        sections.push({ key: catKey, label: cat.name, items: applySort(matching, catKey) })
      }
    }
    // Excerpts with no codes at all
    const uncoded = excerpts.filter(e => e.applied_code_ids.length === 0)
    if (uncoded.length > 0) {
      sections.push({ key: 'cat-none', label: 'Uncoded', items: applySort(uncoded, 'cat-none') })
    }
    return sections
  }

  if (groupBy === 'source') {
    const sourceMap = new Map<string, QuotedExcerptItem[]>()
    const sourceOrder: string[] = []
    // Sort excerpts by source order first
    const ordered = sortExcerpts(excerpts, 'source')
    for (const e of ordered) {
      const key = `src-${e.source_name}`
      if (!sourceMap.has(key)) {
        sourceMap.set(key, [])
        sourceOrder.push(key)
      }
      sourceMap.get(key)!.push(e)
    }
    return sourceOrder.map(key => ({
      key,
      label: sourceMap.get(key)![0].source_name,
      items: applySort(sourceMap.get(key)!, key),
    }))
  }

  return [{ key: 'all', label: '', items: applySort(excerpts, 'all') }]
}

const EMPTY_ORDERS: Record<string, number[]> = {}

function formatQuoteForCopy(e: QuotedExcerptItem): string {
  return `"${e.text}" \u2014 ${formatAttribution(e, true, true)}`
}

function deduplicateExcerpts(sections: GroupedSection[]): QuotedExcerptItem[] {
  const seen = new Set<number>()
  const result: QuotedExcerptItem[] = []
  for (const section of sections) {
    for (const e of section.items) {
      if (!seen.has(e.excerpt_id)) {
        seen.add(e.excerpt_id)
        result.push(e)
      }
    }
  }
  return result
}

function exportCsv(excerpts: QuotedExcerptItem[]) {
  const headers = [
    'excerpt_text', 'full_text', 'is_sub_segment', 'speaker', 'participant',
    'source_name', 'source_type', 'segment_number', 'codes', 'categories',
    'excerpt_note', 'date_quoted',
  ]
  const rows = excerpts.map(e => {
    // Distinct names: applied_codes is per-coder, so a code two coders share
    // would otherwise export as "Positive; Positive" (#441 residue).
    const codeNames = [...new Set(e.applied_codes.map(c => c.name))].join('; ')
    const catNames = [...new Set(e.applied_codes.map(c => c.category_name).filter(Boolean))].join('; ')
    return [
      e.text,
      e.full_segment_text || '',
      e.is_sub_segment ? 'yes' : 'no',
      e.speaker_name || '',
      e.participant_name || '',
      e.source_name,
      e.source_type,
      e.sequence_order !== null ? String(e.sequence_order + 1) : '',
      codeNames,
      catNames,
      e.excerpt_note || '',
      e.created_at,
    ].map(escapeCsvField).join(',')
  })
  const csv = [headers.join(','), ...rows].join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'quoted-excerpts.csv'
  a.click()
  URL.revokeObjectURL(url)
}

// ── Sortable card wrapper ────────────────────────────────────────────

const SortableCard = memo(function SortableCard({
  excerpt,
  projectId,
  density,
  showNotes,
  showCodes,
  showSpeaker,
  showSource,
  onUnquote,
  onCopy,
  allCodes,
  onCodeChange,
  onFocusCode,
  isDraggable,
  isCardFocused,
  onSendToCanvas,
  onSendToNewCanvas,
}: {
  excerpt: QuotedExcerptItem
  projectId: number
  density: QuoteDensity
  showNotes: boolean
  showCodes: boolean
  showSpeaker: boolean
  showSource: boolean
  onUnquote: (id: number) => void
  onCopy: (e: QuotedExcerptItem) => void
  allCodes: Code[]
  onCodeChange?: () => void
  onFocusCode?: (codeId: number) => void
  isDraggable: boolean
  isCardFocused: boolean
  onSendToCanvas?: (canvasId: number, canvasName: string) => void
  onSendToNewCanvas?: (canvasName: string) => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: excerpt.excerpt_id, disabled: !isDraggable })

  const style: React.CSSProperties = {
    transform: transform ? CSS.Transform.toString({ ...transform, scaleX: 1, scaleY: 1 }) : undefined,
    transition: [transition, 'opacity 200ms, filter 200ms'].filter(Boolean).join(', '),
    opacity: isDragging ? 0 : isCardFocused ? undefined : 0.35,
    filter: isCardFocused ? undefined : 'saturate(0.3)',
  }

  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      <QuoteCard
        excerpt={excerpt}
        projectId={projectId}
        density={density}
        showNotes={showNotes}
        showCodes={showCodes}
        showSpeaker={showSpeaker}
        showSource={showSource}
        onUnquote={onUnquote}
        onCopy={onCopy}
        allCodes={allCodes}
        onCodeChange={onCodeChange}
        onFocusCode={onFocusCode}
        onSendToCanvas={onSendToCanvas}
        onSendToNewCanvas={onSendToNewCanvas}
        isDraggable={isDraggable}
        dragHandleRef={setActivatorNodeRef}
        dragHandleListeners={listeners}
        isDragging={isDragging}
      />
    </div>
  )
})

// ── Main component ───────────────────────────────────────────────────

export default function QuoteBoardView({
  projectId,
  codes,
  filterParams,
  quoteData: quoteDataProp,
  groupBy,
  sortMode,
  density,
  layout = 'auto',
  showNotes: showNotesProp = true,
  showCodes: showCodesProp = true,
  showSpeaker: showSpeakerProp = true,
  showSource: showSourceProp = true,
  setSrAnnouncement,
  hiddenCodeIds,
  hideUncoded,
  hiddenConversationIds,
  hiddenTextColumnIds,
  hiddenDocumentIds,
  hasActiveFilters,
  onClearFilters,
  onCodeChange,
  onFocusCode: onFocusCodeProp,
  focusedCodeId,
  onSendToCanvas: onSendToCanvasProp,
  onSendToNewCanvas: onSendToNewCanvasProp,
}: QuoteBoardViewProps) {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')

  // ── Suppress groupBy during custom sort (Phase 1a) ────────────────
  const effectiveGroupBy = sortMode === 'custom' ? 'none' : groupBy

  // ── Server-persisted custom orders ──────────────────────────────────
  const { data: boardConfig } = useQuery({
    queryKey: ['quote-board-config', projectId],
    queryFn: () => quoteBoardApi.getConfig(projectId),
    staleTime: Infinity,
  })
  const customOrders = boardConfig?.custom_orders ?? EMPTY_ORDERS

  const saveConfigMutation = useMutation({
    mutationFn: (orders: Record<string, number[]>) =>
      quoteBoardApi.updateConfig(projectId, { custom_orders: orders }),
    onMutate: (orders) => {
      // Optimistic update — apply new order to cache synchronously so the
      // re-render that clears DragOverlay already sees the new positions.
      queryClient.setQueryData(['quote-board-config', projectId], (old: QuoteBoardConfig | undefined) => ({
        ...old,
        custom_orders: orders,
      }))
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['quote-board-config', projectId], data)
    },
  })

  // ── DnD state ──────────────────────────────────────────────────────
  const [activeDragId, setActiveDragId] = useState<number | null>(null)
  const preDragOrderRef = useRef<Record<string, number[]> | null>(null)

  // ── DnD sensors ─────────────────────────────────────────────────────
  const pointerSensor = useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  const keyboardSensor = useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  const dndSensors = useSensors(pointerSensor, keyboardSensor)

  // Drag is only enabled in custom sort mode with no search/filters active
  const isDragEnabled = sortMode === 'custom' && !search.trim() && !hasActiveFilters

  // ── Data fetching ───────────────────────────────────────────────────
  // Fallback query when quoteData is not provided from parent
  const queryKey = ['excerpts-quoted', projectId, ...Object.values(filterParams).filter(Boolean)]
  const { data: queryData, isLoading: queryLoading } = useQuery({
    queryKey,
    queryFn: () => excerptsApi.listQuoted(projectId, filterParams),
    enabled: !!projectId && !quoteDataProp,
  })

  const data = quoteDataProp ?? queryData
  const isLoading = !quoteDataProp && queryLoading
  const allExcerpts = useMemo(() => data?.excerpts ?? [], [data?.excerpts])
  const totalCount = data?.total_excerpts ?? 0

  // Client-side exclude filtering (Quote Board tab)
  const afterExcludes = useMemo(() => {
    const hasExcludes = (hiddenCodeIds && hiddenCodeIds.size > 0) || hideUncoded ||
      (hiddenConversationIds && hiddenConversationIds.size > 0) ||
      (hiddenTextColumnIds && hiddenTextColumnIds.size > 0) ||
      (hiddenDocumentIds && hiddenDocumentIds.size > 0)
    if (!hasExcludes) return allExcerpts
    return allExcerpts.filter(e => {
      // Hide uncoded excerpts
      if (hideUncoded && e.applied_code_ids.length === 0) return false
      // Hide excerpts with any hidden code
      if (hiddenCodeIds && hiddenCodeIds.size > 0 && e.applied_code_ids.some(id => hiddenCodeIds.has(id))) return false
      // Hide excerpts from hidden conversations
      if (hiddenConversationIds && hiddenConversationIds.size > 0 && e.source_type === 'segment' && e.conversation_id && hiddenConversationIds.has(e.conversation_id)) return false
      // Hide excerpts from hidden documents
      if (hiddenDocumentIds && hiddenDocumentIds.size > 0 && e.source_type === 'segment' && e.document_id && hiddenDocumentIds.has(e.document_id)) return false
      // Hide excerpts from hidden comment columns
      if (hiddenTextColumnIds && hiddenTextColumnIds.size > 0 && e.source_type === 'text' && e.column_id && hiddenTextColumnIds.has(e.column_id)) return false
      return true
    })
  }, [allExcerpts, hiddenCodeIds, hideUncoded, hiddenConversationIds, hiddenDocumentIds, hiddenTextColumnIds])
  const hiddenCount = allExcerpts.length - afterExcludes.length

  // SR announcement for filter changes
  const prevHiddenCountRef = useRef(hiddenCount)
  useEffect(() => {
    if (prevHiddenCountRef.current !== hiddenCount && hiddenCount > 0) {
      setSrAnnouncement(`${hiddenCount} quotes hidden, showing ${afterExcludes.length} of ${allExcerpts.length}`)
    }
    prevHiddenCountRef.current = hiddenCount
  }, [hiddenCount, afterExcludes.length, allExcerpts.length, setSrAnnouncement])

  // Client-side search filter
  const filtered = useMemo(() => {
    if (!search.trim()) return afterExcludes
    const term = search.toLowerCase()
    return afterExcludes.filter(e =>
      e.text.toLowerCase().includes(term) ||
      (e.speaker_name && e.speaker_name.toLowerCase().includes(term)) ||
      e.source_name.toLowerCase().includes(term) ||
      (e.excerpt_note && e.excerpt_note.toLowerCase().includes(term)) ||
      e.applied_codes.some(c => c.name.toLowerCase().includes(term))
    )
  }, [afterExcludes, search])

  // Grouping (effectiveGroupBy suppresses grouping during custom sort)
  const sections = useMemo(
    () => buildGroups(filtered, effectiveGroupBy, sortMode, codes, customOrders),
    [filtered, effectiveGroupBy, sortMode, codes, customOrders],
  )

  // ── DnD handlers ───────────────────────────────────────────────────

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const id = event.active.id as number
    setActiveDragId(id)
    preDragOrderRef.current = { ...customOrders }
    const excerpt = filtered.find(e => e.excerpt_id === id)
    if (excerpt) {
      setSrAnnouncement(`Picked up quote: "${excerpt.text.slice(0, 40)}${excerpt.text.length > 40 ? '...' : ''}"`)
    }
  }, [filtered, customOrders, setSrAnnouncement])

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setActiveDragId(null)
    const { active, over } = event
    if (!over || active.id === over.id) {
      preDragOrderRef.current = null
      return
    }

    // Find which section both items belong to
    let targetSection: GroupedSection | undefined
    for (const section of sections) {
      const hasActive = section.items.some(e => e.excerpt_id === active.id)
      const hasOver = section.items.some(e => e.excerpt_id === over.id)
      if (hasActive && hasOver) {
        targetSection = section
        break
      }
    }
    if (!targetSection) {
      preDragOrderRef.current = null
      return
    }

    const oldIndex = targetSection.items.findIndex(e => e.excerpt_id === active.id)
    const newIndex = targetSection.items.findIndex(e => e.excerpt_id === over.id)
    if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) {
      preDragOrderRef.current = null
      return
    }

    const reordered = arrayMove(targetSection.items, oldIndex, newIndex)
    const newOrderIds = reordered.map(e => e.excerpt_id)

    // Save to server
    const updatedOrders = { ...customOrders, [targetSection.key]: newOrderIds }
    saveConfigMutation.mutate(updatedOrders)

    // Undo toast with pre-drag order
    const previousOrders = preDragOrderRef.current
    preDragOrderRef.current = null
    toast('Card reordered', {
      action: previousOrders ? {
        label: 'Undo',
        onClick: () => saveConfigMutation.mutate(previousOrders),
      } : undefined,
    })

    const movedExcerpt = filtered.find(e => e.excerpt_id === active.id)
    setSrAnnouncement(
      `Moved quote to position ${newIndex + 1} of ${targetSection.items.length}${movedExcerpt ? `: "${movedExcerpt.text.slice(0, 30)}..."` : ''}`
    )
  }, [sections, customOrders, saveConfigMutation, filtered, setSrAnnouncement])

  const handleDragCancel = useCallback(() => {
    setActiveDragId(null)
    preDragOrderRef.current = null
    setSrAnnouncement('Reorder cancelled')
  }, [setSrAnnouncement])

  // Reset custom order for current groupBy
  const handleResetOrder = useCallback(() => {
    const sectionKeys = sections.map(s => s.key)
    const updatedOrders = { ...customOrders }
    for (const key of sectionKeys) {
      delete updatedOrders[key]
    }
    saveConfigMutation.mutate(updatedOrders)
    toast('Custom order reset')
    setSrAnnouncement('Custom order reset to default')
  }, [sections, customOrders, saveConfigMutation, setSrAnnouncement])

  // Auto-switch to custom sort on drag attempt when not already in custom mode
  // (This is handled by disabling drag when not in custom mode — the user must
  // select Custom sort first. The drag handle visibility signals this.)

  // Unquote mutation
  const unquoteMutation = useMutation({
    mutationFn: (excerptId: number) => excerptsApi.delete(projectId, excerptId),
    onSuccess: (_data, excerptId) => {
      queryClient.invalidateQueries({ queryKey: ['excerpts-quoted', projectId] })
      queryClient.invalidateQueries({ queryKey: ['excerpts', projectId] })
      const removed = allExcerpts.find(e => e.excerpt_id === excerptId)
      toast('Quote removed', {
        action: removed ? {
          label: 'Undo',
          onClick: () => {
            const createData: Record<string, unknown> = {}
            if (removed.segment_id) {
              createData.segment_id = removed.segment_id
              if (removed.is_sub_segment && removed.start_offset !== null && removed.end_offset !== null) {
                createData.start_offset = removed.start_offset
                createData.end_offset = removed.end_offset
              }
            } else if (removed.dataset_value_id) {
              createData.dataset_value_id = removed.dataset_value_id
            }
            excerptsApi.create(projectId, createData as Parameters<typeof excerptsApi.create>[1]).then(() => {
              queryClient.invalidateQueries({ queryKey: ['excerpts-quoted', projectId] })
              queryClient.invalidateQueries({ queryKey: ['excerpts', projectId] })
            })
          },
        } : undefined,
      })
      setSrAnnouncement('Quote removed')
    },
  })

  // Copy individual
  const handleCopy = useCallback((excerpt: QuotedExcerptItem) => {
    navigator.clipboard.writeText(formatQuoteForCopy(excerpt))
    toast('Quote copied.')
    setSrAnnouncement('Quote copied to clipboard')
  }, [setSrAnnouncement])

  // Copy group
  const handleCopyGroup = useCallback((section: GroupedSection) => {
    const text = section.label
      ? `${section.label}\n\n${section.items.map(formatQuoteForCopy).join('\n\n')}`
      : section.items.map(formatQuoteForCopy).join('\n\n')
    navigator.clipboard.writeText(text)
    toast(`${section.items.length} quotes copied.`)
    setSrAnnouncement(`${section.items.length} quotes copied to clipboard`)
  }, [setSrAnnouncement])

  // Copy all (deduplicated)
  const handleCopyAll = useCallback(() => {
    const deduped = deduplicateExcerpts(sections)
    if (effectiveGroupBy === 'none' || sections.length <= 1) {
      const text = deduped.map(formatQuoteForCopy).join('\n\n')
      navigator.clipboard.writeText(text)
    } else {
      // Group output with deduplication
      const seen = new Set<number>()
      const parts: string[] = []
      for (const section of sections) {
        const unique = section.items.filter(e => {
          if (seen.has(e.excerpt_id)) return false
          seen.add(e.excerpt_id)
          return true
        })
        if (unique.length > 0) {
          parts.push(`${section.label}\n\n${unique.map(formatQuoteForCopy).join('\n\n')}`)
        }
      }
      navigator.clipboard.writeText(parts.join('\n\n---\n\n'))
    }
    toast(`${deduped.length} quotes copied.`)
    setSrAnnouncement(`${deduped.length} quotes copied to clipboard`)
  }, [sections, effectiveGroupBy, setSrAnnouncement])

  // CSV export (deduplicated)
  const handleExportCsv = useCallback(() => {
    const deduped = deduplicateExcerpts(sections)
    exportCsv(deduped)
    toast(`Exported ${deduped.length} excerpts.`)
  }, [sections])

  // Stable callback refs for memoized cards
  const handleUnquote = useCallback((id: number) => unquoteMutation.mutate(id), [unquoteMutation])

  // ── DragOverlay excerpt ────────────────────────────────────────────
  const activeDragExcerpt = useMemo(
    () => activeDragId !== null ? filtered.find(e => e.excerpt_id === activeDragId) : undefined,
    [activeDragId, filtered],
  )

  // ── Focus mode ────────────────────────────────────────────────────
  const focusedCode = useMemo(
    () => focusedCodeId != null ? codes.find(c => c.id === focusedCodeId) : undefined,
    [focusedCodeId, codes],
  )
  const focusedCodeName = focusedCode?.name
  const focusedCodeColor = focusedCode ? getCodeColor(focusedCode) : '#6b7280'
  const focusedCount = useMemo(
    () => focusedCodeId != null ? filtered.filter(e => e.applied_code_ids.includes(focusedCodeId)).length : filtered.length,
    [focusedCodeId, filtered],
  )

  // Determine empty state
  if (isLoading) {
    return (
      <div className="text-center py-16 text-mm-text-muted">
        <p>Loading quoted excerpts…</p>
      </div>
    )
  }

  if (totalCount === 0) {
    return (
      <div className="text-center py-16 text-mm-text-muted space-y-2">
        <Quote className="w-8 h-8 mx-auto opacity-40" />
        <p>No quoted excerpts yet.</p>
        <p className="text-xs">Use the quote button (<kbd className="px-1 py-0.5 rounded border text-[10px]">s</kbd>) in the Coding Workbench or Text Coding tab to curate quotes here.</p>
      </div>
    )
  }

  if (allExcerpts.length === 0) {
    return (
      <div className="text-center py-16 text-mm-text-muted">
        <p>No quoted excerpts match the current filters.</p>
      </div>
    )
  }

  if (afterExcludes.length === 0 && hasActiveFilters) {
    return (
      <div className="text-center py-16 text-mm-text-muted space-y-2">
        <EyeOff className="w-8 h-8 mx-auto opacity-40" />
        <p>All quotes are hidden by filters.</p>
        {onClearFilters && (
          <Button variant="outline" size="sm" onClick={onClearFilters}>
            Clear filters
          </Button>
        )}
      </div>
    )
  }

  // Check if current groupBy has any custom order saved
  const hasCustomOrder = sections.some(s => (customOrders[s.key]?.length ?? 0) > 0)

  return (
    <div>
      {/* Options toolbar */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-mm-text-muted" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search excerpts…"
            className="pl-8 h-8 text-sm w-48"
          />
          {search && (
            <button
              className="absolute right-2 top-1/2 -translate-y-1/2 text-mm-text-muted hover:text-mm-text"
              onClick={() => setSearch('')}
              aria-label="Clear search"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <div className="flex-1" />

        {/* Reset custom order button (only when in custom sort with saved order) */}
        {sortMode === 'custom' && hasCustomOrder && (
          <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={handleResetOrder}>
            <RotateCcw className="w-3.5 h-3.5 mr-1" />
            Reset Order
          </Button>
        )}

        {/* Actions */}
        <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={handleCopyAll}>
          <Copy className="w-3.5 h-3.5 mr-1" />
          Copy All
        </Button>
        <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={handleExportCsv}>
          <Download className="w-3.5 h-3.5 mr-1" />
          Export CSV
        </Button>

        {/* Count */}
        <span className="text-xs text-mm-text-muted whitespace-nowrap">
          {hiddenCount > 0
            ? `Showing ${filtered.length} of ${totalCount} (${hiddenCount} hidden)`
            : filtered.length === totalCount
              ? `${totalCount} quoted`
              : `Showing ${filtered.length} of ${totalCount} quoted`}
        </span>
      </div>

      {/* Search empty state */}
      {search && filtered.length === 0 && (
        <div className="text-center py-12 text-mm-text-muted">
          <p>No quoted excerpts match &lsquo;{search}&rsquo;.</p>
        </div>
      )}

      {/* Custom sort hint (Phase 2b) */}
      {sortMode === 'custom' && !search.trim() && (
        <div role="status" className="text-xs text-mm-text-muted mb-3 px-1">
          Grouping is disabled during custom sort — drag cards to arrange them.
        </div>
      )}

      {/* Focus mode indicator pill */}
      {focusedCodeId != null && focusedCodeName && (
        <div className="mb-3 px-1">
          <FocusPill
            codeName={focusedCodeName}
            codeColor={focusedCodeColor}
            onClear={() => onFocusCodeProp?.(focusedCodeId)}
            countLabel={`${focusedCount} of ${filtered.length} quotes`}
          />
        </div>
      )}

      {/* Sections with DnD */}
      <DndContext
        sensors={dndSensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div className="space-y-6">
          {sections.map(section => (
            <section
              key={section.key}
              aria-label={section.label ? `${section.label}, ${section.items.length} excerpts` : `${section.items.length} excerpts`}
            >
              {section.label && (
                <>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-semibold text-mm-text">
                      {section.label}
                      <span className="ml-2 text-xs font-normal text-mm-text-muted">
                        {section.items.length}
                      </span>
                    </h3>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => handleCopyGroup(section)}
                      aria-label={`Copy all quotes in ${section.label}`}
                    >
                      <Copy className="w-3 h-3 mr-1" />
                      Copy
                    </Button>
                  </div>
                  <div className="border-b border-mm-border-subtle mb-3" />
                </>
              )}
              <SortableContext
                items={section.items.map(e => e.excerpt_id)}
                strategy={rectSortingStrategy}
              >
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: getGridTemplate(layout),
                    gap: '12px',
                    alignItems: 'start',
                    ...(layout === '1' ? { maxWidth: 700, marginInline: 'auto' } : {}),
                  }}
                >
                  {section.items.map(e => (
                    <SortableCard
                      key={`${section.key}-${e.excerpt_id}`}
                      excerpt={e}
                      projectId={projectId}
                      density={density}
                      showNotes={showNotesProp}
                      showCodes={showCodesProp}
                      showSpeaker={showSpeakerProp}
                      showSource={showSourceProp}
                      onUnquote={handleUnquote}
                      onCopy={handleCopy}
                      allCodes={codes}
                      onCodeChange={onCodeChange}
                      onFocusCode={onFocusCodeProp}
                      isDraggable={isDragEnabled}
                      isCardFocused={focusedCodeId == null || e.applied_code_ids.includes(focusedCodeId)}
                      onSendToCanvas={onSendToCanvasProp ? (canvasId, canvasName) => onSendToCanvasProp(e.excerpt_id, canvasId, canvasName) : undefined}
                      onSendToNewCanvas={onSendToNewCanvasProp ? (canvasName) => onSendToNewCanvasProp(e.excerpt_id, canvasName) : undefined}
                    />
                  ))}
                </div>
              </SortableContext>
            </section>
          ))}
        </div>

        {/* DragOverlay — simplified card shown while dragging */}
        <DragOverlay>
          {activeDragExcerpt ? (() => {
            const attr = formatAttribution(activeDragExcerpt, showSpeakerProp, showSourceProp)
            return (
              <div
                className="rounded-lg border border-mm-accent/40 bg-mm-surface p-4 shadow-lg max-w-sm"
                aria-hidden="true"
              >
                <p className="text-sm text-mm-text leading-relaxed line-clamp-3">
                  {'\u201C'}{activeDragExcerpt.text}{'\u201D'}
                </p>
                {attr && (
                  <p className="text-xs text-mm-text-muted mt-1">— {attr}</p>
                )}
              </div>
            )
          })() : null}
        </DragOverlay>
      </DndContext>
    </div>
  )
}
