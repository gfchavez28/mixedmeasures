/**
 * Crosswalk cell — one dataset column inside an equivalence row.
 *
 * Phase 3a: cells are BOTH drag sources and drop targets.
 * Phase 3b adds:
 *   - Empty-cell droppable (drag-to-empty slot → moveColumnMutation)
 *   - Cell context menu (Remove from row, Copy recode, View in Dataset View)
 *
 * Drag ID schemes:
 *   - data cell:  `cell-${column_id}` (draggable + droppable)
 *   - empty cell: `empty-${eg_id}-${dataset_id}` (droppable only)
 *
 * Perf pass (#332): both DataCell and EmptyCell are wrapped in React.memo
 * with default shallow compare. The parent (EquivalenceRow / OrphanRowItem)
 * derives all prop values to primitives or stable references — see those
 * components' useMemo'd `rowColumnIds`, `emptyFallbacks`, and
 * `rowMenuItems` bundles. The View-in-Dataset menu item used to need a
 * `columnsById` Map prop to resolve the cell's full column record; the
 * `onViewInDataset` signature now accepts the thin shape `{ id, dataset_id }`
 * (CrosswalkView's `handleViewInDataset` only reads those two fields), so
 * the Map prop has been dropped from the entire cell prop chain.
 */

import { memo, type MouseEvent, type MutableRefObject, type ReactNode } from 'react'
import type { CellData, EmptyCellData } from './crosswalk-types'
import { RotateCcw, AlertTriangle } from 'lucide-react'
import { useDraggable, useDroppable } from '@dnd-kit/core'
import { makeCellDragId, makeEmptyCellDropId } from './drop-ids'
import { useCellDragIdRegistry } from './useCellDragIdRegistry'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { TypePickerPopover } from './TypePickerPopover'
import { TypeBadge } from '@/components/TypeBadge'
import { DatasetDotButton } from './DatasetDotButton'

interface CellProps {
  cell: CellData | EmptyCellData
  /** Equivalence group id this cell belongs to (used to compose the empty
   * cell droppable id for empty placeholders). Null/omitted for synthetic
   * single-cell rows (Path A #325) — see `rowSyntheticColumnId` instead. */
  rowEgId?: number | null
  /** Path A #325: for synthetic single-cell rows, the column_id of the only
   * populated cell. Empty cells in synthetic rows are "promote-to-paired"
   * drop targets — wired in F3+F5 by emitting `empty-unlinked-${columnId}-${datasetId}`. */
  rowSyntheticColumnId?: number | null
  isSearchMatch?: boolean
  dndEnabled?: boolean
  isDragging?: boolean
  isConflictFlash?: boolean
  isSwapFlash?: boolean
  /** Column IDs present in the same row, used for Copy-recode sibling
   * resolution in the cell context menu. */
  rowColumnIds?: number[]
  onRemoveFromRow?: (columnId: number) => void
  onCopyRecode?: (cellColumnId: number, rowColumnIds: number[]) => void
  /** Phase 3.5 / #324 — when true, cell is a member of a variable group
   * (analysis domain). Enables the "Remove from variable group (keep
   * equivalence)" context-menu item alongside the existing "Remove from
   * equivalence row" item. */
  isDomainMember?: boolean
  onRemoveFromVariableGroup?: (columnId: number) => void
  blockDragStartRef?: MutableRefObject<boolean>
  /** View-in-Dataset target. Accepts the thin shape since `cell` already
   * carries both fields. */
  onViewInDataset?: (col: { id: number; dataset_id: number }) => void
  /** EmptyCell-only: when false, the empty placeholder is NOT registered
   * as a drop target. General-purpose extension point — currently no
   * caller passes false (default true = always droppable). Reserved for
   * future drag-policy logic. */
  emptyCellCanAcceptDrop?: boolean
  /** Extra ContextMenuItems appended to the cell's right-click menu —
   * used by Ungrouped rows to add row-level actions ("Add row to variable
   * group…", "Delete row") so the user can reach them without aiming for
   * the narrow row padding. Appended below the cell-level items with a
   * separator. */
  extraContextMenuItems?: ReactNode
  /** Path A #329: true when this cell is in the multi-select set. Renders
   * a persistent indigo ring on the cell. */
  isSelected?: boolean
  /** Cell click handler. Called on every click; the handler decides
   * whether to act (typically only on modKey clicks) so plain click stays
   * a focus/no-op gesture. `modKey` is true when Cmd (Mac) or Ctrl
   * (Windows/Linux) was held. */
  onCellClick?: (columnId: number, modKey: boolean) => void
  /** Phase 4.4: project ID + dataset ID + column ID + type-change handler
   * threaded through to TypePickerPopover. Required to wire the picker;
   * when omitted (e.g. drag-preview rendering), the static TypeBadge
   * renders instead of the popover trigger. */
  projectId?: number
  onTypeChange?: (columnId: number, datasetId: number, newType: string) => void
  /** Effective color for this cell's dataset (resolved by getDatasetAccent —
   * stored color OR palette fallback). When omitted, no dataset dot renders. */
  datasetColor?: string
  /** True when the dataset's color is currently muted via the per-dataset
   * or global toggle. Renders the dot as a faint hollow ring. */
  isDatasetDotMuted?: boolean
  /** Click handler for the cell-level dataset dot — toggles the dataset's
   * muted state across all crosswalk surfaces (cells + column headers). */
  onToggleDatasetMute?: (datasetId: number) => void
}

