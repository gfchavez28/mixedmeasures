/**
 * UnassignedPanel — right-side hideable panel listing columns that aren't
 * yet in any equivalence row. Replaces UnassignedDrawer (Phase 3.5, #319).
 *
 * Structure:
 *   - Fixed header region (title + count + close button)
 *   - Fixed sub-header region (BulkAssignToolbar when selections present)
 *   - Scrollable body (per-dataset collapsible sections, single-column pills)
 *
 * Drop target: the root uses `DRAWER_DROP_ID` (constant value preserved for
 * collision-detector compatibility — see useCrosswalkDnD.tsx).
 *
 * Per Phase 3.5 decisions:
 *   - Filter is via global header search (Option A), NOT a panel-local input.
 *   - BulkAssignToolbar lives in the non-scrolling sub-header region — it
 *     doesn't stack inside the scrollbody.
 *
 * Add-row redesign (commit 2 of the drag-first batch):
 *   - Each card is now individually draggable via `useDraggable` registered
 *     inside the memo'd `UnassignedCard` component (extracted from the
 *     inline .map body for perf — N useDraggable hooks would otherwise
 *     re-render every card on every drag activation).
 *   - The `<div ref={setNodeRef} {listeners}>` wraps the card body OUTSIDE
 *     the `<label>` so the native label/checkbox click semantics stay
 *     pristine (drag and click don't conflict — dnd-kit's PointerSensor
 *     with 3px activation distance gates the disambiguation).
 */

import { memo, useState, type MutableRefObject } from 'react'
import { useDraggable, useDroppable } from '@dnd-kit/core'
import { Inbox, X, ChevronDown, ChevronRight } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import type { ProjectColumnInfo } from './crosswalk-types'
import { DRAWER_DROP_ID, makeCellDragId } from './drop-ids'
import { useCellDragIdRegistry } from './useCellDragIdRegistry'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'

interface UnassignedPanelProps {
  unassigned: ProjectColumnInfo[]
  selectedIds: Set<number>
  onToggle: (column_id: number) => void
  searchHighlightIds: Set<number>
  searchActive: boolean
  /** Panel close button handler. */
  onClose: () => void
  /** Bulk-assign toolbar actions */
  onClearSelection?: () => void
  onBulkAssign?: () => void
  onSearchClear?: () => void
  blockDragStartRef?: MutableRefObject<boolean>
  onViewInDataset?: (col: ProjectColumnInfo) => void
  /** Single-item quick-add path — opens picker preset with this column. */
  onQuickAdd?: (col: ProjectColumnInfo) => void
  /** ID of the column currently being dragged (or null). Used per-card to
   * apply a faded "source" style so the user sees which card is moving.
   * Reduced to a primitive boolean before crossing UnassignedCard's memo
   * boundary (mirrors the foot-gun #332 perf invariant). */
  activeDragColumnId?: number | null
}

interface DatasetGroup {
  dataset_id: number
  dataset_name: string
  columns: ProjectColumnInfo[]
}

function groupByDataset(columns: ProjectColumnInfo[]): DatasetGroup[] {
  const map = new Map<number, DatasetGroup>()
  for (const col of columns) {
    const existing = map.get(col.dataset_id)
    if (existing) {
      existing.columns.push(col)
    } else {
      map.set(col.dataset_id, {
        dataset_id: col.dataset_id,
        dataset_name: col.dataset_name,
        columns: [col],
      })
    }
  }
  return Array.from(map.values()).sort((a, b) => a.dataset_id - b.dataset_id)
}

