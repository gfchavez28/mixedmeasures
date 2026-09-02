import { useState, useMemo, useCallback, useRef, useEffect, forwardRef, type CSSProperties, type ReactNode } from 'react'
import { useParams, useNavigate } from 'react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Virtuoso, type VirtuosoHandle, type Components } from 'react-virtuoso'
import { useScrollbarGutter } from '@/hooks/useScrollbarGutter'
import {
  Search, X, Undo2, Redo2, Eye, EyeOff, Pencil, ChevronLeft, ChevronRight, FileText, Download,
  Check, Image, ImageOff, Trash2, ArrowUp, ArrowDown, Quote, BookOpen,
} from 'lucide-react'
import { toast } from 'sonner'
import { useTextSplitSelection } from '@/hooks/useTextSplitSelection'
import { useSegmentSelection } from '@/hooks/useSegmentSelection'
import { useCodeShortcutLabels } from '@/hooks/useCodeShortcutLabels'
import { useCodeChordShortcuts } from '@/hooks/useCodeChordShortcuts'
import MagnitudeStrip from '@/components/MagnitudeStrip'
import { codeKeyHint } from '@/lib/codeShortcuts'
import SplitToolbar from '@/components/SplitToolbar'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import {
  documentsApi,
  codingApi,
  codesApi,
  categoriesApi,
  excerptsApi,
  type Code,
  type Coder,
  type DocumentDetailResponse,
  type DocumentSegmentResponse,
} from '@/lib/api'
import { useHistory } from '@/hooks/useHistory'
import { PageErrorBoundary } from '@/components/PageErrorBoundary'
import FloatingCreateCode, { type FloatingCoords } from '@/components/FloatingCreateCode'
import FloatingCreateNote from '@/components/FloatingCreateNote'
import { coordsFromElement, selectionPrefill } from '@/lib/floating-utils'
import { invalidateDerivedCounts } from '@/lib/coding-cache'
import { describeQuoteNotesStayed } from '@/lib/split-disclosure'
import { optionOrdinals, optionPositionAria } from '@/lib/listbox-aria'
import { collectBulkOutcome, describeBulkFailure } from '@/lib/bulk-code-result'
import { isSegmentCodedVisible, computeCoverage } from '@/lib/coding-progress'
import BlindModeToggle from '@/components/BlindModeToggle'
import CoderCountBadge from '@/components/CoderCountBadge'
import { useBlindMode } from '@/hooks/useBlindMode'
import { getCodeColor, cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select'
import CollapsiblePanel from '@/components/CollapsiblePanel'
import CodePanel, { type CodePanelHandle } from '@/components/CodePanel'
import MemoPanel, { type MemoPanelHandle } from '@/components/MemoPanel'
import InlineCodeActions from '@/components/qualitative-analysis/InlineCodeActions'
import { useCoders } from '@/hooks/useCoders'
import { useCoderCoverage } from '@/hooks/useCoderCoverage'
import { useAuth } from '@/lib/auth-context'
import CoderFilterPopover from '@/components/CoderFilterPopover'
import { mergeArchivedIntoCoderMap, chipHiddenWithArchived } from '@/lib/coder-color'
import { sliceByCodePoints, codePointLength } from '@/lib/text-offsets'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuTrigger,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

// ── Types ──

interface VisibleSegment extends DocumentSegmentResponse {
  _index: number // position in visible list (0-based)
}

type ListItem =
  | { type: 'segment'; segment: VisibleSegment }
  | { type: 'image'; imageIndex: number; afterSeqOrder: number }

// #436: ARIA listbox semantics for the virtualized document. The List is the `listbox`
// owning the segment rows (each DocumentSegmentRow root is role="option" with aria-selected);
// the per-item wrapper is role="presentation" so the listbox→option ownership survives the
// Virtuoso wrapper. Interspersed image rows are non-selectable content rendered inside their
// own presentation wrapper (kept out of the option set). Module scope = stable identity so
// Virtuoso doesn't remount the list each render. Keyboard nav/selection is the workbench's
// own keyboard layer, not roving tabindex.
// #484: focusable listbox + aria-activedescendant so a screen reader can follow the
// workbench's arrow-nav (see the matching note in TranscriptPanel.tsx). aria-activedescendant
// over roving tabindex because the list is virtualized — real focus stays on the
// never-unmounting List and survives row recycling. Active id threaded via Virtuoso `context`.
interface DocumentListContext {
  activeDescendantId?: string
}

const documentComponents: Components<ListItem, DocumentListContext> = {
  List: forwardRef<HTMLDivElement, { style?: CSSProperties; children?: ReactNode; context?: DocumentListContext }>(
    function DocumentList({ style, children, context }, ref) {
      return (
        <div
          ref={ref}
          style={style}
          role="listbox"
          aria-multiselectable="true"
          aria-label="Document segments"
          tabIndex={0}
          aria-activedescendant={context?.activeDescendantId}
        >
          {children}
        </div>
      )
    },
  ),
  Item: function DocumentItem({ children, item: _item, context: _context, ...props }) {
    return <div {...props} role="presentation">{children}</div>
  },
}

// ── Component ──

export default function DocumentCodingWorkbench() {
  const { projectId, setBreadcrumbLabel, openCodebook } = useProjectLayout()
  const { documentId: documentIdStr } = useParams()
  const documentId = Number(documentIdStr)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const history = useHistory()
  // Coder roster lens (Track J · J1) — attribution badges + visibility filter, multi-coder only.
  const { coders, coderMap, multiCoder } = useCoders()
  const { user } = useAuth()
  // Active coder: apply/remove + "applied" checks act on MY own layer, never any
  // coder's (#446). `selfId == null` (coder unknown) falls back to any-coder.
  const selfId = user?.id ?? null
  const [hiddenCoders, setHiddenCoders] = useState<Set<number>>(new Set())
  // #451: archived coders' chips hidden by default; "view all coders" reveals them.
  const [showArchivedCoders, setShowArchivedCoders] = useState(false)
  // Blind mode (Track J · J2-5, DEC-G): effectiveHidden = all-but-self while blind.
  const { blind, blindHiddenSet, toggleReveal } = useBlindMode(projectId)
  const effectiveHidden = blind ? blindHiddenSet : hiddenCoders
  // Group A (#457): who coded THIS document — drives the picklist "active here" markers.
  const coderCoverage = useCoderCoverage(
    projectId, { documentId }, { enabled: multiCoder, rosterCoderIds: coders.map(c => c.id) },
  )
  // #451: fold archived-who-coded into the CHIP map (so they render attributed) and
  // force them hidden unless revealed — chips only; the gauges keep effectiveHidden.
  const archivedCoderIds = useMemo(() => new Set(coderCoverage.extraCoders.map(c => c.id)), [coderCoverage.extraCoders])
  const chipCoderMap = useMemo(
    () => (multiCoder && coderMap ? mergeArchivedIntoCoderMap(coderMap, coderCoverage.extraCoders) : undefined),
    [multiCoder, coderMap, coderCoverage.extraCoders],
  )
  const chipHidden = useMemo(
    () => chipHiddenWithArchived(effectiveHidden, archivedCoderIds, showArchivedCoders),
    [effectiveHidden, archivedCoderIds, showArchivedCoders],
  )

  // ── Data queries ──

  const { data: document } = useQuery({
    queryKey: ['document', projectId, documentId],
    queryFn: () => documentsApi.getDetail(projectId, documentId),
    enabled: !isNaN(documentId),
  })

  const { data: documentsData } = useQuery({
    queryKey: ['documents', projectId],
    queryFn: () => documentsApi.list(projectId),
    enabled: !isNaN(projectId),
  })

  const documents = useMemo(() => documentsData ?? [], [documentsData])

  const { prevDocument, nextDocument, currentDocIndex } = useMemo(() => {
    const idx = documents.findIndex(d => d.id === documentId)
    return {
      prevDocument: idx > 0 ? documents[idx - 1] : null,
      nextDocument: idx < documents.length - 1 ? documents[idx + 1] : null,
      currentDocIndex: idx,
    }
  }, [documents, documentId])

  // Set breadcrumb label to document name
  useEffect(() => {
    if (document?.name) setBreadcrumbLabel(document.name)
  }, [document?.name, setBreadcrumbLabel])

  const { data: codesData } = useQuery({
    queryKey: ['codes', projectId],
    queryFn: () => codesApi.list(projectId),
    enabled: !isNaN(projectId),
  })

  const codes = useMemo(() => codesData?.codes ?? [], [codesData?.codes])
  const chordCategories = useMemo(() => {
    const catMap = new Map<number, { id: number; name: string; parent_id?: number | null }>()
    codes.forEach(c => {
      if (c.category_id && !catMap.has(c.category_id)) {
        catMap.set(c.category_id, { id: c.category_id, name: c.category_name ?? '', parent_id: null })
      }
    })
    return Array.from(catMap.values())
  }, [codes])

  const { data: categoriesData } = useQuery({
    queryKey: ['categories', projectId],
    queryFn: () => categoriesApi.list(projectId),
    enabled: !isNaN(projectId),
  })
  const categories = categoriesData?.categories ?? []

  // ── Segment processing ──

  const allSegments = useMemo(() => document?.segments ?? [], [document?.segments])

  // Visible = not merged away, not split away
  const visibleSegments: VisibleSegment[] = useMemo(() => {
    let idx = 0
    return allSegments
      .filter(s => s.merged_into_id === null && s.split_into_id === null)
      .map(s => ({ ...s, _index: idx++ }))
  }, [allSegments])

  // ── Selection state ──

  const [selectedSegments, setSelectedSegments] = useState<number[]>([])
  const selectedSegmentsRef = useRef(selectedSegments)
  useEffect(() => { selectedSegmentsRef.current = selectedSegments }, [selectedSegments])

  const selectedSet = useMemo(() => new Set(selectedSegments), [selectedSegments])

  // #484: aria-activedescendant target = the last-selected segment (see TranscriptPanel.tsx).
  // Its DOM id is `segment-${id}` on the role="option" root (DocumentSegmentRow).
  const documentListContext = useMemo<DocumentListContext>(
    () => ({
      activeDescendantId: selectedSegments.length > 0
        ? `segment-${selectedSegments[selectedSegments.length - 1]}`
        : undefined,
    }),
    [selectedSegments],
  )


  // ── Lookup maps ──

  const segmentMap = useMemo(() => {
    const map = new Map<number, VisibleSegment>()
    visibleSegments.forEach(s => map.set(s.id, s))
    return map
  }, [visibleSegments])

  const codeMap = useMemo(() => {
    const map = new Map<number, Code>()
    codes.forEach(c => map.set(c.id, c))
    return map
  }, [codes])

  // The numeric_id map + chord category map now live inside useCodeChordShortcuts
  // (derived from `codes` via the shared buildShortcutCategories helper — #388 P1.3).

  // Selected codes map for CodePanel
  const selectedCodesMap = useMemo(() => {
    const map = new Map<number, 'all' | 'some' | 'none'>()
    if (selectedSegments.length === 0) return map

    codes.forEach(code => {
      const statuses = selectedSegments.map(segId => {
        const seg = segmentMap.get(segId)
        return seg?.codes?.some(c => c.id === code.id && (selfId == null || c.user_id === selfId)) ?? false
      })
      const allHave = statuses.every(Boolean)
      const someHave = statuses.some(Boolean)
      map.set(code.id, allHave ? 'all' : someHave ? 'some' : 'none')
    })
    return map
  }, [selectedSegments, segmentMap, codes, selfId])

  // ── Filter & search ──

  const [textFilter, setTextFilter] = useState('')
  const [quotedFilter, setQuotedFilter] = useState(false)

  // Column visibility (persisted per project)
  const [columnVisibility, setColumnVisibility] = useState(() => {
    try {
      const stored = localStorage.getItem(`mm-doc-columns-${projectId}`)
      if (stored) return JSON.parse(stored) as { codes: boolean; notes: boolean; images: boolean }
    } catch { /* ignore */ }
    return { codes: true, notes: true, images: false }
  })
  useEffect(() => {
    localStorage.setItem(`mm-doc-columns-${projectId}`, JSON.stringify(columnVisibility))
  }, [columnVisibility, projectId])

  const showCodes = columnVisibility.codes
  const showNotes = columnVisibility.notes
  const showImages = columnVisibility.images

  const filteredSegments = useMemo(() => {
    let result = visibleSegments
    if (quotedFilter) {
      result = result.filter(s => s.excerpt_info?.has_whole_segment || (s.excerpt_info?.sub_segment_count ?? 0) > 0)
    }
    if (textFilter.trim()) {
      const q = textFilter.trim().toLowerCase()
      result = result.filter(s => s.text.toLowerCase().includes(q))
    }
    return result
  }, [visibleSegments, textFilter, quotedFilter])

  // Build image position lookup: sequence_order → image indices to show after it
  const imagesBySequenceOrder = useMemo(() => {
    const map = new Map<number, number[]>()
    if (!document?.image_positions) return map
    for (const pos of document.image_positions) {
      const existing = map.get(pos.after_sequence_order)
      if (existing) existing.push(pos.index)
      else map.set(pos.after_sequence_order, [pos.index])
    }
    return map
  }, [document?.image_positions])

  // Interleave segments and images into a flat list for Virtuoso
  const listItems: ListItem[] = useMemo(() => {
    if (!showImages || imagesBySequenceOrder.size === 0) {
      return filteredSegments.map(s => ({ type: 'segment' as const, segment: s }))
    }
    const items: ListItem[] = []
    for (const seg of filteredSegments) {
      items.push({ type: 'segment', segment: seg })
      const images = imagesBySequenceOrder.get(seg.sequence_order)
      if (images) {
        for (const imgIdx of images) {
          items.push({ type: 'image', imageIndex: imgIdx, afterSeqOrder: seg.sequence_order })
        }
      }
    }
    return items
  }, [filteredSegments, imagesBySequenceOrder, showImages])

  // #751: segment ID → 1-based ordinal among OPTIONS. Distinct from
  // `segIdToListIndex` below on purpose: that one indexes `listItems` (segments
  // AND images) for scrollToIndex; this one counts only the rows that are
  // actually options, which is what `aria-posinset`/`aria-setsize` describe.
  const segIdToOptionOrdinal = useMemo(
    () => optionOrdinals(filteredSegments, s => s.id),
    [filteredSegments],
  )

  // Map segment ID → list item index (for scrollToIndex with interleaved images)
  const segIdToListIndex = useMemo(() => {
    const map = new Map<number, number>()
    listItems.forEach((item, idx) => {
      if (item.type === 'segment') map.set(item.segment.id, idx)
    })
    return map
  }, [listItems])

  // ── Panel state ──

  const [panelStates, setPanelStates] = useState({
    codes: { collapsed: false },
    notes: { collapsed: true },
    memos: { collapsed: true },
  })
  const [focusedPanel, setFocusedPanel] = useState<'document' | 'codes' | 'notes' | 'memos'>('document')

  const togglePanel = useCallback((key: 'codes' | 'notes' | 'memos') => {
    setPanelStates(prev => ({
      ...prev,
      [key]: { collapsed: !prev[key].collapsed },
    }))
  }, [])

  // ── Original document viewer ──

  const [showOriginal, setShowOriginal] = useState(false)
  const [originalPanelWidth, setOriginalPanelWidth] = useState(480)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  // Fetch TXT content when viewer is open and format is txt
  const { data: txtContent } = useQuery({
    queryKey: ['document-original-txt', projectId, documentId],
    queryFn: () => documentsApi.fetchOriginalText(projectId, documentId),
    enabled: showOriginal && document?.source_format === 'txt',
    staleTime: Infinity,
  })

  // PDF page to show — derived from selected segment
  const selectedPage = useMemo(() => {
    if (selectedSegments.length === 1) {
      const seg = segmentMap.get(selectedSegments[0])
      if (seg?.page_number) return seg.page_number
    }
    return 1
  }, [selectedSegments, segmentMap])

  const pdfUrl = useMemo(
    () => `${documentsApi.getOriginalUrl(projectId, documentId)}#page=${selectedPage}`,
    [projectId, documentId, selectedPage]
  )

  // ── Floating dialog state ──

  const [createCodeDialog, setCreateCodeDialog] = useState<{ position: FloatingCoords; segmentIds: number[]; initialName?: string } | null>(null)
  const [createNoteDialog, setCreateNoteDialog] = useState<{ position: FloatingCoords; segmentId: number } | null>(null)
  const [createNotePending, setCreateNotePending] = useState(false)

  // ── Saved indicator ──

  const [savedIndicator, setSavedIndicator] = useState(false)
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
    }
  }, [])

  // ── Refs ──

  const virtuosoRef = useRef<VirtuosoHandle>(null)
  // #741: the header is outside the scroller — pad by the scrollbar's width.
  const gutter = useScrollbarGutter()
  const codePanelRef = useRef<CodePanelHandle>(null)
  const memoPanelRef = useRef<MemoPanelHandle>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const segmentListRef = useRef<HTMLDivElement>(null)

  // ── Inline editing ──

  const [editingSegmentId, setEditingSegmentId] = useState<number | null>(null)

  // Chord state is owned by useCodeChordShortcuts (declared after the handlers below).

  // ── Memo creation flow ──
  const [createMemoForCode, setCreateMemoForCode] = useState<{ id: number; name: string } | null>(null)

  // ── Invalidation helpers ──

  const invalidateAfterCodeChange = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['document', projectId, documentId] })
    queryClient.invalidateQueries({ queryKey: ['codes', projectId] })
    queryClient.invalidateQueries({ queryKey: ['project-summary', projectId] })
    invalidateDerivedCounts(queryClient, projectId)  // #450: cross-surface counts
  }, [queryClient, projectId, documentId])

  // #678: a bulk post reports a PARTIAL failure as an ordinary 200 body. This
  // workbench never patches optimistically and always invalidates above, so
  // nothing renders stale here — but without this the coder is simply not told
  // that some of the selection was skipped, and the toolbar still flashes Saved.
  const reportBulkOutcome = useCallback(
    (responses: Parameters<typeof collectBulkOutcome>[0], action: 'apply' | 'remove') => {
      const outcome = collectBulkOutcome(responses)
      if (outcome.hasFailures) toast.warning(describeBulkFailure(outcome, 'segment', action))
    },
    [],
  )

  // Clicking an applied-code chip on a segment pivots to that code in the codes panel (#422a).
  const handleFocusCode = useCallback((codeId: number) => {
    codePanelRef.current?.focusCode(codeId)
  }, [])

  // ── #35 magnitude: rate at apply (variant A) — the DOCUMENT strip (#868 b) ──
  // Which application is awaiting a rating. Set after a single-segment APPLY of a
  // code that declares a scale; the strip below the list is the surface. Mirrors
  // `CodingWorkbench` against THIS page's cache shape: the document detail's
  // `segments[].codes[]`, one entry per (code, coder), each carrying `magnitude`.
  const [ratingTarget, setRatingTarget] = useState<{ segmentId: number; code: Code } | null>(null)

  // The rating THIS coder currently holds, read from the cache the chips render
  // from, so the strip opens showing what is actually stored. `?? null`, never
  // `|| null` — a stored 0 is a real rating.
  const currentMagnitude = useCallback(
    (segmentId: number, codeId: number): number | null => {
      const entry = segmentMap.get(segmentId)?.codes.find(
        c => c.id === codeId && c.user_id === selfId,
      )
      return entry?.magnitude ?? null
    },
    [segmentMap, selfId],
  )

  // Optimistically patch ONE coder's rating on ONE segment. Documents have no
  // segment groups (those are conversation-scoped), so there is no fan-out to
  // mirror. Scoped to the active coder's own entry: a rating is that coder's
  // judgement, and painting a colleague's would show agreement that does not
  // exist. Rating again clears the merge flag server-side (rules §6d), so the
  // paint clears it too.
  const patchDocumentMagnitude = useCallback(
    (segmentId: number, codeId: number, value: number | null) => {
      queryClient.setQueryData<DocumentDetailResponse>(
        ['document', projectId, documentId],
        (old) => {
          if (!old?.segments) return old
          return {
            ...old,
            segments: old.segments.map(s => s.id !== segmentId ? s : {
              ...s,
              codes: s.codes.map(c =>
                c.id === codeId && c.user_id === selfId
                  ? { ...c, magnitude: value, magnitude_conflict: null }
                  : c,
              ),
            }),
          }
        },
      )
    },
    [queryClient, projectId, documentId, selfId],
  )

  const runOptimisticMagnitude = useCallback(
    async (segmentId: number, codeId: number, value: number | null) => {
      const snapshot = queryClient.getQueryData(['document', projectId, documentId])
      patchDocumentMagnitude(segmentId, codeId, value)
      try {
        await codingApi.setMagnitude(segmentId, codeId, value)
        // Deliberately NO invalidation: a rating changes no coded COUNT, and
        // this page's refetch-everything settle would be work for nothing.
      } catch (e) {
        queryClient.setQueryData(['document', projectId, documentId], snapshot)
        throw e  // `useHistory` toasts the server's own reason (a refused rating names why)
      }
    },
    [queryClient, projectId, documentId, patchDocumentMagnitude],
  )

  const commitMagnitude = useCallback(
    (value: number) => {
      const target = ratingTarget
      if (!target) return
      const previous = currentMagnitude(target.segmentId, target.code.id)
      setRatingTarget(null)
      // Undoable like every other coding mutation here; the inverse restores the
      // PREVIOUS value, which may legitimately be null (unrated) or 0.
      history.execute({
        type: 'code_apply',
        description: `Rate "${target.code.name}"`,
        redo: () => runOptimisticMagnitude(target.segmentId, target.code.id, value),
        undo: () => runOptimisticMagnitude(target.segmentId, target.code.id, previous),
      })
    },
    [ratingTarget, currentMagnitude, history, runOptimisticMagnitude],
  )

  const invalidateNotes = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['document-notes', projectId, documentId] })
    queryClient.invalidateQueries({ queryKey: ['document', projectId, documentId] })
  }, [queryClient, projectId, documentId])

  // ── Saved flash ──

  const showSaved = useCallback(() => {
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
    setSavedIndicator(true)
    savedTimerRef.current = setTimeout(() => {
      setSavedIndicator(false)
      savedTimerRef.current = null
    }, 2000)
  }, [])

  // ── Code toggle (with history) ──

  const handleCodeToggle = useCallback((code: Code) => {
    if (selectedSegments.length === 0) return

    const allHaveCode = selectedSegments.every(segId => {
      const seg = segmentMap.get(segId)
      return seg?.codes?.some(c => c.id === code.id && (selfId == null || c.user_id === selfId)) ?? false
    })

    const segmentIds = [...selectedSegments]
    const codeId = code.id
    const codeName = code.name

    if (selectedSegments.length === 1) {
      const segmentId = selectedSegments[0]
      if (allHaveCode) {
        // #868 (f): the rating is captured NOW, while the application still
        // exists, and the inverse re-applies WITH it — an undo that re-applied
        // bare silently unrated. `previous` may legitimately be 0.
        const previous = currentMagnitude(segmentId, codeId)
        history.execute({
          type: 'code_remove',
          description: `Remove code "${codeName}"`,
          redo: async () => { await codingApi.removeCode(segmentId, codeId); invalidateAfterCodeChange() },
          undo: async () => { await codingApi.applyCode(segmentId, codeId, undefined, previous); invalidateAfterCodeChange() },
        })
      } else {
        history.execute({
          type: 'code_apply',
          description: `Apply code "${codeName}"`,
          redo: async () => { await codingApi.applyCode(segmentId, codeId); invalidateAfterCodeChange() },
          undo: async () => { await codingApi.removeCode(segmentId, codeId); invalidateAfterCodeChange() },
        })
        // #35 variant A — a code that declares a scale opens its rating strip
        // straight after applying, so the judgement is made with the anchors on
        // screen. ⚠️ Only on the APPLY branch and only for a single segment —
        // the same two gates as the conversation workbench: removing has
        // nothing to rate, and one rating standing in for several judgements
        // is not a rating.
        if (code.magnitude_scale) setRatingTarget({ segmentId, code })
      }
    } else {
      const action = allHaveCode ? 'remove' : 'apply'
      // #868 (f), the multi-segment arm: one captured rating per segment; the
      // inverse re-applies per segment when any was rated, because the bulk
      // endpoint carries no rating.
      const captured = allHaveCode
        ? new Map(segmentIds.map(id => [id, currentMagnitude(id, codeId)] as const))
        : null
      const anyRated = captured != null && [...captured.values()].some(v => v != null)
      history.execute({
        type: allHaveCode ? 'code_remove' : 'code_apply',
        description: `${action === 'apply' ? 'Apply' : 'Remove'} code "${codeName}" from ${segmentIds.length} segments`,
        redo: async () => { reportBulkOutcome(await codingApi.bulkCode(segmentIds, codeId, action), action); invalidateAfterCodeChange() },
        undo: async () => {
          const inv = action === 'apply' ? 'remove' as const : 'apply' as const
          if (inv === 'apply' && anyRated) {
            await Promise.all(segmentIds.map(id => codingApi.applyCode(id, codeId, undefined, captured!.get(id) ?? null)))
          } else {
            reportBulkOutcome(await codingApi.bulkCode(segmentIds, codeId, inv), inv)
          }
          invalidateAfterCodeChange()
        },
      })
    }
    showSaved()
  }, [selectedSegments, segmentMap, history, invalidateAfterCodeChange, reportBulkOutcome, showSaved, selfId, currentMagnitude])

  const handleMultiCodeToggle = useCallback((codesToToggle: Code[]) => {
    if (selectedSegments.length === 0 || codesToToggle.length === 0) return
    const segmentIds = [...selectedSegments]
    const codeNames = codesToToggle.map(c => c.name).join(', ')
    history.execute({
      type: 'code_apply',
      description: `Apply codes "${codeNames}" to ${segmentIds.length} segment(s)`,
      redo: async () => {
        reportBulkOutcome(await Promise.all(codesToToggle.map(code => codingApi.bulkCode(segmentIds, code.id, 'apply'))), 'apply')
        invalidateAfterCodeChange()
      },
      undo: async () => {
        reportBulkOutcome(await Promise.all(codesToToggle.map(code => codingApi.bulkCode(segmentIds, code.id, 'remove'))), 'remove')
        invalidateAfterCodeChange()
      },
    })
    showSaved()
  }, [selectedSegments, history, invalidateAfterCodeChange, reportBulkOutcome, showSaved])

  // ── Quote toggle (with history) ──

  const handleToggleQuote = useCallback((segmentId: number) => {
    const seg = segmentMap.get(segmentId)
    if (!seg) return

    const hasExcerpt = seg.excerpt_info?.has_whole_segment
    if (hasExcerpt) {
      history.execute({
        type: 'quote_delete',
        description: 'Unquote segment',
        redo: async () => {
          const excerpts = await excerptsApi.list(projectId)
          const wholeExcerpt = excerpts.excerpts.find(
            e => e.segment_id === segmentId && e.start_offset === null
          )
          if (wholeExcerpt) {
            await excerptsApi.delete(projectId, wholeExcerpt.id)
          }
          invalidateAfterCodeChange()
        },
        undo: async () => {
          await excerptsApi.create(projectId, { segment_id: segmentId })
          invalidateAfterCodeChange()
        },
      })
    } else {
      let createdExcerptId: number | null = null
      history.execute({
        type: 'quote_create',
        description: 'Quote segment',
        redo: async () => {
          const result = await excerptsApi.create(projectId, { segment_id: segmentId })
          createdExcerptId = result.id
          invalidateAfterCodeChange()
        },
        undo: async () => {
          if (createdExcerptId) {
            await excerptsApi.delete(projectId, createdExcerptId)
          }
          invalidateAfterCodeChange()
        },
      })
    }
    showSaved()
  }, [segmentMap, projectId, history, invalidateAfterCodeChange, showSaved])

  // ── Bulk quote toggle ──

  const handleBulkQuoteToggle = useCallback(() => {
    if (selectedSegments.length === 0) return

    const allExcerpted = selectedSegments.every(id => {
      const seg = segmentMap.get(id)
      return seg?.excerpt_info?.has_whole_segment ?? false
    })
    const segmentIds = [...selectedSegments]

    if (allExcerpted) {
      // Collect excerpt IDs to delete
      history.execute({
        type: 'quote_delete',
        description: `Unquote ${segmentIds.length} segments`,
        redo: async () => {
          const excerpts = await excerptsApi.list(projectId)
          for (const sid of segmentIds) {
            const wholeExcerpt = excerpts.excerpts.find(
              e => e.segment_id === sid && e.start_offset === null
            )
            if (wholeExcerpt) await excerptsApi.delete(projectId, wholeExcerpt.id)
          }
          invalidateAfterCodeChange()
        },
        undo: async () => {
          await excerptsApi.bulkCreate(projectId, segmentIds.map(sid => ({ segment_id: sid })))
          invalidateAfterCodeChange()
        },
      })
    } else {
      history.execute({
        type: 'quote_create',
        description: `Quote ${segmentIds.length} segments`,
        redo: async () => {
          await excerptsApi.bulkCreate(projectId, segmentIds.map(sid => ({ segment_id: sid })))
          invalidateAfterCodeChange()
        },
        undo: async () => {
          const excerpts = await excerptsApi.list(projectId)
          for (const sid of segmentIds) {
            const wholeExcerpt = excerpts.excerpts.find(
              e => e.segment_id === sid && e.start_offset === null
            )
            if (wholeExcerpt) await excerptsApi.delete(projectId, wholeExcerpt.id)
          }
          invalidateAfterCodeChange()
        },
      })
    }
    showSaved()
  }, [selectedSegments, segmentMap, projectId, history, invalidateAfterCodeChange, showSaved])

  // ── Create code ──

  const createCodeMutation = useMutation({
    mutationFn: (name: string) => codesApi.create(projectId, { name }),
    onSuccess: async (newCode) => {
      await queryClient.invalidateQueries({ queryKey: ['codes', projectId] })
      if (selectedSegments.length > 0) {
        codePanelRef.current?.focusCodeForApply(newCode.id)
      }
    },
  })

  // ── Document notes (simplified inline panel) ──

  const { data: docNotes = [] } = useQuery({
    queryKey: ['document-notes', projectId, documentId],
    queryFn: () => documentsApi.listNotes(projectId, documentId),
    enabled: !isNaN(documentId),
  })

  const [noteInput, setNoteInput] = useState('')

  const createNoteMutation = useMutation({
    mutationFn: (data: { segment_id: number; content: string }) =>
      documentsApi.createNote(projectId, documentId, data),
    onSuccess: () => {
      invalidateNotes()
      setNoteInput('')
    },
    onError: () => toast.error('Failed to create note'),
  })

  const handleCreateNote = useCallback(() => {
    if (!noteInput.trim() || selectedSegments.length !== 1) return
    createNoteMutation.mutate({ segment_id: selectedSegments[0], content: noteInput.trim() })
  }, [noteInput, selectedSegments, createNoteMutation])

  // ── Image management ──

  const deleteImageMutation = useMutation({
    mutationFn: (imageIndex: number) =>
      documentsApi.deleteImage(projectId, documentId, imageIndex),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['document', projectId, documentId] })
      toast.success('Image deleted')
    },
    onError: () => toast.error('Failed to delete image'),
  })

  const moveImageMutation = useMutation({
    mutationFn: ({ imageIndex, afterSequenceOrder }: { imageIndex: number; afterSequenceOrder: number }) =>
      documentsApi.updateImagePosition(projectId, documentId, imageIndex, afterSequenceOrder),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['document', projectId, documentId] })
    },
    onError: () => toast.error('Failed to move image'),
  })

  const maxSeqOrder = filteredSegments.length > 0
    ? filteredSegments[filteredSegments.length - 1].sequence_order
    : 0

  // ── Jump to next uncoded ──

  const handleJumpToNextUncoded = useCallback(() => {
    const currentIdx = selectedSegments.length === 1
      ? filteredSegments.findIndex(s => s.id === selectedSegments[0])
      : -1

    // Search forward from current, wrapping around
    for (let offset = 1; offset <= filteredSegments.length; offset++) {
      const idx = (currentIdx + offset) % filteredSegments.length
      const seg = filteredSegments[idx]
      if (!isSegmentCodedVisible(seg.codes, effectiveHidden)) {
        setSelectedSegments([seg.id])
        const listIdx = segIdToListIndex.get(seg.id)
        if (listIdx != null) virtuosoRef.current?.scrollToIndex({ index: listIdx, align: 'center', behavior: 'smooth' })
        return
      }
    }
    toast('All segments are coded')
  }, [selectedSegments, filteredSegments, segIdToListIndex, effectiveHidden])

  // ── Selection helpers ──

  const { handleItemClick: handleSegmentItemClick, handleArrowNav } = useSegmentSelection({
    items: filteredSegments,
    getId: (s) => s.id,
    selectedIds: selectedSegments,
    onSelectionChange: setSelectedSegments,
    scrollToIndex: (idx) => {
      const seg = filteredSegments[idx]
      if (seg) {
        const listIdx = segIdToListIndex.get(seg.id)
        if (listIdx != null) virtuosoRef.current?.scrollToIndex({ index: listIdx, align: 'center', behavior: 'smooth' })
      }
    },
    enabled: editingSegmentId === null,
  })

  const handleSegmentClick = useCallback((segId: number, e: React.MouseEvent) => {
    handleSegmentItemClick(segId, e)
  }, [handleSegmentItemClick])

  // ── Inline segment text editing ──

  const handleSegmentEdit = useCallback((segmentId: number, newText: string) => {
    const seg = segmentMap.get(segmentId)
    if (!seg) return
    const oldText = seg.text
    if (newText === oldText) { setEditingSegmentId(null); return }

    history.execute({
      type: 'segment_edit',
      description: 'Edit segment text',
      redo: async () => {
        await documentsApi.updateSegment(projectId, documentId, segmentId, { text: newText })
        queryClient.invalidateQueries({ queryKey: ['document', projectId, documentId] })
      },
      undo: async () => {
        await documentsApi.updateSegment(projectId, documentId, segmentId, { text: oldText })
        queryClient.invalidateQueries({ queryKey: ['document', projectId, documentId] })
      },
    })
    setEditingSegmentId(null)
    showSaved()
  }, [segmentMap, history, queryClient, projectId, documentId, showSaved])

  // ── Title editing ──

  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const titleInputRef = useRef<HTMLInputElement>(null)

  const updateTitleMutation = useMutation({
    mutationFn: (name: string) => documentsApi.update(projectId, documentId, { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['document', projectId, documentId] })
      queryClient.invalidateQueries({ queryKey: ['documents', projectId] })
      setIsEditingTitle(false)
    },
    onError: () => toast.error('Failed to rename document'),
  })

  const startEditingTitle = useCallback(() => {
    if (!document) return
    setTitleDraft(document.name)
    setIsEditingTitle(true)
    setTimeout(() => titleInputRef.current?.select(), 0)
  }, [document])

  const saveTitleEdit = useCallback(() => {
    const trimmed = titleDraft.trim()
    if (!trimmed) {
      toast.error('Document name cannot be empty')
      setTitleDraft(document?.name ?? '')
      setIsEditingTitle(false)
      return
    }
    if (trimmed === document?.name) {
      setIsEditingTitle(false)
      return
    }
    updateTitleMutation.mutate(trimmed)
  }, [titleDraft, document?.name, updateTitleMutation])

  // ── Keyboard shortcuts (chord dispatch owned by the shared hook — #388 P1.3) ──

  const { chordPrefix, pendingCategoryId } = useCodeChordShortcuts({
    codes,
    selectionCount: selectedSegments.length,
    isEditing: editingSegmentId !== null,
    arrowNavEnabled: focusedPanel === 'document',
    onToggleCode: handleCodeToggle,
    onJumpUncoded: handleJumpToNextUncoded,
    onToggleQuote: handleBulkQuoteToggle,
    onCreateCode: () => {
      const selected = selectedSegmentsRef.current
      if (selected.length === 0) return
      const coords = coordsFromElement(`segment-${selected[0]}`)
      setCreateCodeDialog({ position: coords, segmentIds: [...selected], initialName: selectionPrefill() })
    },
    onCreateNote: () => {
      const selected = selectedSegmentsRef.current
      if (selected.length === 0) return
      const coords = coordsFromElement(`segment-${selected[0]}`)
      setCreateNoteDialog({ position: coords, segmentId: selected[0] })
    },
    onEditOrRename: () => {
      const selected = selectedSegmentsRef.current
      if (selected.length === 1) setEditingSegmentId(selected[0])
      else if (selected.length === 0) startEditingTitle()
      // 2+ selected → no-op
    },
    onArrowNav: handleArrowNav,
    onArrowHorizontal: (dir) => {
      if (dir === 'right' && focusedPanel === 'document') {
        setFocusedPanel('codes')
        codePanelRef.current?.focus()
        return true
      }
      if (dir === 'left' && focusedPanel !== 'document') {
        setFocusedPanel('document')
        containerRef.current?.focus()
        return true
      }
      return false
    },
    clearSelection: () => setSelectedSegments([]),
    onEscapeFallback: () => {
      if (focusedPanel !== 'document') {
        setFocusedPanel('document')
        containerRef.current?.focus()
      }
    },
    onUndo: () => history.undo(),
    onRedo: () => history.redo(),
  })

  const pendingCategoryName =
    pendingCategoryId !== null ? chordCategories.find(c => c.id === pendingCategoryId)?.name : null

  // ── Merge/split handlers ──

  const invalidateDoc = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['document', projectId, documentId] })
    queryClient.invalidateQueries({ queryKey: ['codes', projectId] })
    queryClient.invalidateQueries({ queryKey: ['document-notes', projectId, documentId] })
  }, [queryClient, projectId, documentId])

  const handleMergeSegments = useCallback((segmentIds: number[]) => {
    let mergedSegmentId: number | null = null
    history.execute({
      type: 'segment_merge',
      description: `Merge ${segmentIds.length} segments`,
      redo: async () => {
        const result = await documentsApi.merge(projectId, documentId, segmentIds)
        mergedSegmentId = result.merged_segment.id
        invalidateDoc()
        setSelectedSegments([result.merged_segment.id])
      },
      undo: async () => {
        if (mergedSegmentId) {
          const result = await documentsApi.unmerge(projectId, documentId, mergedSegmentId)
          invalidateDoc()
          if (result.restored_segments.length > 0) {
            setSelectedSegments([result.restored_segments[0].id])
          }
        }
      },
    })
    showSaved()
  }, [projectId, documentId, history, invalidateDoc, showSaved])

  const handleUnmergeSegment = useCallback((segmentId: number) => {
    let restoredSegmentIds: number[] = []
    history.execute({
      type: 'segment_merge',
      description: 'Unmerge segment',
      redo: async () => {
        const result = await documentsApi.unmerge(projectId, documentId, segmentId)
        restoredSegmentIds = result.restored_segments.map(s => s.id)
        invalidateDoc()
        if (result.restored_segments.length > 0) {
          setSelectedSegments([result.restored_segments[0].id])
        }
      },
      undo: async () => {
        if (restoredSegmentIds.length > 0) {
          const result = await documentsApi.merge(projectId, documentId, restoredSegmentIds)
          invalidateDoc()
          setSelectedSegments([result.merged_segment.id])
        }
      },
    })
    showSaved()
  }, [projectId, documentId, history, invalidateDoc, showSaved])

  const handleSplitSegment = useCallback((ranges: { segment_id: number; start_offset: number; end_offset: number }[]) => {
    let newSegmentIds: number[] = []
    history.execute({
      type: 'segment_split',
      description: 'Split segment',
      redo: async () => {
        const result = await documentsApi.split(projectId, documentId, ranges)
        newSegmentIds = result.new_segments.map(s => s.id)
        // #712: the notes this split left on the original — say so now, because
        // the link is unrecoverable afterwards.
        const stayed = describeQuoteNotesStayed(result.quote_notes_stayed)
        if (stayed) toast.info(stayed)
        invalidateDoc()
        const selectedSeg = result.new_segments[Math.floor(result.new_segments.length / 2)]
        if (selectedSeg) setSelectedSegments([selectedSeg.id])
      },
      undo: async () => {
        if (newSegmentIds.length > 0) {
          const result = await documentsApi.unsplit(projectId, documentId, newSegmentIds[0])
          invalidateDoc()
          setSelectedSegments([result.restored_segment.id])
        }
      },
    })
    showSaved()
  }, [projectId, documentId, history, invalidateDoc, showSaved])

  // Text split selection via shared hook
  const {
    splitSelection,
    handleSplit: handleSplitFromSelection,
    handleCancelSplit,
    getTextSelectionForSegment,
    announcement: splitAnnouncement,
  } = useTextSplitSelection(segmentListRef, filteredSegments, handleSplitSegment, setSelectedSegments, { allSegments: visibleSegments })

  const handleUnsplitSegment = useCallback((segmentId: number) => {
    history.execute({
      type: 'segment_split',
      description: 'Rejoin segment',
      redo: async () => {
        const result = await documentsApi.unsplit(projectId, documentId, segmentId)
        invalidateDoc()
        setSelectedSegments([result.restored_segment.id])
      },
      undo: async () => {
        // Rejoin is destructive (split parts' codes/notes are lost) — cannot reliably undo
        toast('Rejoin cannot be undone — split segment data was already discarded')
      },
    })
    showSaved()
  }, [projectId, documentId, history, invalidateDoc, showSaved])

  // ── Selection analysis for merge ──

  const canMerge = useMemo(() => {
    if (selectedSegments.length < 2) return false
    const segs = selectedSegments.map(id => segmentMap.get(id)).filter(Boolean) as VisibleSegment[]
    if (segs.length < 2) return false
    const sorted = [...segs].sort((a, b) => a.sequence_order - b.sequence_order)
    for (let i = 0; i < sorted.length - 1; i++) {
      if (sorted[i + 1].sequence_order !== sorted[i].sequence_order + 1) return false
    }
    return true
  }, [selectedSegments, segmentMap])

  // ── Progress stats ──
  // Coverage is filter-aware (Track J · J1): the count/bar/% reflect only codes from
  // visible coders. Documents have no facilitator, so visible segments are the denominator.

  const codedCount = useMemo(() =>
    computeCoverage(visibleSegments, s => s.codes, effectiveHidden).codedVisible
  , [visibleSegments, effectiveHidden])

  const progressPercent = visibleSegments.length > 0
    ? Math.round((codedCount / visibleSegments.length) * 100)
    : 0

  const progressGradient = useMemo(() => {
    // Empty bar — quiet neutral track (CSS var resolves per theme).
    if (visibleSegments.length === 0) return { background: 'hsl(var(--mm-border-subtle))' }
    const stops: string[] = []
    const w = 100 / visibleSegments.length
    visibleSegments.forEach((seg, i) => {
      // coded = mm-purple (document codes), uncoded = neutral; CSS vars rebalance per theme.
      const color = isSegmentCodedVisible(seg.codes, effectiveHidden) ? 'hsl(var(--mm-purple))' : 'hsl(var(--mm-border-medium))'
      stops.push(`${color} ${i * w}%`, `${color} ${(i + 1) * w}%`)
    })
    return { background: `linear-gradient(to right, ${stops.join(', ')})` }
  }, [visibleSegments, effectiveHidden])

  // ── Context menu code apply (from right-click) ──

  const handleContextCodeApply = useCallback((segmentId: number, codeId: number) => {
    const code = codeMap.get(codeId)
    if (!code) return
    // Ensure segment is selected
    if (!selectedSegments.includes(segmentId)) {
      setSelectedSegments([segmentId])
    }
    // Then toggle via normal path — but since selection updates async, call directly
    const seg = segmentMap.get(segmentId)
    const has = seg?.codes?.some(c => c.id === codeId && (selfId == null || c.user_id === selfId)) ?? false
    // #868 (f): the inverse of a removal re-applies with the captured rating.
    const previous = has ? currentMagnitude(segmentId, codeId) : null
    history.execute({
      type: has ? 'code_remove' : 'code_apply',
      description: `${has ? 'Remove' : 'Apply'} code "${code.name}"`,
      redo: async () => {
        if (has) await codingApi.removeCode(segmentId, codeId)
        else await codingApi.applyCode(segmentId, codeId)
        invalidateAfterCodeChange()
      },
      undo: async () => {
        if (has) await codingApi.applyCode(segmentId, codeId, undefined, previous)
        else await codingApi.removeCode(segmentId, codeId)
        invalidateAfterCodeChange()
      },
    })
    showSaved()
  }, [codeMap, selectedSegments, segmentMap, history, invalidateAfterCodeChange, showSaved, selfId, currentMagnitude])

  // ── Render ──

  if (!document) {
    return (
      <div className="flex items-center justify-center h-full text-mm-text-muted">
        Loading document...
      </div>
    )
  }

  const isPdf = document.source_format === 'pdf'

  return (
    <div className="flex flex-col h-full" ref={containerRef} tabIndex={-1}>
      {/* ── Toolbar ── */}
      {/* #516: flex-wrap + the ml-auto tail group below — the toolbar previously
        * clipped its tail (Codebook button, blind pill) at narrow widths. */}
      <div className="flex items-center gap-2 px-4 py-2 border-b bg-mm-surface shrink-0 flex-wrap">
        {/* Document navigation */}
        {documents.length > 1 && (
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="ghost"
              size="icon"
              disabled={!prevDocument}
              onClick={() => prevDocument && navigate(`/projects/${projectId}/documents/${prevDocument.id}`)}
              title={prevDocument ? `Previous: ${prevDocument.name}` : undefined}
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>

            <Select
              value={String(documentId)}
              onValueChange={v => navigate(`/projects/${projectId}/documents/${v}`)}
            >
              <SelectTrigger className="h-8 w-44 text-sm overflow-hidden">
                <span className="truncate block text-left">{document?.name ?? 'Select'}</span>
              </SelectTrigger>
              <SelectContent>
                {documents.map(d => (
                  <SelectItem key={d.id} value={String(d.id)}>
                    <span className="truncate block">{d.name}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              variant="ghost"
              size="icon"
              disabled={!nextDocument}
              onClick={() => nextDocument && navigate(`/projects/${projectId}/documents/${nextDocument.id}`)}
              title={nextDocument ? `Next: ${nextDocument.name}` : undefined}
            >
              <ChevronRight className="w-4 h-4" />
            </Button>

            <span className="text-xs text-muted-foreground font-mono tabular-nums">
              {currentDocIndex + 1} of {documents.length}
            </span>
          </div>
        )}

        {isEditingTitle ? (
          <Input
            ref={titleInputRef}
            value={titleDraft}
            onChange={e => setTitleDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); saveTitleEdit() }
              if (e.key === 'Escape') { e.preventDefault(); setIsEditingTitle(false) }
            }}
            onBlur={saveTitleEdit}
            className="h-7 text-sm font-medium max-w-[clamp(120px,40vw,600px)]"
            aria-label="Rename document"
            autoFocus
          />
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={startEditingTitle}
                className="flex items-center gap-1.5 text-sm font-medium text-mm-text truncate max-w-[clamp(120px,40vw,600px)] group hover:text-mm-text-secondary transition-colors text-left"
              >
                <span className="truncate">{document.name}</span>
                <Pencil className="w-3 h-3 text-mm-text-faint opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="start">
              <p>{document.name}</p>
              <p className="text-[10px] opacity-70 mt-0.5">Click to rename</p>
            </TooltipContent>
          </Tooltip>
        )}

        {/* Undo/redo */}
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            disabled={!history.canUndo}
            onClick={() => history.undo()}
            aria-label="Undo"
              title="Undo (Ctrl+Z)"
          >
            <Undo2 className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            disabled={!history.canRedo}
            onClick={() => history.redo()}
            aria-label="Redo"
              title="Redo (Ctrl+Y)"
          >
            <Redo2 className="w-4 h-4" />
          </Button>
        </div>

        {/* Column visibility toggles */}
        <div className="flex items-center gap-1 border-l border-mm-border-subtle pl-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setColumnVisibility(v => ({ ...v, codes: !v.codes }))}
            aria-pressed={showCodes}
            className={`text-xs gap-1 ${showCodes ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300' : 'text-mm-text-faint'}`}
            title={showCodes ? 'Hide the applied-codes column' : "Show each segment's applied codes"}
          >
            {showCodes ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
            Codes
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setColumnVisibility(v => ({ ...v, notes: !v.notes }))}
            aria-pressed={showNotes}
            className={`text-xs gap-1 ${showNotes ? 'bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300' : 'text-mm-text-faint'}`}
            title={showNotes ? 'Hide the notes column' : "Show each segment's notes"}
          >
            {showNotes ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
            Notes
          </Button>
          {(document?.image_positions?.length ?? 0) > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setColumnVisibility(v => ({ ...v, images: !v.images }))}
              aria-pressed={showImages}
              className={`text-xs gap-1 ${showImages ? 'bg-sky-50 dark:bg-sky-900/30 text-sky-700 dark:text-sky-300' : 'text-mm-text-faint'}`}
              title={showImages ? 'Hide inline document images' : 'Show inline document images'}
            >
              {showImages ? <Image className="w-3.5 h-3.5" /> : <ImageOff className="w-3.5 h-3.5" />}
              Images
            </Button>
          )}
        </div>

        {/* Original document viewer toggle */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowOriginal(v => !v)}
          aria-pressed={showOriginal}
          className={`text-xs gap-1 border-l border-mm-border-subtle pl-3 ${showOriginal ? 'bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300' : 'text-mm-text-faint'}`}
          title={showOriginal ? 'Close the original document view' : 'View the imported source document side-by-side'}
        >
          <FileText className="w-3.5 h-3.5" />
          Original
        </Button>

        {/* Tail group (#516): one ml-auto unit so at narrow widths it wraps to its
          * own right-aligned row instead of individual controls clipping off-screen. */}
        <div className="flex items-center gap-2 ml-auto">

        {savedIndicator && (
          <span className="text-sm text-green-600 flex items-center gap-1">
            <Check className="w-4 h-4" />
            Saved
          </span>
        )}

        {/* Progress — explicit progressbar semantics (Track J · J1 item 3c a11y;
          * the gauge previously had only a sighted-only title). Filter-aware count;
          * per-coder breakdown in multi-coder mode. */}
        <div
          className="flex items-center gap-2"
          role="progressbar"
          aria-label="Coding progress"
          aria-valuenow={codedCount}
          aria-valuemin={0}
          aria-valuemax={visibleSegments.length}
          aria-valuetext={
            blind
              // #503: not "by you" — archived colleagues' codings still count
              // in gauges under blind (#451 CHIPS-ONLY rule).
              ? `${codedCount} of ${visibleSegments.length} segments coded (colleagues hidden) (${progressPercent}%)`
              : effectiveHidden.size > 0
                ? `${codedCount} of ${visibleSegments.length} segments coded by visible coders (${progressPercent}%)`
                : `${codedCount} of ${visibleSegments.length} segments coded (${progressPercent}%)`
          }
        >
          <span
            className="text-sm text-mm-text-secondary font-mono tabular-nums"
            // #517: while blind this gauge shows only coding visible to you; the
            // documents list shows all-coder coverage — reconcile at the gauge.
            title={blind
              ? "Colleagues' coding is hidden (blind coding) — this count reflects only coding visible to you. The documents list and Overview show all coders' coverage."
              : undefined}
          >
            {codedCount}/{visibleSegments.length} coded
          </span>
          <div
            className="w-32 h-2 rounded overflow-hidden"
            style={progressGradient}
            title={`${codedCount} of ${visibleSegments.length} segments coded (${progressPercent}%)${blind ? ' — colleagues hidden (blind coding)' : ''}`}
          />
          <span className="text-sm font-medium">{progressPercent}%</span>
        </div>

        {multiCoder && <BlindModeToggle blind={blind} onToggle={toggleReveal} surface="document_workbench" />}
        <CoderCountBadge projectId={projectId} documentId={documentId} enabled={multiCoder} />

        {/* Codebook */}
        <Button variant="ghost" size="icon" onClick={openCodebook} title="Codebook" aria-label="Codebook">
          <BookOpen className="w-4 h-4" />
        </Button>

        </div>{/* end tail group (#516) */}
      </div>

      {/* ── Main content ── */}
      <div className="flex flex-1 min-h-0">
        {/* Original document viewer panel */}
        {showOriginal && (
          <div
            className="relative border-r bg-mm-surface flex flex-col shrink-0"
            style={{ width: originalPanelWidth }}
          >
            <div className="flex items-center gap-2 px-3 py-1.5 border-b bg-mm-bg">
              <FileText className="w-3.5 h-3.5 text-mm-text-faint" />
              <span className="text-xs font-medium text-mm-text-muted truncate flex-1">
                {document.name}
              </span>
              {document.source_format === 'docx' && (
                <a
                  href={documentsApi.getOriginalUrl(projectId, documentId)}
                  download={document.name}
                  className="text-xs text-purple-600 hover:text-purple-700 dark:text-purple-400 flex items-center gap-1"
                >
                  <Download className="w-3 h-3" />
                  Download
                </a>
              )}
              <button
                onClick={() => setShowOriginal(false)}
                className="p-0.5 rounded hover:bg-mm-surface-hover text-mm-text-faint hover:text-mm-text"
                aria-label="Close original viewer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-auto">
              {document.source_format === 'pdf' && (
                <iframe
                  ref={iframeRef}
                  src={pdfUrl}
                  className="w-full h-full border-0"
                  title="Original document"
                />
              )}

              {document.source_format === 'txt' && (
                <pre className="p-4 text-sm text-mm-text whitespace-pre-wrap font-sans leading-relaxed">
                  {txtContent ?? 'Loading...'}
                </pre>
              )}

              {document.source_format === 'docx' && (
                <div className="flex flex-col items-center justify-center h-full gap-3 p-6 text-center">
                  <FileText className="w-10 h-10 text-mm-text-faint" />
                  <p className="text-sm text-mm-text-muted">
                    Word documents cannot be previewed inline.
                  </p>
                  <a
                    href={documentsApi.getOriginalUrl(projectId, documentId)}
                    download={document.name}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium bg-purple-600 text-white hover:bg-purple-700 transition-colors"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Download Original
                  </a>
                </div>
              )}
            </div>

            {/* Resize handle on right edge */}
            <div
              className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize z-10 hover:bg-purple-400 transition-colors"
              onMouseDown={e => {
                e.preventDefault()
                const startX = e.clientX
                const startW = originalPanelWidth
                const doc = window.document
                const onMove = (ev: MouseEvent) => {
                  const newW = Math.min(800, Math.max(300, startW + (ev.clientX - startX)))
                  setOriginalPanelWidth(newW)
                }
                const onUp = () => {
                  doc.removeEventListener('mousemove', onMove)
                  doc.removeEventListener('mouseup', onUp)
                  doc.body.style.cursor = ''
                  doc.body.style.userSelect = ''
                }
                doc.body.style.cursor = 'col-resize'
                doc.body.style.userSelect = 'none'
                doc.addEventListener('mousemove', onMove)
                doc.addEventListener('mouseup', onUp)
              }}
            />
          </div>
        )}

        {/* Center panel: Document segments */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Column header row */}
          <div
            className="flex-shrink-0 bg-mm-surface border-b px-4 py-2 flex items-center gap-2 font-medium text-sm text-mm-text-secondary"
            style={{ paddingRight: `calc(1rem + ${gutter.gutter}px)` }}
          >
            {/* Quote filter toggle */}
            <button
              className={`w-5 flex-shrink-0 transition-colors ${
                quotedFilter ? 'text-mm-blue' : 'text-purple-400 hover:text-mm-blue'
              }`}
              onClick={() => setQuotedFilter(!quotedFilter)}
              title={quotedFilter ? 'Show all segments' : 'Show quoted segments only'}
            >
              <Quote className={`w-4 h-4 ${quotedFilter ? 'fill-mm-blue' : ''}`} />
            </button>

            {/* Search */}
            <div className="flex-1 relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-mm-text-faint z-10" />
              <Input
                value={textFilter}
                onChange={e => setTextFilter(e.target.value)}
                placeholder="Search segments..."
                className="h-7 pl-7 pr-7 text-sm border-purple-200 dark:border-purple-800 focus-visible:ring-purple-500"
              />
              {textFilter && (
                <button
                  onClick={() => setTextFilter('')}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-mm-text-faint hover:text-mm-text-secondary z-10"
                  aria-label="Clear search"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Codes pill (#739: Codes -> Notes on every coding surface) */}
            {showCodes && (
              <div data-col="codes" className="w-[160px] flex-shrink-0 flex items-center gap-1.5">
                <span className="bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 rounded-full px-2.5 py-0.5 text-xs font-medium">Codes</span>
                {coders.length > 1 && !blind && (
                  <CoderFilterPopover
                    coders={coders}
                    activeCoderId={user?.id ?? null}
                    hidden={hiddenCoders}
                    onChange={setHiddenCoders}
                    activeCoderIds={coderCoverage.isLoaded ? coderCoverage.activeCoderIds : undefined}
                    extraCoders={coderCoverage.extraCoders}
                    showArchived={showArchivedCoders}
                    onShowArchivedChange={setShowArchivedCoders}
                  />
                )}
              </div>
            )}

            {/* Notes pill — trailing track, so it declares the same 40px the
                row cell does. It was a bare span: aligned only because Codes
                used to be last (#666/#741 shape). */}
            {showNotes && (
              <div data-col="notes" className="w-[40px] flex-shrink-0 flex items-center justify-center">
                <span className="bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 rounded-full px-2 py-0.5 text-xs font-medium">Notes</span>
              </div>
            )}
          </div>

          {/* Segment list */}
          <div className="flex-1 min-h-0 bg-mm-surface" ref={segmentListRef}>
            <Virtuoso
              scrollerRef={gutter.setScroller}
              ref={virtuosoRef}
              data={listItems}
              overscan={200}
              components={documentComponents}
              context={documentListContext}
              itemContent={(_index, item) => {
                if (item.type === 'image') {
                  return (
                    <ContextMenu>
                      <ContextMenuTrigger asChild>
                        {/* #436: non-selectable image content — presentation keeps it out of the listbox's option set. */}
                        <div role="presentation" className="px-3 py-2 flex justify-center border-b border-mm-border-subtle bg-mm-bg/50">
                          <img
                            src={documentsApi.getImageUrl(projectId, documentId, item.imageIndex)}
                            alt="Embedded image from document"
                            loading="lazy"
                            className="max-w-full max-h-[400px] object-contain rounded"
                          />
                        </div>
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        <ContextMenuItem
                          disabled={item.afterSeqOrder <= 0}
                          onClick={() => moveImageMutation.mutate({
                            imageIndex: item.imageIndex,
                            afterSequenceOrder: item.afterSeqOrder - 1,
                          })}
                        >
                          <ArrowUp className="w-3.5 h-3.5 mr-2" />
                          Move Up
                        </ContextMenuItem>
                        <ContextMenuItem
                          disabled={item.afterSeqOrder >= maxSeqOrder}
                          onClick={() => moveImageMutation.mutate({
                            imageIndex: item.imageIndex,
                            afterSequenceOrder: item.afterSeqOrder + 1,
                          })}
                        >
                          <ArrowDown className="w-3.5 h-3.5 mr-2" />
                          Move Down
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem
                          className="text-red-600 dark:text-red-400"
                          onClick={() => deleteImageMutation.mutate(item.imageIndex)}
                        >
                          <Trash2 className="w-3.5 h-3.5 mr-2" />
                          Delete Image
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  )
                }
                const seg = item.segment
                return (
                  <DocumentSegmentRow
                    key={seg.id}
                    positionInSet={segIdToOptionOrdinal.get(seg.id) ?? 1}
                    setSize={filteredSegments.length}
                    segment={seg}
                    isSelected={selectedSet.has(seg.id)}
                    isEditing={editingSegmentId === seg.id}
                    onClick={(e) => handleSegmentClick(seg.id, e)}
                    onDoubleClick={() => setEditingSegmentId(seg.id)}
                    onEditSave={(text) => handleSegmentEdit(seg.id, text)}
                    onEditCancel={() => setEditingSegmentId(null)}
                    showCodes={showCodes}
                    showNotes={showNotes}
                    showPageNumber={isPdf}
                    segmentationMode={document.segmentation_mode}
                    codeMap={codeMap}
                    allCodes={codes}
                    projectId={projectId}
                    onCodeChange={invalidateAfterCodeChange}
                    onFocusCode={handleFocusCode}
                    coderMap={chipCoderMap}
                    hiddenCoderIds={chipHidden}
                    activeCoderId={selfId}
                    onToggleQuote={handleToggleQuote}
                    onContextCodeApply={handleContextCodeApply}
                    onContextCreateCode={(coords) => {
                      setCreateCodeDialog({ position: coords, segmentIds: [...selectedSegments], initialName: selectionPrefill() })
                    }}
                    onContextCreateNote={(segmentId, coords) => {
                      setCreateNoteDialog({ position: coords, segmentId })
                    }}
                    onRightClickSelect={() => setSelectedSegments([seg.id])}
                    codes={codes}
                    canMerge={canMerge}
                    selectedCount={selectedSegments.length}
                    onMergeSegments={() => handleMergeSegments(selectedSegments)}
                    onUnmergeSegment={handleUnmergeSegment}
                    onUnsplitSegment={handleUnsplitSegment}
                    textSelection={getTextSelectionForSegment(seg.id)}
                    onSplitAtSelection={splitSelection && splitSelection.ranges.some(r => r.segment_id === seg.id) ? handleSplitFromSelection : undefined}
                    documentName={document.name}
                    onNoteClick={() => {
                      setSelectedSegments([seg.id])
                      setPanelStates(p => ({ ...p, notes: { collapsed: false } }))
                      setFocusedPanel('notes')
                    }}
                  />
                )
              }}
            />
          {/* Split toolbar - floating near text selection */}
          {splitSelection && (
            <SplitToolbar
              position={splitSelection.rect}
              onSplit={handleSplitFromSelection}
              onCancel={handleCancelSplit}
            />
          )}

          {/* Split selection announcements */}
          <div role="status" aria-live="polite" className="sr-only">{splitAnnouncement}</div>
          </div>
          {/*
            #35 / #868 (b) — the rating strip, mounted BELOW the list rather than
            inside a row, for the two reasons the conversation workbench records:
            no room for a tick row in the Codes column at 640×360, and the rows
            are virtualised — a conditional child inside a row risks the remount
            that drops DOM focus to <body> (#826). Outside the scroller, neither
            can happen. Keyed on the target (#870 c) so a second scaled apply
            remounts it with a fresh cursor and focus.
          */}
          {ratingTarget && ratingTarget.code.magnitude_scale && (
            // py-1, not py-2: the vertical budget at 640×360 is 85px for the
            // whole control (measured; see MagnitudeStrip's root comment).
            <div className="border-t border-mm-border bg-mm-surface px-3 py-1 shrink-0">
              <MagnitudeStrip
                key={`${ratingTarget.segmentId}-${ratingTarget.code.id}`}
                codeName={ratingTarget.code.name}
                scale={ratingTarget.code.magnitude_scale}
                value={currentMagnitude(ratingTarget.segmentId, ratingTarget.code.id)}
                onCommit={commitMagnitude}
                onSkip={() => setRatingTarget(null)}
              />
            </div>
          )}
        </div>

        {/* Right panel — fixed width (#565: the resizer never worked; removed) */}
        <div className="relative border-l bg-mm-surface flex flex-col shrink-0 w-80">
          {/* Codes */}
          <CollapsiblePanel
            title="Codes"
            isCollapsed={panelStates.codes.collapsed}
            onToggle={() => togglePanel('codes')}
            className={panelStates.codes.collapsed ? '' : 'flex-[2] min-h-0'}
            headerExtra={
              <button
                onClick={(e) => { e.stopPropagation(); handleJumpToNextUncoded() }}
                className="text-[10px] text-mm-text-muted hover:text-mm-text-secondary transition-colors"
              >
                Jump to uncoded ⏭
              </button>
            }
          >
            <PageErrorBoundary>
              <CodePanel
                ref={codePanelRef}
                codes={codes}
                projectId={projectId}
                selectedCodesMap={selectedCodesMap}
                onCodeToggle={handleCodeToggle}
                onMultiCodeToggle={handleMultiCodeToggle}
                onCreateCode={(name) => createCodeMutation.mutate(name)}
                onAddCodeMemo={(codeId, codeName) => setCreateMemoForCode({ id: codeId, name: codeName })}
                disabled={selectedSegments.length === 0}
                categories={chordCategories}
                isFocused={focusedPanel === 'codes'}
                onFocusChange={focused => { if (focused) setFocusedPanel('codes') }}
                onNavigateToTranscript={() => { setFocusedPanel('document'); containerRef.current?.focus() }}
                onNavigateToPrevPanel={() => { setFocusedPanel('document'); containerRef.current?.focus() }}
                onNavigateToNextPanel={() => {
                  if (!panelStates.notes.collapsed) setFocusedPanel('notes')
                  else if (!panelStates.memos.collapsed) setFocusedPanel('memos')
                }}
              />
            </PageErrorBoundary>
          </CollapsiblePanel>

          {/* Notes */}
          <CollapsiblePanel
            title="Notes"
            isCollapsed={panelStates.notes.collapsed}
            onToggle={() => togglePanel('notes')}
            className={panelStates.notes.collapsed ? '' : 'flex-1 min-h-0'}
            headerExtra={
              <span className="text-xs text-mm-text-faint">{docNotes.length}</span>
            }
          >
            <PageErrorBoundary>
              <DocumentNotesPanel
                notes={docNotes}
                selectedSegmentId={selectedSegments.length === 1 ? selectedSegments[0] : null}
                noteInput={noteInput}
                onNoteInputChange={setNoteInput}
                onCreateNote={handleCreateNote}
                isCreating={createNoteMutation.isPending}
                onJumpToSegment={(segId) => {
                  setSelectedSegments([segId])
                  const listIdx = segIdToListIndex.get(segId)
                  if (listIdx != null) virtuosoRef.current?.scrollToIndex({ index: listIdx, align: 'center', behavior: 'smooth' })
                }}
                segmentationMode={document.segmentation_mode}
              />
            </PageErrorBoundary>
          </CollapsiblePanel>

          {/* Memos */}
          <CollapsiblePanel
            title="Memos"
            isCollapsed={panelStates.memos.collapsed}
            onToggle={() => togglePanel('memos')}
            className={panelStates.memos.collapsed ? '' : 'flex-1 min-h-0'}
          >
            <PageErrorBoundary>
              <MemoPanel
                ref={memoPanelRef}
                projectId={projectId}
                entityId={documentId}
                entityType="document"
                codes={codes}
                createForCode={createMemoForCode}
                onCreateForCodeHandled={() => setCreateMemoForCode(null)}
                isFocused={focusedPanel === 'memos'}
                onFocusChange={focused => { if (focused) setFocusedPanel('memos') }}
                onNavigateToTranscript={() => { setFocusedPanel('document'); containerRef.current?.focus() }}
                onNavigateToPrevPanel={() => {
                  if (!panelStates.notes.collapsed) setFocusedPanel('notes')
                  else if (!panelStates.codes.collapsed) setFocusedPanel('codes')
                }}
                onNavigateToNextPanel={() => {}}
              />
            </PageErrorBoundary>
          </CollapsiblePanel>

        </div>
      </div>

      {/* Status bar */}
      <div className="px-4 py-1.5 border-t bg-mm-surface text-xs text-muted-foreground flex items-center gap-4 shrink-0">
        <span>Document</span>
        {selectedSegments.length > 0 && <span>{selectedSegments.length} selected</span>}
        <div className="flex-1" />
        <span className="opacity-60">{codeKeyHint(codes)} · s: quote · c: create code · n: note · j: next uncoded · Ctrl+Z/Y: undo/redo</span>
      </div>

      {/* Floating create code dialog */}
      {createCodeDialog && (
        <FloatingCreateCode
          position={createCodeDialog.position}
          projectId={projectId}
          initialName={createCodeDialog.initialName}
          categories={categories}
          onCreated={async (code) => {
            const segmentIds = createCodeDialog.segmentIds
            setCreateCodeDialog(null)

            if (segmentIds.length === 0) return

            // Apply the new code to all selected segments in one undo entry
            history.execute({
              type: 'code_apply',
              description: `Apply code "${code.name}" to ${segmentIds.length} segment(s)`,
              redo: async () => {
                if (segmentIds.length === 1) {
                  await codingApi.applyCode(segmentIds[0], code.id)
                } else {
                  reportBulkOutcome(await codingApi.bulkCode(segmentIds, code.id, 'apply'), 'apply')
                }
                invalidateAfterCodeChange()
              },
              undo: async () => {
                if (segmentIds.length === 1) {
                  await codingApi.removeCode(segmentIds[0], code.id)
                } else {
                  reportBulkOutcome(await codingApi.bulkCode(segmentIds, code.id, 'remove'), 'remove')
                }
                invalidateAfterCodeChange()
              },
            })
            showSaved()
            toast.success(`Created "${code.name}" and applied to ${segmentIds.length} segment${segmentIds.length > 1 ? 's' : ''}`)
          }}
          onClose={() => setCreateCodeDialog(null)}
        />
      )}

      {/* Floating create note dialog */}
      {createNoteDialog && (
        <FloatingCreateNote
          position={createNoteDialog.position}
          isPending={createNotePending}
          onSubmit={async (content) => {
            setCreateNotePending(true)
            try {
              await documentsApi.createNote(projectId, documentId, {
                segment_id: createNoteDialog.segmentId,
                content,
              })
              invalidateNotes()
              setCreateNoteDialog(null)
              setPanelStates(p => ({ ...p, notes: { collapsed: false } }))
              setFocusedPanel('notes')
            } finally {
              setCreateNotePending(false)
            }
          }}
          onClose={() => setCreateNoteDialog(null)}
        />
      )}

      {/* ── Chord indicator ── */}
      {chordPrefix !== null && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-mm-surface border border-mm-border-medium rounded-lg px-4 py-2 shadow-lg z-50">
          <span className="text-sm font-mono text-mm-text">{chordPrefix}.</span>
          <span className="text-sm text-mm-text-muted ml-1">
            {pendingCategoryName ? `${pendingCategoryName} — press 1-9` : 'press 1-9 for code'}
          </span>
        </div>
      )}
    </div>
  )
}