function isDataCell(cell: CellData | EmptyCellData): cell is CellData {
  return 'column_id' in cell
}

export function Cell(props: CellProps) {
  if (!isDataCell(props.cell)) {
    return (
      <EmptyCell
        cell={props.cell}
        rowEgId={props.rowEgId ?? null}
        rowSyntheticColumnId={props.rowSyntheticColumnId ?? null}
        dndEnabled={props.dndEnabled}
        canAcceptDrop={props.emptyCellCanAcceptDrop}
      />
    )
  }
  return <DataCell {...props} cell={props.cell} />
}

interface EmptyCellInternalProps {
  cell: EmptyCellData
  rowEgId?: number | null
  rowSyntheticColumnId?: number | null
  dndEnabled?: boolean
  /** When false, the empty cell's droppable is disabled — no hover highlight,
   * won't accept drops. Used by Legacy ungrouped rows to reject domain-member drops. */
  canAcceptDrop?: boolean
}

const EmptyCell = memo(function EmptyCell({
  cell,
  rowEgId,
  rowSyntheticColumnId,
  dndEnabled = true,
  canAcceptDrop = true,
}: EmptyCellInternalProps) {
  // Path A #325: synthetic rows emit `empty-unlinked-` IDs; EG rows emit
  // `empty-eg-` IDs. F3+F5 wires the actual drop branches; for now the
  // makeEmptyCellDropId helper handles both formats via its overload.
  const hasRowAnchor = rowEgId != null || rowSyntheticColumnId != null
  const canDrop = dndEnabled && hasRowAnchor && canAcceptDrop
  const dropId = canDrop
    ? rowEgId != null
      ? makeEmptyCellDropId({ kind: 'eg', egId: rowEgId, datasetId: cell.dataset_id })
      : makeEmptyCellDropId({ kind: 'unlinked', columnId: rowSyntheticColumnId!, datasetId: cell.dataset_id })
    : `empty-disabled-${cell.dataset_id}`
  const drop = useDroppable({
    id: dropId,
    disabled: !canDrop,
  })
  const overClass = drop.isOver ? 'crosswalk-empty-drop-over' : ''
  return (
    <div
      ref={drop.setNodeRef}
      role="gridcell"
      className={`flex items-center justify-center px-3 py-2 text-mm-text-muted italic text-sm min-h-[48px] rounded border border-dashed border-mm-border-subtle ${overClass}`}
      aria-label={`No column from ${cell.dataset_name}${canDrop ? ' — drop a column here to assign' : ''}`}
    >
      —
    </div>
  )
})

interface DataCellProps extends CellProps {
  cell: CellData
}