function summarizeTypes(columns: ProjectColumnInfo[]): string {
  const counts = new Map<string, number>()
  for (const col of columns) {
    counts.set(col.column_type, (counts.get(col.column_type) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => `${n} ${type}`)
    .join(', ')
}

interface UnassignedCardProps {
  column: ProjectColumnInfo
  isSelected: boolean
  isSearchMatch: boolean
  isDragSource: boolean
  onToggle: (id: number) => void
  onQuickAdd?: (col: ProjectColumnInfo) => void
  onViewInDataset?: (col: ProjectColumnInfo) => void
  blockDragStartRef?: MutableRefObject<boolean>
}

const UnassignedCard = memo(function UnassignedCard({
  column,
  isSelected,
  isSearchMatch,
  isDragSource,
  onToggle,
  onQuickAdd,
  onViewInDataset,
  blockDragStartRef,
}: UnassignedCardProps) {
  // Draggable wiring uses the same `cell-${id}` namespace as in-bracket
  // cells so the existing useCrosswalkDnD branches accept these drags
  // without a separate flow. The ref + listeners live on a `<div>` placed
  // outside the `<label>` so native label/checkbox click semantics aren't
  // mangled by dnd-kit's pointerdown listener.
  const dragId = makeCellDragId(column.id)
  // #341 dev-only F1 invariant check: warn loudly if the same drag-id
  // is registered by another surface (e.g. an in-bracket Cell). The two
  // surfaces' data filters are designed to be disjoint via
  // `computeUnassignedColumns(allColumns, domainMemberColumnIds)`; this
  // catches drift in production builds at zero runtime cost.
  useCellDragIdRegistry(dragId, 'UnassignedCard')
  const draggable = useDraggable({ id: dragId })

  const baseClass = isSelected
    ? 'bg-mm-blue/15 text-mm-blue border-mm-blue/40'
    : isSearchMatch
      ? 'bg-sky-200 dark:bg-sky-900 border-sky-600 text-mm-text'
      : 'bg-mm-surface border-mm-border-subtle text-mm-text hover:border-mm-border-medium'

  // Drag source dim — matches `crosswalk-cell-dragging` opacity rule used
  // in Cell.tsx. The DragOverlay renders the visible preview elsewhere.
  const dragSourceClass = isDragSource ? 'opacity-50' : ''

  return (
    <li>
      <ContextMenu
        onOpenChange={(open) => {
          if (blockDragStartRef) blockDragStartRef.current = open
        }}
      >
        <ContextMenuTrigger asChild>
          <div
            ref={draggable.setNodeRef}
            {...draggable.attributes}
            {...draggable.listeners}
            aria-grabbed={draggable.isDragging ? 'true' : undefined}
            className={`rounded transition-colors cursor-grab active:cursor-grabbing ${dragSourceClass}`}
            data-testid={`unassigned-card-${column.id}`}
          >
            <label
              className={`flex items-start gap-2 px-2 py-1.5 rounded border text-xs cursor-pointer transition-colors focus-within:ring-2 focus-within:ring-ring ${baseClass}`}
            >
              <Checkbox
                checked={isSelected}
                onCheckedChange={() => onToggle(column.id)}
                aria-label={`Select ${column.column_code ?? 'column'} ${column.column_text}`}
                className="mt-0.5"
              />
              <div className="flex-1 min-w-0">
                {column.column_code && (
                  <div className="font-mono text-[10px] text-mm-text-muted">
                    {column.column_code}
                  </div>
                )}
                <div className="text-xs leading-snug break-words">
                  {column.column_text}
                </div>
              </div>
            </label>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => onQuickAdd?.(column)}>
            Add to variable group…
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onSelect={() => onViewInDataset?.(column)}
            disabled={!onViewInDataset}
          >
            View in Dataset View
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </li>
  )
})

export const UnassignedPanel = memo(function UnassignedPanel({
  unassigned,
  selectedIds,
  onToggle,
  searchHighlightIds,
  searchActive,
  onClose,
  onClearSelection,
  onBulkAssign,
  onSearchClear,
  blockDragStartRef,
  onViewInDataset,
  onQuickAdd,
  activeDragColumnId = null,
}: UnassignedPanelProps) {
  const groups = groupByDataset(unassigned)
  const typeSummary = summarizeTypes(unassigned)

  // Track which dataset sections are collapsed. Default: all expanded.
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set())
  const toggleSection = (datasetId: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(datasetId)) next.delete(datasetId)
      else next.add(datasetId)
      return next
    })
  }

  const drop = useDroppable({ id: DRAWER_DROP_ID })
  const dropClass = drop.isOver ? 'crosswalk-panel-drop-over' : ''

  let hiddenSelectedCount = 0
  if (searchActive) {
    for (const id of selectedIds) {
      if (!searchHighlightIds.has(id)) hiddenSelectedCount++
    }
  }

  const hasSelections = selectedIds.size > 0

  return (
    <aside
      ref={drop.setNodeRef}
      data-testid="unassigned-panel"
      role="complementary"
      aria-label="Unassigned columns panel"
      className={`w-[300px] shrink-0 h-full flex flex-col bg-mm-surface border-l border-mm-border-subtle rounded-md overflow-hidden ${dropClass}`}
    >
      {/* Header (non-scrolling) */}
      <header className="flex items-center justify-between px-3 py-2 border-b border-mm-border-subtle shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <Inbox className="w-3.5 h-3.5 text-mm-text-secondary flex-none" aria-hidden />
          <h2 className="text-xs font-semibold text-mm-text-secondary uppercase tracking-wide">
            Unassigned
          </h2>
          <span className="text-[10px] text-mm-text-muted">
            {unassigned.length}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-0.5 rounded text-mm-text-muted hover:text-mm-text hover:bg-mm-bg focus-visible:ring-2 focus-visible:ring-ring focus:outline-none"
          aria-label="Close Unassigned panel"
          title="Close panel"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </header>

      {/* Sub-header: bulk-assign toolbar (non-scrolling; only rendered when selections exist) */}
      {hasSelections && (
        <div
          role="toolbar"
          aria-label="Bulk-assign selected columns"
          className="flex items-center gap-2 px-3 py-2 border-b border-mm-border-subtle bg-mm-bg shrink-0"
        >
          <div className="text-xs text-mm-text flex-1 min-w-0">
            <span className="font-semibold">{selectedIds.size}</span> selected
            {hiddenSelectedCount > 0 && onSearchClear && (
              <>
                {' '}
                <button
                  type="button"
                  onClick={onSearchClear}
                  className="text-mm-text-muted underline underline-offset-2 hover:text-mm-text"
                >
                  ({hiddenSelectedCount} hidden)
                </button>
              </>
            )}
          </div>
          <Button variant="outline" size="sm" onClick={onClearSelection}>
            Clear
          </Button>
          <Button size="sm" onClick={onBulkAssign} disabled={!onBulkAssign}>
            Add…
          </Button>
        </div>
      )}

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto">
        {unassigned.length === 0 ? (
          <p className="text-xs text-mm-text-muted italic px-3 py-4 leading-snug">
            All columns are assigned to a variable group. Drop a cell here to remove it.
          </p>
        ) : (
          <>
            <p className="text-[11px] text-mm-text-muted px-3 pt-2 pb-1 leading-snug">
              {typeSummary} · Drag a card into a variable group, or check boxes to bulk-assign.
            </p>
            <div className="px-2 pb-3">
              {groups.map((group) => {
                const isCollapsed = collapsed.has(group.dataset_id)
                return (
                  <div key={group.dataset_id} className="mt-2">
                    <button
                      type="button"
                      onClick={() => toggleSection(group.dataset_id)}
                      aria-expanded={!isCollapsed}
                      className="w-full flex items-center gap-1 px-1 py-1 rounded text-[11px] font-semibold text-mm-text-secondary uppercase tracking-wide hover:bg-mm-surface-hover focus-visible:ring-2 focus-visible:ring-ring focus:outline-none"
                    >
                      {isCollapsed ? (
                        <ChevronRight className="w-3 h-3 flex-none" aria-hidden />
                      ) : (
                        <ChevronDown className="w-3 h-3 flex-none" aria-hidden />
                      )}
                      <span className="truncate flex-1 text-left">{group.dataset_name}</span>
                      <span className="text-mm-text-muted font-normal normal-case tracking-normal">
                        {group.columns.length}
                      </span>
                    </button>
                    {!isCollapsed && (
                      <ul className="mt-1 flex flex-col gap-1">
                        {group.columns.map((col) => {
                          const isSearchMatch = searchHighlightIds.has(col.id)
                          const hiddenBySearch = searchActive && !isSearchMatch
                          if (hiddenBySearch) return null
                          return (
                            <UnassignedCard
                              key={col.id}
                              column={col}
                              isSelected={selectedIds.has(col.id)}
                              isSearchMatch={isSearchMatch}
                              isDragSource={activeDragColumnId === col.id}
                              onToggle={onToggle}
                              onQuickAdd={onQuickAdd}
                              onViewInDataset={onViewInDataset}
                              blockDragStartRef={blockDragStartRef}
                            />
                          )
                        })}
                      </ul>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    </aside>
  )
})

