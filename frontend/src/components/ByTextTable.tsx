import {
  useRef, useEffect, useState, useMemo, forwardRef, useImperativeHandle,
  type MouseEvent as ReactMouseEvent, type RefObject, type Ref,
} from 'react'
import { TableVirtuoso, type TableVirtuosoHandle, type TableComponents } from 'react-virtuoso'
import { SELECTED_CELL } from '@/lib/selection'
import { useSegmentSelection } from '@/hooks/useSegmentSelection'
import { useCodeShortcutLabels } from '@/hooks/useCodeShortcutLabels'
import { Quote } from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import { textCodingApi, type TextCodingResponse, type RecordContext, type Coder } from '@/lib/api'
import CodeChip from '@/components/qualitative-analysis/CodeChip'
import { useCoders } from '@/hooks/useCoders'
import { mergeArchivedIntoCoderMap, chipHiddenWithArchived } from '@/lib/coder-color'
import { visibleCodeChipRows } from '@/lib/coding-progress'
import TextCodingContextMenu from '@/components/TextCodingContextMenu'
import type { FloatingCoords } from '@/lib/floating-utils'
import {
  ContextMenu,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'

interface ByTextTableProps {
  comments: TextCodingResponse[]
  loading: boolean
  selectedValueIds: number[]
  onSelectionChange: (ids: number[]) => void
  onQuoteToggle: (dvId: number) => void
  onContextCodeApply?: (dvId: number, codeId: number) => void
  onContextCreateCode?: (coords: FloatingCoords) => void
  onContextCreateNote?: (dvId: number, coords: FloatingCoords) => void
  contextVisible: { demographics: boolean; otherComments: boolean; nonComments: boolean }
  focalColumnIds: number[]
  projectId: number
  codes: Array<{ id: number; name: string; color: string | null; description?: string | null; is_active?: boolean; category_id?: number | null; category_color?: string | null; is_universal?: boolean; numeric_id?: number | null }>
  searchText?: string
  onClearSearch?: () => void
  hiddenCoderIds?: Set<number>  // Track J · J1 visibility filter
  activeCoderId?: number | null  // Track J · J1 active coder (#446 context-menu check)
  extraCoders?: Coder[]  // #451 archived-who-coded — folded into the chip map
  showArchived?: boolean  // #451 "view all coders" — reveal archived chips
  /**
   * #844 — how many texts the CURRENT SELECTION holds, which is not how many
   * are loaded. `comments` is the loaded prefix; this is the whole set.
   *
   * It drives `aria-rowcount`, which ARIA defines as the total row count when
   * it is known — so a screen-reader user hears "row 40 of 12,431" and learns
   * the list continues past what is rendered, rather than "40 of 40".
   */
  totalRowCount?: number
  /** #844 — called when the scroller reaches the end, to load the next page. */
  onEndReached?: () => void
}

/**
 * #717 — the frozen band's geometry lives in ONE custom property.
 *
 * The quote column's WIDTH and the Text column's sticky LEFT offset must be the
 * same number: Text pins immediately after the quote toggle. They were two
 * literals in four places (`w-5` and `left-[20px]`, header and body), so changing
 * one silently misaligned the other into a seam or an overlap that reads as a
 * rendering artifact. A CSS variable is the only way to single-source it here —
 * Tailwind needs literal class strings, so a TS constant could not feed both.
 *
 * ## Why the band relaxes below a container width
 *
 * Measured at a 640px viewport: the scroller is 322px, the quote column 20px and
 * the Text column 300px — so 320 of 322px was permanently covered by sticky cells
 * and `Codes` and `Notes` were **never visible at any scroll position**. Sticky
 * columns are an affordance only while there is something left to scroll; past
 * that they are an occlusion. Below `STICKY_RELAX_AT` nothing is sticky and the
 * table behaves like an ordinary wide table, which is honest at that size.
 *
 * ⚠️ The container context sits on a wrapper OUTSIDE the Virtuoso scroller, not on
 * the scroller itself. `container-type: inline-size` applies size containment, and
 * this project has already been bitten by CSS perturbing the
 * `getBoundingClientRect` react-virtuoso measures (#697 rejected CSS `zoom` for
 * exactly that). Keeping the containment off the measured element avoids it.
 */
const QUOTE_COL_W = '20px'
/**
 * ⚠️ `width` ALONE is not enough on a table cell. Measured: `width: 20px` with the
 * cell's `px-1` padding computed to **22px**, because the table layout algorithm may
 * widen a cell past its specified width — so Text pinned at 20px while the quote
 * column occupied 22, leaving a 2px seam of the quote column showing through the
 * sticky edge. The pre-#717 `w-5` + `left-[20px]` pair had the same defect; it is
 * only visible when you measure the two against each other, which is the argument
 * for deriving both from one value AND clamping the cell so it cannot drift.
 */
const QUOTE_COL_CLAMP = { width: QUOTE_COL_W, minWidth: QUOTE_COL_W, maxWidth: QUOTE_COL_W } as const
/** Below this container width the frozen band would occlude more than it reveals. */
const STICKY_RELAX_AT = '@max-[560px]:static'

/**
 * What the module-scope Virtuoso components need, threaded through the
 * `context` prop (#826).
 *
 * 🔴 **These used to be closed over by inline arrow components declared inside
 * the render**, so every render handed react-virtuoso NEW component identities
 * and React destroyed and rebuilt the whole `<table>`. `selectedValueIds` was
 * among the captured values, so a SELECTION CHANGE guaranteed the remount —
 * and DOM focus went with the detached node, landing on `<body>`. Proved by
 * tagging the node across a real keypress: `sameElement: false`,
 * `oldStillInDocument: false`.
 *
 * The ARIA still looked correct in a snapshot (`aria-activedescendant` is set
 * on the NEW table), and sighted keyboard use was unaffected because the shared
 * keyboard layer treats focus-on-body as its own — which is exactly why nothing
 * static and no unit test could see it. `aria-activedescendant` is honoured
 * only on the element that HAS focus, so a browse-mode reader was told nothing
 * while the researcher arrowed through 36 records.
 *
 * `frontend-a11y.md` states the module-scope rule; three of the four
 * virtualised coding surfaces already followed it (`transcriptComponents` /
 * `documentComponents` / `clipListComponents`). This was the fourth.
 */
interface ByTextTableContext {
  activeDescendantId?: string
  rowCount: number
  selectedValueIds: number[]
  dvIdToIndex: Map<number, number>
  onRowClick: (dvId: number, e: ReactMouseEvent) => void
  onSelectionChange: (ids: number[]) => void
  lastCoordsRef: RefObject<FloatingCoords>
  activeCodes: ByTextTableProps['codes']
  codeIdToShortcutLabel: Map<number, string>
  onQuoteToggle: (dvId: number) => void
  onContextCodeApply?: (dvId: number, codeId: number) => void
  onContextCreateCode?: (coords: FloatingCoords) => void
  onContextCreateNote?: (dvId: number, coords: FloatingCoords) => void
  activeCoderId?: number | null
}

const byTextComponents: TableComponents<TextCodingResponse, ByTextTableContext> = {
  Table: function ByTextGrid({ context, ...props }) {
    // #436: grid semantics so aria-selected is valid on the selectable rows
    // (a multi-select data grid; native <tr>=row, <td>=cell satisfy the structure).
    // #484: focusable grid + aria-activedescendant so a screen reader follows the
    // window-level arrow-nav (rows carry id=`text-${dataset_value_id}`; the last-selected
    // row is the active descendant — single-step nav announces the moved-to row exactly).
    return (
      <table
        {...props}
        role="grid"
        aria-multiselectable="true"
        tabIndex={0}
        aria-activedescendant={context?.activeDescendantId}
        className="min-w-full bg-mm-surface border-separate border-spacing-0"
        aria-rowcount={context?.rowCount ?? 0}
        aria-label="Open-text responses with the codes applied to each"
      />
    )
  },
  TableRow: function ByTextRow({ item, context, ...props }) {
    if (!context) return <tr {...props} />
    const isSelected = item ? context.selectedValueIds.includes(item.dataset_value_id) : false
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <tr
            {...props}
            id={item ? `text-${item.dataset_value_id}` : undefined}
            className={`cursor-pointer group transition-colors ${isSelected ? 'border-l-[3px] border-[hsl(var(--mm-blue)/0.7)]' : 'hover:bg-mm-surface-hover border-l-[3px] border-l-transparent'}`}
            aria-rowindex={(item ? context.dvIdToIndex.get(item.dataset_value_id) ?? 0 : 0) + 1}
            aria-selected={isSelected}
            onClick={item ? (e) => context.onRowClick(item.dataset_value_id, e) : undefined}
            onContextMenu={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              context.lastCoordsRef.current = {
                x: e.clientX,
                y: e.clientY,
                anchorRect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
              }
              if (item && !context.selectedValueIds.includes(item.dataset_value_id)) {
                context.onSelectionChange([item.dataset_value_id])
              }
            }}
          />
        </ContextMenuTrigger>
        {item && (
          <TextCodingContextMenu
            comment={item}
            activeCodes={context.activeCodes}
            codeIdToShortcutLabel={context.codeIdToShortcutLabel}
            onQuoteToggle={context.onQuoteToggle}
            onContextCodeApply={context.onContextCodeApply}
            onContextCreateCode={context.onContextCreateCode}
            onContextCreateNote={context.onContextCreateNote}
            lastCoordsRef={context.lastCoordsRef}
            activeCoderId={context.activeCoderId}
          />
        )}
      </ContextMenu>
    )
  },
}