const DataCell = memo(function DataCell({
  cell,
  isSearchMatch = false,
  dndEnabled = true,
  isDragging = false,
  isConflictFlash = false,
  isSwapFlash = false,
  rowColumnIds = [],
  onRemoveFromRow,
  onCopyRecode,
  isDomainMember = false,
  onRemoveFromVariableGroup,
  blockDragStartRef,
  onViewInDataset,
  extraContextMenuItems,
  isSelected = false,
  onCellClick,
  projectId,
  onTypeChange,
  datasetColor,
  isDatasetDotMuted,
  onToggleDatasetMute,
}: DataCellProps) {
  const dragId = makeCellDragId(cell.column_id)
  // #341 dev-only F1 invariant check: warn loudly if the same drag-id
  // is registered by another surface (e.g. UnassignedCard) at the same
  // time. No-op in production builds.
  useCellDragIdRegistry(dragId, 'Cell')

  const draggable = useDraggable({ id: dragId, disabled: !dndEnabled })
  const droppable = useDroppable({ id: dragId, disabled: !dndEnabled })

  const setNodeRef = (node: HTMLElement | null) => {
    draggable.setNodeRef(node)
    droppable.setNodeRef(node)
  }

  let styleClass = 'bg-mm-surface border-mm-border-subtle'
  if (isSearchMatch) styleClass = 'bg-sky-200 dark:bg-sky-900 border-sky-600'
  if (droppable.isOver && !isDragging) styleClass = 'crosswalk-cell-drop-over'
  if (isConflictFlash) styleClass = 'crosswalk-conflict-flash'

  const dragClass = isDragging ? 'crosswalk-cell-dragging' : ''
  const swapFlashClass = isSwapFlash ? 'crosswalk-swap-flash' : ''
  // Path A #329: persistent ring on selected cells. Indigo distinguishes
  // from blue (drop-over), violet (bracket), sky (search), amber (conflict).
  const selectionClass = isSelected ? 'ring-2 ring-indigo-500' : ''

  const ariaLabel =
    `${cell.column_code ?? 'Unnamed'}: ${cell.column_text} — ${cell.dataset_name} — ${cell.column_type}` +
    (cell.is_reverse_scored ? ' — reverse-scored' : '') +
    (isSelected ? ' — selected' : '')

  // Hover tooltip — full column code + text + dataset + type. The cell's
  // `column_text` is truncated to fit the cell width, so without a tooltip
  // researchers can't read long question wording when it's clipped. Native
  // `title` attr keeps the surface accessible-by-default with no extra
  // provider dependency.
  const cellTitle =
    `${cell.column_code ?? 'Unnamed'}: ${cell.column_text}` +
    `\n${cell.dataset_name} · ${cell.column_type}` +
    (cell.is_reverse_scored ? ' · reverse-scored' : '')

  const handleClick = (e: MouseEvent) => {
    if (!onCellClick) return
    const modKey = e.metaKey || e.ctrlKey
    // Plain click = focus only (default browser behavior + tabIndex). Only
    // forward modifier-key clicks to the selection toggle so single clicks
    // don't accidentally clear the user's selection.
    if (!modKey) return
    e.preventDefault()
    e.stopPropagation()
    onCellClick(cell.column_id, true)
  }

  // Siblings available for copy-recode (excludes self).
  const siblings = rowColumnIds.filter((id) => id !== cell.column_id)

  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (blockDragStartRef) blockDragStartRef.current = open
      }}
    >
      <ContextMenuTrigger asChild>
        <div
          ref={setNodeRef}
          {...draggable.attributes}
          {...draggable.listeners}
          role="gridcell"
          tabIndex={0}
          aria-label={ariaLabel}
          title={cellTitle}
          aria-grabbed={dndEnabled && isDragging ? 'true' : undefined}
          aria-selected={isSelected || undefined}
          onClick={handleClick}
          className={`flex items-start gap-2 rounded border px-3 py-2 min-h-[48px] hover:border-mm-border-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus:outline-none ${styleClass} ${dragClass} ${swapFlashClass} ${selectionClass}`}
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              {datasetColor && (
                <DatasetDotButton
                  datasetId={cell.dataset_id}
                  datasetName={cell.dataset_name}
                  color={datasetColor}
                  muted={isDatasetDotMuted ?? false}
                  size="compact"
                  onToggleMute={
                    onToggleDatasetMute
                      ? () => onToggleDatasetMute(cell.dataset_id)
                      : undefined
                  }
                />
              )}
              {cell.column_code && (
                <span className="font-mono text-[10px] text-mm-text-muted">{cell.column_code}</span>
              )}
              {cell.is_reverse_scored && (
                <span
                  className="inline-flex items-center text-amber-600 dark:text-amber-400"
                  title="Reverse-scored item (1↔N flipped before scoring)"
                  aria-label="reverse-scored"
                >
                  <RotateCcw className="w-3 h-3" />
                </span>
              )}
            </div>
            <div className="text-sm text-mm-text leading-snug truncate">{cell.column_text}</div>
          </div>
          {projectId != null && onTypeChange ? (
            <TypePickerPopover
              currentType={cell.column_type}
              columnCode={cell.column_code}
              columnText={cell.column_text}
              recodeDefCount={cell.recode_def_count}
              projectId={projectId}
              datasetId={cell.dataset_id}
              columnId={cell.column_id}
              onTypeChange={onTypeChange}
            >
              <button
                type="button"
                aria-label={`Change type for ${cell.column_code ?? `column ${cell.column_id}`} — current type ${cell.column_type}`}
                className="flex-none rounded focus-visible:ring-2 focus-visible:ring-ring focus:outline-none"
                // Stop drag activation on click (cell wrapper is the draggable).
                onPointerDown={(e) => e.stopPropagation()}
              >
                <TypeBadge type={cell.column_type} />
              </button>
            </TypePickerPopover>
          ) : (
            <span
              className="flex-none"
              title={`Column type: ${cell.column_type}`}
            >
              <TypeBadge type={cell.column_type} />
            </span>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {cell.equivalence_group_id != null && (
          <ContextMenuItem onSelect={() => onRemoveFromRow?.(cell.column_id)}>
            Remove from equivalence row
          </ContextMenuItem>
        )}
        {isDomainMember && onRemoveFromVariableGroup && (
          <ContextMenuItem onSelect={() => onRemoveFromVariableGroup(cell.column_id)}>
            Remove from variable group
          </ContextMenuItem>
        )}
        {siblings.length > 0 && (
          <ContextMenuItem onSelect={() => onCopyRecode?.(cell.column_id, rowColumnIds)}>
            Copy recode to row…
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => onViewInDataset?.({ id: cell.column_id, dataset_id: cell.dataset_id })}
          disabled={!onViewInDataset}
        >
          View in Dataset View
        </ContextMenuItem>
        {extraContextMenuItems && (
          <>
            <ContextMenuSeparator />
            {extraContextMenuItems}
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
})

export { AlertTriangle }
