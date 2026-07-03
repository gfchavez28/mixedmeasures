import { useRef, useEffect, useState, useMemo } from 'react'
import { TableVirtuoso, type TableVirtuosoHandle } from 'react-virtuoso'
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
}

export default function ByTextTable({
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
}: ByTextTableProps) {
  const virtuosoRef = useRef<TableVirtuosoHandle>(null)

  // Context data for records (loaded on demand)
  const [contextCache, setContextCache] = useState<Record<number, RecordContext>>({})
  const loadingRef = useRef(new Set<number>())

  // Clear context cache when focal columns or project changes
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

  const hasMultipleColumns = focalColumnIds.length > 1

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
      fixedHeaderContent={() => (
        <tr className="bg-mm-surface">
          <th scope="col" className="w-5 px-1 sticky left-0 z-20 bg-mm-surface" aria-label="Quote" />
          <th scope="col" className="px-4 py-2 text-left w-[120px] bg-mm-surface">
            <span className="bg-orange-50 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300 rounded-full px-2.5 py-0.5 text-xs font-medium">Record</span>
          </th>
          <th scope="col" className="px-4 py-2 text-left sticky left-[20px] z-20 bg-mm-surface border-r border-mm-border-subtle" style={{ minWidth: 300 }}>
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
          <th scope="col" className="px-4 py-2 text-left w-[160px] bg-mm-surface">
            <span className="bg-orange-50 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300 rounded-full px-2.5 py-0.5 text-xs font-medium">Codes</span>
          </th>
          <th scope="col" className="px-4 py-2 text-center w-[48px] bg-mm-surface">
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
            <td className={`w-5 px-1 py-2 border-b text-center sticky left-0 z-10 ${isSelected ? SELECTED_CELL : 'bg-mm-surface group-hover:bg-mm-surface-hover'}`}>
              <button
                className={`shrink-0 ${comment.is_quoted ? '' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'} transition-opacity`}
                onClick={e => { e.stopPropagation(); onQuoteToggle(comment.dataset_value_id) }}
                aria-label={comment.is_quoted ? 'Unquote' : 'Quote'}
              >
                <Quote className={`w-3.5 h-3.5 ${comment.is_quoted ? 'fill-amber-400 text-amber-400' : 'text-mm-border-medium'}`} />
              </button>
            </td>
            <td
              className={`w-[120px] px-4 py-2 border-b ${isSelected ? SELECTED_CELL : 'bg-mm-surface group-hover:bg-mm-surface-hover'}`}
            >
              <span className="font-mono text-xs truncate block">
                {comment.row_identifier || comment.participant_name || `R${comment.dataset_row_id}`}
              </span>
              {hasMultipleColumns && (
                <div className="text-[11px] text-muted-foreground mt-0.5 truncate">{comment.column_name || comment.column_text}</div>
              )}
              {hasMultipleColumns && (
                <span
                  className="inline-block mt-0.5 px-1 py-0.5 text-[9px] bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 rounded"
                  title={`This text appeared at position ${comment.column_sequence_order} in ${comment.dataset_name}`}
                >
                  Col {comment.column_sequence_order}
                </span>
              )}
            </td>
            <td
              className={`px-4 py-2 border-b border-r border-mm-border-subtle text-sm sticky left-[20px] z-10 ${isSelected ? SELECTED_CELL : 'bg-mm-surface group-hover:bg-mm-surface-hover'}`}
            >
              {comment.value_text ? (
                <span>{comment.value_text}</span>
              ) : (
                <span className="italic text-muted-foreground">Empty response</span>
              )}
            </td>
            <td className={`w-[160px] px-4 py-2 border-b ${isSelected ? SELECTED_CELL : ''}`}>
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
            <td className={`w-[48px] px-4 py-2 border-b text-center ${isSelected ? SELECTED_CELL : ''}`}>
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
      components={{
        Table: (props) => (
          // #436: grid semantics so aria-selected is valid on the selectable rows
          // (a multi-select data grid; native <tr>=row, <td>=cell satisfy the structure).
          // #484: focusable grid + aria-activedescendant so a screen reader follows the
          // window-level arrow-nav (rows carry id=`text-${dataset_value_id}`; the last-selected
          // row is the active descendant — single-step nav announces the moved-to row exactly).
          <table
            {...props}
            role="grid"
            aria-multiselectable="true"
            tabIndex={0}
            aria-activedescendant={
              selectedValueIds.length > 0
                ? `text-${selectedValueIds[selectedValueIds.length - 1]}`
                : undefined
            }
            className="min-w-full bg-mm-surface border-separate border-spacing-0"
            aria-rowcount={comments.length}
          />
        ),
        TableRow: ({ item, ...props }) => {
          const isSelected = item ? selectedValueIds.includes(item.dataset_value_id) : false
          return (
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <tr
                  {...props}
                  id={item ? `text-${item.dataset_value_id}` : undefined}
                  className={`cursor-pointer group transition-colors ${isSelected ? 'border-l-[3px] border-[hsl(var(--mm-blue)/0.7)]' : 'hover:bg-mm-surface-hover border-l-[3px] border-l-transparent'}`}
                  aria-rowindex={(item ? dvIdToIndex.get(item.dataset_value_id) ?? 0 : 0) + 1}
                  aria-selected={isSelected}
                  onClick={item ? (e) => handleRowClick(item.dataset_value_id, e) : undefined}
                  onContextMenu={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect()
                    lastCoordsRef.current = {
                      x: e.clientX,
                      y: e.clientY,
                      anchorRect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
                    }
                    if (item && !selectedValueIds.includes(item.dataset_value_id)) {
                      onSelectionChange([item.dataset_value_id])
                    }
                  }}
                />
              </ContextMenuTrigger>
              {item && (
                <TextCodingContextMenu
                  comment={item}
                  activeCodes={activeCodes}
                  codeIdToShortcutLabel={codeIdToShortcutLabel}
                  onQuoteToggle={onQuoteToggle}
                  onContextCodeApply={onContextCodeApply}
                  onContextCreateCode={onContextCreateCode}
                  onContextCreateNote={onContextCreateNote}
                  lastCoordsRef={lastCoordsRef}
                  activeCoderId={activeCoderId}
                />
              )}
            </ContextMenu>
          )
        },
      }}
    />
    </TooltipProvider>
  )
}