/**
 * The scroller, exposed to the page (#825).
 *
 * `handleJumpToNextUncoded` lives in `TextCodingView` and could only change
 * `selectedValueIds` — this component owned the Virtuoso ref privately and was
 * not a `forwardRef`, so **nothing the jump could call moved the viewport.**
 * Measured: the button advanced `aria-activedescendant` to a row react-virtuoso
 * had never rendered, `scrollTop` stayed 0, no row carried
 * `aria-selected="true"`, and the next chord coded a record the researcher
 * could not see. Both sibling workbenches hold their own ref and call
 * `scrollToIndex` on the jump path; this one had zero call sites.
 */
export interface ByTextTableHandle {
  /** Bring the row at `index` (into the `comments` array) into view. */
  scrollToIndex: (index: number) => void
}

function ByTextTable({
  comments,
  loading,
  selectedValueIds,
  onSelectionChange,
  onQuoteToggle,
  onContextCodeApply,
  onContextCreateCode,
  onContextCreateNote,
  contextVisible,
  focalColumnIds,
  projectId,
  codes,
  searchText,
  onClearSearch,
  hiddenCoderIds,
  activeCoderId,
  extraCoders,
  showArchived,
  totalRowCount,
  onEndReached,
}: ByTextTableProps, ref: Ref<ByTextTableHandle>) {
  const virtuosoRef = useRef<TableVirtuosoHandle>(null)

  // The jump path's only channel into the scroller. `align: 'center'` matches
  // the two sibling workbenches' jump calls.
  useImperativeHandle(ref, () => ({
    scrollToIndex: (index: number) => {
      virtuosoRef.current?.scrollToIndex({ index, align: 'center', behavior: 'smooth' })
    },
  }), [])

  // Context data for records (loaded on demand)
  const [contextCache, setContextCache] = useState<Record<number, RecordContext>>({})
  const loadingRef = useRef(new Set<number>())

  // Clear context cache when focal columns or project changes.
  //
  // ⚠️ This is the ONLY thing `focalColumnIds` is used for since #719 removed the
  // per-row column label — do not delete the prop as unused, and do not "simplify"
  // the call site's `activeColumnId ? [activeColumnId] : focalColumnIds` narrowing
  // away: it decides how often this cache clears. Correctness does not hinge on it
  // (`recordContext` is fetched per ROW and takes no column ids, so a stale entry
  // cannot be wrong for a different column) — it is conservative invalidation, which
  // is why the narrowing is safe either way.
  const focalKey = focalColumnIds.join(',')
  useEffect(() => {
    setContextCache({})
    loadingRef.current = new Set<number>()
  }, [focalKey, projectId])

  const needsContext = contextVisible.demographics || contextVisible.otherComments || contextVisible.nonComments

  // Load context for records when context toggles are on
  useEffect(() => {
    if (!needsContext) return
    const uniqueRowIds = [...new Set(comments.map(c => c.dataset_row_id))]
    const toLoad = uniqueRowIds.filter(rid => !contextCache[rid] && !loadingRef.current.has(rid))
    if (toLoad.length === 0) return

    // Mark all as loading to prevent duplicate requests
    for (const rid of toLoad) loadingRef.current.add(rid)

    // Load in batches of 10, sequentially
    let cancelled = false
    const loadBatches = async () => {
      for (let i = 0; i < toLoad.length; i += 10) {
        if (cancelled) break
        const batch = toLoad.slice(i, i + 10)
        try {
          const results = await Promise.all(
            batch.map(rid =>
              textCodingApi.recordContext(projectId, rid).then(ctx => [rid, ctx] as const)
            )
          )
          if (cancelled) break
          setContextCache(prev => {
            const next = { ...prev }
            for (const [rid, ctx] of results) next[rid] = ctx
            return next
          })
        } catch {
          // Remove failed IDs from loading set so they can be retried
          for (const rid of batch) loadingRef.current.delete(rid)
        }
      }
    }
    loadBatches()

    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsContext, comments, projectId])

  const { handleItemClick: handleRowClick, handleArrowNav } = useSegmentSelection({
    items: comments,
    getId: (c) => c.dataset_value_id,
    selectedIds: selectedValueIds,
    onSelectionChange,
    scrollToIndex: (idx) => {
      virtuosoRef.current?.scrollToIndex({ index: idx, behavior: 'smooth' })
    },
  })

  // Keyboard navigation within table
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return
      if (target.closest('[data-panel="codes"]')) return

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        handleArrowNav(e.key === 'ArrowDown' ? 1 : -1, { extend: e.shiftKey })
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleArrowNav])

  const codeMap = useMemo(() => Object.fromEntries(codes.map(c => [c.id, c])), [codes])
  const { coderMap, multiCoder } = useCoders()  // attribution badges (Track J · J1, multi-coder only)
  // #451: fold archived-who-coded into the chip map (render attributed) + hide them
  // by default unless "view all coders" is on.
  const effectiveCoderMap = useMemo(() => mergeArchivedIntoCoderMap(coderMap, extraCoders ?? []), [coderMap, extraCoders])
  const chipHidden = useMemo(
    () => chipHiddenWithArchived(hiddenCoderIds ?? new Set(), new Set((extraCoders ?? []).map(c => c.id)), !!showArchived),
    [hiddenCoderIds, extraCoders, showArchived],
  )

  // Pre-compute index map for O(1) lookup in TableRow
  const dvIdToIndex = useMemo(() => {
    const map = new Map<number, number>()
    comments.forEach((c, i) => map.set(c.dataset_value_id, i))
    return map
  }, [comments])

  const activeCodes = useMemo(() => codes.filter(c => c.is_active !== false), [codes])

  const codeIdToShortcutLabel = useCodeShortcutLabels(codes)

  // Capture right-click coordinates for floating dialogs
  const lastCoordsRef = useRef<FloatingCoords>({ x: 0, y: 0 })

  // #826: everything the module-scope Table/TableRow need, in ONE object whose
  // identity may change freely — Virtuoso passes it as a prop, so a change
  // re-renders the table and never remounts it.
  const listContext = useMemo<ByTextTableContext>(() => ({
    activeDescendantId: selectedValueIds.length > 0
      ? `text-${selectedValueIds[selectedValueIds.length - 1]}`
      : undefined,
    // #844: the SELECTION's size, not the loaded prefix's. Loaded rows are a
    // prefix of the ordering, so `dvIdToIndex` still yields correct global
    // `aria-rowindex` values against this larger count.
    rowCount: totalRowCount ?? comments.length,
    selectedValueIds,
    dvIdToIndex,
    onRowClick: handleRowClick,
    onSelectionChange,
    lastCoordsRef,
    activeCodes,
    codeIdToShortcutLabel,
    onQuoteToggle,
    onContextCodeApply,
    onContextCreateCode,
    onContextCreateNote,
    activeCoderId,
  }), [
    selectedValueIds, comments.length, totalRowCount, dvIdToIndex, handleRowClick, onSelectionChange,
    activeCodes, codeIdToShortcutLabel, onQuoteToggle, onContextCodeApply,
    onContextCreateCode, onContextCreateNote, activeCoderId,
  ])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Loading texts...
      </div>
    )
  }

  if (comments.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        No texts found. Try adjusting your filters.
      </div>
    )
  }

  return (
    <TooltipProvider delayDuration={300}>
    <TableVirtuoso
      ref={virtuosoRef}
      data={comments}
      overscan={10}
      // #844: load the next page as the researcher reaches the end. Virtuoso
      // fires this repeatedly while the end stays in view, so the handler must
      // be idempotent — `fetchNextPage` already is (React Query drops a call
      // while one is in flight or when no page remains).
      endReached={onEndReached}
      fixedHeaderContent={() => (
        <tr className="bg-mm-surface">
          <th scope="col" className={`px-1 sticky left-0 z-20 bg-mm-surface ${STICKY_RELAX_AT}`} style={QUOTE_COL_CLAMP} aria-label="Quote" />
          <th scope="col" className="px-4 py-2 text-left w-[120px] bg-mm-surface">
            <span className="bg-orange-50 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300 rounded-full px-2.5 py-0.5 text-xs font-medium">Record</span>
          </th>
          <th scope="col" className={`px-4 py-2 text-left sticky z-20 bg-mm-surface border-r border-mm-border-subtle min-w-[220px] xl:min-w-[300px] ${STICKY_RELAX_AT}`} style={{ left: QUOTE_COL_W }}>
            <div className="flex items-center gap-2">
              <span className="bg-orange-50 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300 rounded-full px-2.5 py-0.5 text-xs font-medium">Text</span>
              {searchText && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded text-[10px] font-normal">
                  Filtered: "{searchText}"
                  {onClearSearch && (
                    <button
                      className="ml-0.5 hover:text-amber-900"
                      onClick={onClearSearch}
                      aria-label="Clear search"
                    >
                      ×
                    </button>
                  )}
                </span>
              )}
            </div>
          </th>
          <th data-col="codes" scope="col" className="px-4 py-2 text-left w-[160px] bg-mm-surface">
            <span className="bg-orange-50 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300 rounded-full px-2.5 py-0.5 text-xs font-medium">Codes</span>
          </th>
          <th data-col="notes" scope="col" className="px-4 py-2 text-center w-[48px] bg-mm-surface">
            <span className="bg-orange-50 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300 rounded-full px-2.5 py-0.5 text-xs font-medium">Notes</span>
          </th>
          {contextVisible.demographics && (
            <th scope="col" className="px-4 py-2 text-left bg-[hsl(var(--mm-ctx-demo))]" aria-label="Context: Demographics">
              <span className="bg-orange-50 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300 rounded-full px-2.5 py-0.5 text-xs font-medium">Demo</span>
            </th>
          )}
          {contextVisible.otherComments && (
            <th scope="col" className="px-4 py-2 text-left bg-[hsl(var(--mm-ctx-comments))]" aria-label="Context: Other texts">
              <span className="bg-orange-50 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300 rounded-full px-2.5 py-0.5 text-xs font-medium">Other texts</span>
            </th>
          )}
          {contextVisible.nonComments && (
            <th scope="col" className="px-4 py-2 text-left bg-[hsl(var(--mm-ctx-responses))]" aria-label="Context: Other columns">
              <span className="bg-orange-50 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300 rounded-full px-2.5 py-0.5 text-xs font-medium">Responses</span>
            </th>
          )}
        </tr>
      )}
      itemContent={(_index, comment) => {
        const isSelected = selectedValueIds.includes(comment.dataset_value_id)
        const ctx = contextCache[comment.dataset_row_id]

        return (
          <>
            <td className={`px-1 py-2 border-b text-center sticky left-0 z-10 ${STICKY_RELAX_AT} ${isSelected ? SELECTED_CELL : 'bg-mm-surface group-hover:bg-mm-surface-hover'}`} style={QUOTE_COL_CLAMP}>
              <button
                className={`shrink-0 ${comment.is_quoted ? '' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'} transition-opacity`}
                onClick={e => { e.stopPropagation(); onQuoteToggle(comment.dataset_value_id) }}
                aria-label={comment.is_quoted ? 'Unquote' : 'Quote'}
              >
                <Quote className={`w-3.5 h-3.5 ${comment.is_quoted ? 'fill-amber-400 text-amber-400' : 'text-mm-text-faint'}`} />
              </button>
            </td>
            <td
              className={`w-[120px] px-4 py-2 border-b ${isSelected ? SELECTED_CELL : 'bg-mm-surface group-hover:bg-mm-surface-hover'}`}
            >
              <span className="font-mono text-xs truncate block">
                {comment.row_identifier || comment.participant_name || `R${comment.dataset_row_id}`}
              </span>
            </td>
            <td
              className={`px-4 py-2 border-b border-r border-mm-border-subtle text-sm sticky z-10 ${STICKY_RELAX_AT} ${isSelected ? SELECTED_CELL : 'bg-mm-surface group-hover:bg-mm-surface-hover'}`}
              style={{ left: QUOTE_COL_W }}
            >
              {/* #719: NO per-row column label here, and that is the design, not a
                  gap. By Text PAGES one column at a time — the toolbar carries the
                  column picker, prev/next and "1 of N" — so every row on screen
                  answers the same question and a per-row prompt would repeat it once
                  per row. Reading ACROSS columns is By Record's job, and it already
                  labels each answer with its column name and a "Col N" badge
                  (`ByRecordPanel.tsx`). Copy from there if this view ever interleaves.

                  A guarded version of both affordances lived here and had never
                  painted: the call site narrows the prop to the active column, so the
                  guard was always false. Deleted rather than wired up, because the
                  capability already ships one mode over. */}
              {comment.value_text ? (
                <span>{comment.value_text}</span>
              ) : (
                <span className="italic text-muted-foreground">Empty response</span>
              )}
            </td>
            <td data-col="codes" className={`w-[160px] px-4 py-2 border-b ${isSelected ? SELECTED_CELL : ''}`}>
              <div className="flex flex-wrap gap-1">
                {visibleCodeChipRows(comment.applied_code_details ?? [], chipHidden).map(row => {
                  const code = codeMap[row.codeId]
                  if (!code) return null
                  const coder = (multiCoder && row.userId != null) ? effectiveCoderMap.get(row.userId) ?? null : null
                  return (
                    <CodeChip
                      key={row.key}
                      code={{ id: code.id, name: code.name, color: code.color }}
                      size="xs"
                      coder={coder}
                    />
                  )
                })}
              </div>
            </td>
            <td data-col="notes" className={`w-[48px] px-4 py-2 border-b text-center ${isSelected ? SELECTED_CELL : ''}`}>
              {comment.note_count > 0 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 text-[10px] font-medium cursor-default">
                      {comment.note_count}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    {comment.note_count} note{comment.note_count > 1 ? 's' : ''} — select to view
                  </TooltipContent>
                </Tooltip>
              )}
            </td>
            {contextVisible.demographics && (
              <td className="px-4 py-2 border-b bg-[hsl(var(--mm-ctx-demo)/0.5)] text-xs">
                {ctx ? (
                  ctx.demographics?.map((d) => (
                    <div key={d.column_id} className="truncate">
                      <span className="text-muted-foreground">{d.column_name}:</span> {d.value || '—'}
                    </div>
                  ))
                ) : (
                  <span className="text-muted-foreground animate-pulse">···</span>
                )}
              </td>
            )}
            {contextVisible.otherComments && (
              <td className="px-4 py-2 border-b bg-[hsl(var(--mm-ctx-comments)/0.5)] text-xs" style={{ minWidth: 200, maxWidth: 320 }}>
                {ctx ? (
                  ctx.texts?.filter((oc) => oc.column_id !== comment.column_id).slice(0, 3).map((oc) => (
                    <Tooltip key={oc.column_id}>
                      <TooltipTrigger asChild>
                        <div className="mb-2 last:mb-0 cursor-default">
                          <div className="text-[10px] text-muted-foreground truncate">{oc.column_name}</div>
                          <div className="line-clamp-3">{oc.value || '—'}</div>
                        </div>
                      </TooltipTrigger>
                      {oc.value && (
                        <TooltipContent side="left" className="max-w-sm max-h-60 overflow-y-auto text-sm whitespace-pre-wrap">
                          <div className="text-[10px] opacity-70 mb-1">{oc.column_name}</div>
                          {oc.value}
                        </TooltipContent>
                      )}
                    </Tooltip>
                  ))
                ) : (
                  <span className="text-muted-foreground animate-pulse">···</span>
                )}
              </td>
            )}
            {contextVisible.nonComments && (
              <td className="px-4 py-2 border-b bg-[hsl(var(--mm-ctx-responses)/0.5)] text-xs">
                {ctx ? (
                  <>
                    {ctx.other_columns?.slice(0, 3).map((nc) => (
                      <div key={nc.column_id} className="truncate">
                        <span className="text-muted-foreground">{nc.column_name}:</span> {nc.value || '—'}
                      </div>
                    ))}
                    {ctx.other_columns?.length > 3 && (
                      <div className="text-muted-foreground">+{ctx.other_columns.length - 3} more</div>
                    )}
                  </>
                ) : (
                  <span className="text-muted-foreground animate-pulse">···</span>
                )}
              </td>
            )}
          </>
        )
      }}
      components={byTextComponents}
      context={listContext}
    />
    </TooltipProvider>
  )
}

export default forwardRef(ByTextTable)