// ── Document Segment Row ──

/* Exported for `DocumentSegmentRow.a11y.test.tsx` only — the row's tab-stop
 * population needs a real render, and #785's whole lesson is that a guard naming
 * the controls somebody thought of misses the next one. No other importer. */
export function DocumentSegmentRow({
  segment,
  isSelected,
  isEditing,
  onClick,
  onDoubleClick,
  onEditSave,
  onEditCancel,
  showCodes,
  showNotes,
  showPageNumber,
  segmentationMode,
  codeMap,
  allCodes,
  projectId,
  onCodeChange,
  onFocusCode,
  coderMap,
  hiddenCoderIds,
  activeCoderId,
  onToggleQuote,
  onContextCodeApply,
  onContextCreateCode,
  onContextCreateNote,
  onRightClickSelect,
  codes,
  canMerge,
  selectedCount,
  onMergeSegments,
  onUnmergeSegment,
  onUnsplitSegment,
  textSelection,
  onSplitAtSelection,
  documentName,
  onNoteClick,
  positionInSet,
  setSize,
}: {
  /**
   * #751 — 1-based ordinal among SEGMENTS and the segment count, NOT the index
   * into `listItems` or its length. `listItems` interleaves `type: 'image'` rows
   * which render `role="presentation"` and are deliberately outside the option
   * set (#436), so using the list index would count images and announce a total
   * that includes them — a new wrong number in place of the old one.
   */
  positionInSet: number
  setSize: number
  segment: VisibleSegment
  isSelected: boolean
  isEditing: boolean
  onClick: (e: React.MouseEvent) => void
  onDoubleClick: () => void
  onEditSave: (text: string) => void
  onEditCancel: () => void
  showCodes: boolean
  showNotes: boolean
  showPageNumber: boolean
  segmentationMode: string
  codeMap: Map<number, Code>
  allCodes: Code[]
  projectId: number
  onCodeChange: () => void
  onFocusCode?: (codeId: number) => void
  coderMap?: Map<number, Coder>
  hiddenCoderIds?: Set<number>
  activeCoderId?: number | null
  onToggleQuote: (segmentId: number) => void
  onContextCodeApply: (segmentId: number, codeId: number) => void
  onContextCreateCode?: (coords: FloatingCoords) => void
  onContextCreateNote?: (segmentId: number, coords: FloatingCoords) => void
  onRightClickSelect?: () => void
  codes: Code[]
  canMerge: boolean
  selectedCount: number
  onMergeSegments: () => void
  onUnmergeSegment: (segmentId: number) => void
  onUnsplitSegment: (segmentId: number) => void
  textSelection?: { start: number; end: number } | null
  onSplitAtSelection?: () => void
  documentName?: string
  onNoteClick?: (noteId: number) => void
}) {
  const [editText, setEditText] = useState(segment.text)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [showUnmergeDialog, setShowUnmergeDialog] = useState(false)
  const [showUnsplitDialog, setShowUnsplitDialog] = useState(false)
  const lastCoordsRef = useRef<FloatingCoords>({ x: 0, y: 0 })

  const codeIdToShortcutLabel = useCodeShortcutLabels(codes)

  /* eslint-disable react-hooks/set-state-in-effect -- initialize edit text and focus on edit start */
  useEffect(() => {
    if (isEditing) {
      setEditText(segment.text)
      setTimeout(() => {
        textareaRef.current?.focus()
        textareaRef.current?.select()
      }, 0)
    }
  }, [isEditing, segment.text])
  /* eslint-enable react-hooks/set-state-in-effect */

  // Badge label — adapt to segmentation mode
  const badgeLabel = useMemo(() => {
    if (segment.heading_level) return `H${segment.heading_level}`
    const n = segment.sequence_order + 1
    switch (segmentationMode) {
      case 'sentence': return `S${n}`
      case 'page': return `P${n}`
      default: return String(n)
    }
  }, [segment.heading_level, segment.sequence_order, segmentationMode])

  const badgeAriaLabel = segment.heading_level
    ? `Heading level ${segment.heading_level}, segment ${segment.sequence_order + 1}`
    : `Segment ${segment.sequence_order + 1}`

  /* #790 — TWO FACTS, and they were one variable.
   *
   * `hasAnyQuote` is shape-AGNOSTIC: "does this segment carry a quote of any
   * kind", which is the right question for the amber fill and the filter.
   * `isWholeQuoted` is shape-EXACT: it is what the gutter button's toggle
   * actually creates and deletes (`handleToggleQuote` reads `has_whole_segment`).
   *
   * Merged, the button announced "Unquote" on a segment carrying only a
   * SUB-SEGMENT quote — where pressing it CREATES a whole-segment one. A verb
   * naming the opposite of what the press does is the worst version of this,
   * and `excerpt-shape.ts::isWholeExcerpt`'s own docstring already says which
   * predicate drives a toggle. */
  const hasAnyQuote = segment.excerpt_info?.has_whole_segment || (segment.excerpt_info?.sub_segment_count ?? 0) > 0
  const isWholeQuoted = segment.excerpt_info?.has_whole_segment ?? false
  const hasExcerpt = hasAnyQuote
  return (
    <>
    <ContextMenu>
      {/* #436: asChild so the trigger merges onto the option div instead of inserting a
          generic <span> between the listbox's presentation wrapper and the option. */}
      <ContextMenuTrigger asChild>
        <div
          id={`segment-${segment.id}`}
          className={cn(
            'flex items-start gap-2 px-4 py-2 border-b border-mm-border-subtle transition-colors cursor-pointer group',
            isSelected
              ? 'bg-purple-50 dark:bg-purple-900/20 border-l-[3px] border-l-purple-500'
              : 'hover:bg-mm-surface-hover border-l-[3px] border-l-transparent',
          )}
          // #436: option role makes aria-selected valid (listbox = the Virtuoso List).
          role="option"
          aria-selected={isSelected}
          // #751: ordinals among segments only — see the prop's doc comment.
          {...optionPositionAria(positionInSet, setSize)}
          onContextMenu={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            lastCoordsRef.current = {
              x: e.clientX,
              y: e.clientY,
              anchorRect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
            }
            if (!isSelected) onRightClickSelect?.()
          }}
          onMouseDown={(e) => {
            if (isEditing) return
            if (e.button === 0) onClick(e)
          }}
          onDoubleClick={onDoubleClick}
        >
          {/* Quote gutter */}
          {/* #785/#790 — parity with SegmentRow, which this row had drifted from
            * in three ways: the tab stop was ungated (20 rendered rows = 20 stops,
            * every one named the same word), the name said neither which segment
            * nor, via `aria-pressed`, what state it was in, and the state it DID
            * announce came from the shape-agnostic flag. */}
          <button
            className={`w-5 flex-shrink-0 pt-0.5 ${hasExcerpt ? '' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'} transition-opacity`}
            onClick={e => { e.stopPropagation(); onToggleQuote(segment.id) }}
            tabIndex={isSelected ? undefined : -1}
            title={isWholeQuoted ? 'Unquote segment' : 'Quote segment'}
            aria-label={`Quote segment ${positionInSet}`}
            aria-pressed={isWholeQuoted}
          >
            <Quote className={`w-3.5 h-3.5 ${hasExcerpt ? 'fill-amber-400 text-amber-400' : 'text-mm-text-faint hover:text-amber-400'}`} />
          </button>

          {/* Segment badge */}
          <span
            className={cn(
              'inline-flex items-center justify-center shrink-0 rounded text-[10px] font-mono leading-none mt-0.5',
              segment.heading_level
                ? 'px-1.5 py-1 bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400 font-semibold'
                : 'w-6 text-mm-text-faint'
            )}
            aria-label={badgeAriaLabel}
          >
            {badgeLabel}
          </span>

          {/* Page number (PDF) */}
          {showPageNumber && segment.page_number !== null && (
            <span className="shrink-0 text-[10px] text-mm-text-faint font-mono mt-0.5" title={`Page ${segment.page_number}`}>
              p.{segment.page_number}
            </span>
          )}

          {/* Text content */}
          <div className="flex-1 min-w-0">
            {isEditing ? (
              <textarea
                ref={textareaRef}
                aria-label="Edit segment text"
                value={editText}
                onChange={e => setEditText(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault()
                    onEditSave(editText)
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    onEditCancel()
                  }
                }}
                onBlur={() => onEditSave(editText)}
                className="w-full text-sm text-mm-text border rounded p-1.5 focus:outline-none focus:ring-1 focus:ring-purple-500 resize-none min-h-[40px]"
                rows={3}
              />
            ) : (
              <p
                data-segment-id={segment.id}
                className={cn(
                  'text-sm leading-relaxed text-mm-text whitespace-pre-wrap',
                  segment.heading_level && 'font-semibold',
                  segment.heading_level === 1 && 'text-base',
                  segment.heading_level === 2 && 'text-[15px]',
                )}
              >
                {textSelection && textSelection.start < textSelection.end
                  ? <>
                      {sliceByCodePoints(segment.text, 0, textSelection.start)}
                      <mark className="bg-mm-blue/30 text-foreground rounded-sm px-px">{sliceByCodePoints(segment.text, textSelection.start, textSelection.end)}</mark>
                      {sliceByCodePoints(segment.text, textSelection.end, codePointLength(segment.text))}
                    </>
                  : segment.text}
              </p>
            )}
          </div>

          {/* Codes column (#739) */}
          {showCodes && (
            <div data-col="codes" className="w-[160px] flex-shrink-0 flex items-center">
              {segment.codes.length > 0 && !isEditing && (
                <InlineCodeActions
                  tabbable={isSelected}
                  projectId={projectId}
                  itemType="segment"
                  itemId={segment.id}
                  appliedCodeIds={segment.codes.map(c => c.id)}
                  codeMap={codeMap}
                  allCodes={allCodes}
                  onCodeChange={onCodeChange}
                  onFocusCode={onFocusCode}
                  coderMap={coderMap}
                  // #868 (a): the projection carries the rating and the merge
                  // flag. It once built `{ code_id, user_id }` from a payload
                  // that had neither, and the chip then announced "not rated"
                  // over a rating it could not see. Both fields are REQUIRED on
                  // the detail type now, so dropping one here does not compile.
                  appliedCodeDetails={segment.codes.map(c => ({
                    code_id: c.id, user_id: c.user_id,
                    magnitude: c.magnitude, magnitude_conflict: c.magnitude_conflict,
                  }))}
                  hiddenCoderIds={hiddenCoderIds}
                />
              )}
            </div>
          )}

          {/* Notes column — trailing narrow track (#739) */}
          {showNotes && (
            <div data-col="notes" className="w-[40px] flex-shrink-0 flex flex-col items-center justify-center gap-0.5">
              {segment.attached_notes.map(note => (
                <button
                  key={note.id}
                  className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 text-[10px] font-medium hover:bg-amber-200 dark:hover:bg-amber-800/50 transition-colors"
                  onClick={e => {
                    e.stopPropagation()
                    onNoteClick?.(note.id)
                  }}
                  title={`Note ${note.sequence_number}`}
                >
                  {note.sequence_number}
                </button>
              ))}
            </div>
          )}
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent>
        {/* ── Primary coding actions ── */}
        <ContextMenuSub>
          <ContextMenuSubTrigger>Apply Code</ContextMenuSubTrigger>
          <ContextMenuSubContent className="max-h-64 overflow-y-auto w-52">
            {onContextCreateCode && (
              <>
                <ContextMenuItem onClick={() => onContextCreateCode(lastCoordsRef.current)}>
                  New Code...
                </ContextMenuItem>
                <ContextMenuSeparator />
              </>
            )}
            {codes.filter(c => c.is_active).map(code => {
              const applied = segment.codes.some(c => c.id === code.id && (activeCoderId == null || c.user_id === activeCoderId))
              const label = codeIdToShortcutLabel.get(code.id) ?? ''
              return (
                <ContextMenuItem
                  key={code.id}
                  onClick={() => onContextCodeApply(segment.id, code.id)}
                >
                  <span className="flex items-center gap-2 flex-1 min-w-0">
                    {applied && <Check className="w-3 h-3 text-green-600 flex-shrink-0" />}
                    <span
                      className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                      style={{ backgroundColor: getCodeColor(code) }}
                    />
                    <span className={cn('truncate', applied && 'font-bold')}>{code.name}</span>
                  </span>
                  {label && (
                    <span className="text-xs text-mm-text-faint ml-2 font-mono flex-shrink-0">{label}</span>
                  )}
                </ContextMenuItem>
              )
            })}
          </ContextMenuSubContent>
        </ContextMenuSub>
        {onContextCreateNote && (
          <ContextMenuItem onClick={() => onContextCreateNote(segment.id, lastCoordsRef.current)}>
            Add Note
          </ContextMenuItem>
        )}
        <ContextMenuItem onClick={() => onToggleQuote(segment.id)}>
          {hasExcerpt ? 'Unquote' : 'Quote'}
        </ContextMenuItem>
        <ContextMenuSeparator />
        {/* ── Structural operations ── */}
        <ContextMenuItem onClick={onDoubleClick}>
          Edit Text (F2)
        </ContextMenuItem>
        {onSplitAtSelection && (
          <ContextMenuItem onClick={onSplitAtSelection}>
            Split at Selection
          </ContextMenuItem>
        )}
        {canMerge && (
          <ContextMenuItem onClick={onMergeSegments}>
            Merge {selectedCount} Segments
          </ContextMenuItem>
        )}
        {!!segment.is_merge_result && (
          <ContextMenuItem onClick={() => setShowUnmergeDialog(true)}>
            Unmerge
          </ContextMenuItem>
        )}
        {!!segment.is_split_result && (
          <ContextMenuItem onClick={() => setShowUnsplitDialog(true)}>
            Rejoin
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        {/* ── Clipboard ── */}
        <ContextMenuItem
          onClick={() => {
            navigator.clipboard.writeText(segment.text)
          }}
        >
          Copy Text
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => {
            const quote = `"${segment.text}" — ${documentName || 'Document'}`
            navigator.clipboard.writeText(quote)
          }}
        >
          Copy as Quote
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>

    {/* Unmerge confirmation dialog */}
    <AlertDialog open={showUnmergeDialog} onOpenChange={setShowUnmergeDialog}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Unmerge Segment</AlertDialogTitle>
          <AlertDialogDescription className="space-y-2">
            <p>This will restore the original segments from before the merge.</p>
            {segment.codes.length > 0 ? (
              <p className="font-medium text-amber-600">
                Warning: This segment has {segment.codes.length} code(s) applied.
                Any codes, notes, or memos added to this merged segment will be lost.
              </p>
            ) : (
              <p className="text-mm-text-muted">
                Any notes or memos added to the merged segment will be lost.
              </p>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              onUnmergeSegment(segment.id)
              setShowUnmergeDialog(false)
            }}
          >
            Unmerge
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    {/* Rejoin confirmation dialog */}
    <AlertDialog open={showUnsplitDialog} onOpenChange={setShowUnsplitDialog}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Rejoin Segment</AlertDialogTitle>
          <AlertDialogDescription className="space-y-2">
            <p>This will restore the original segment from before the split, removing all split parts.</p>
            <p className="text-mm-text-muted">
              Any codes or notes added to the split segments will be lost. The original segment&apos;s codes and notes will be restored.
            </p>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              onUnsplitSegment(segment.id)
              setShowUnsplitDialog(false)
            }}
          >
            Rejoin
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  )
}


// ── Document Notes Panel (simplified) ──

function DocumentNotesPanel({
  notes,
  selectedSegmentId,
  noteInput,
  onNoteInputChange,
  onCreateNote,
  isCreating,
  onJumpToSegment,
  segmentationMode,
}: {
  notes: import('@/lib/api').DocumentNote[]
  selectedSegmentId: number | null
  noteInput: string
  onNoteInputChange: (value: string) => void
  onCreateNote: () => void
  isCreating: boolean
  onJumpToSegment: (segmentId: number) => void
  segmentationMode: string
}) {
  return (
    <div className="h-full flex flex-col">
      {/* Create input */}
      <div className="p-3 border-b space-y-1">
        <div className="flex gap-2">
          <Input
            value={noteInput}
            onChange={e => onNoteInputChange(e.target.value)}
            onKeyDown={e => {
              if ((e.key === 'Tab' || e.key === 'Enter') && noteInput.trim()) {
                e.preventDefault()
                onCreateNote()
              }
            }}
            placeholder={selectedSegmentId ? 'Add note to selected segment...' : 'Select a segment first'}
            disabled={!selectedSegmentId}
            className="h-8 text-sm"
          />
          <Button
            size="sm"
            variant="ghost"
            disabled={!noteInput.trim() || !selectedSegmentId || isCreating}
            onClick={onCreateNote}
            title="Add note (Tab or Enter)"
          >
            <span className="text-xs">Add</span>
          </Button>
        </div>
        {noteInput.trim() && selectedSegmentId && (
          <p className="text-xs text-green-600"><kbd className="px-1 py-0.5 bg-mm-bg border border-mm-border-medium rounded text-[10px] font-mono">Tab</kbd>{' or '}<kbd className="px-1 py-0.5 bg-mm-bg border border-mm-border-medium rounded text-[10px] font-mono">Enter</kbd>{' to create note'}</p>
        )}
        {!selectedSegmentId && (
          <p className="text-xs text-mm-text-faint">Select a segment to add a note</p>
        )}
      </div>

      {/* Notes list */}
      <div className="flex-1 overflow-y-auto">
        {notes.length === 0 ? (
          <div className="p-4 text-sm text-mm-text-muted text-center">
            No notes yet
          </div>
        ) : (
          notes.map(note => (
            <div
              key={note.id}
              className="px-3 py-2 border-b border-mm-border-subtle hover:bg-mm-surface-hover cursor-pointer group"
              onClick={() => {
                if (note.segment_id) onJumpToSegment(note.segment_id)
              }}
            >
              <div className="flex items-start gap-2">
                {note.segment_sequence_order !== null && (
                  <span className="inline-flex items-center justify-center min-w-5 h-5 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 text-[10px] font-medium shrink-0 px-1">
                    {segmentationMode === 'sentence' ? `S${note.segment_sequence_order}` : segmentationMode === 'page' ? `P${note.segment_sequence_order}` : note.segment_sequence_order}
                  </span>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-mm-text line-clamp-2">{note.content}</p>
                  {note.segment_text_snippet && (
                    <p className="text-xs text-mm-text-faint mt-0.5 truncate italic">
                      {note.segment_text_snippet}
                    </p>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
