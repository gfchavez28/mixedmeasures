/**
 * Equivalence row — one horizontal strip inside a bracket. Under Path A's
 * unified row model, every domain member renders as a row in its bracket
 * (an EG-keyed row when the column has equivalence_group_id set, or a
 * synthetic single-cell row when it does not). The legacy orphan-rows
 * section was retired with Path A.
 *
 * Phase 3b: row and cell context menus wire here. Row-level keyboard
 * reorder via Ctrl+Shift+Up/Down on the drag handle.
 *
 * Perf pass (#332): wrapped in React.memo. Per-row callbacks (onMoveUp /
 * onMoveDown) are useMemo'd from primitive props (rowIndex, rowCount,
 * domainId, onReorderRow) so they stay stable across non-data renders.
 * The rowMenuItems JSX is also useMemo'd, and the empty-cell fallback
 * objects are precomputed once per active-datasets change so Cell's memo
 * bites for empty placeholders too.
 */

import { memo, useCallback, useMemo, type MutableRefObject } from 'react'
import type { RowData, CellData, EmptyCellData } from './crosswalk-types'
import { Cell } from './Cell'
import { GripVertical, ArrowLeftRight } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { ScaleLabelsMismatchIcon } from './ScaleLabelsMismatchIcon'

interface EquivalenceRowProps {
  row: RowData
  activeDatasetIds: number[]
  datasetNames: Map<number, string>
  bracketName: string
  /** Owning analysis-domain id. Threaded so onReorderRow can be a stable
   * top-level callback rather than per-row inline closures. */
  domainId: number
  rowIndex: number
  rowCount: number
  searchHighlightIds: Set<number>
  activeDragColumnId?: number | null
  conflictFlashColumnId?: number | null
  swapFlashColumnIds?: Set<number>
  onRemoveFromRow?: (columnId: number) => void
  onCopyRecode?: (cellColumnId: number, rowColumnIds: number[]) => void
  onDeleteRow?: (row: RowData, cellCount: number) => void
  /** Stable parent callback. Per-row up/down closures are derived inside
   * this component. */
  onReorderRow?: (domainId: number, rowIndex: number, direction: 'up' | 'down') => void
  /** Phase 3.5 / #324 — set of column IDs that are currently members of any
   * variable group. Used per-cell to decide whether to render the "Remove
   * from variable group" menu item. */
  domainMemberColumnIds?: Set<number>
  onRemoveFromVariableGroup?: (columnId: number) => void
  blockDragStartRef?: MutableRefObject<boolean>
  onViewInDataset?: (col: { id: number; dataset_id: number }) => void
  /** Path A #329: column IDs currently in the multi-select set. Per-cell
   * `isSelected` is derived inside the .map() and reduced to a primitive
   * boolean before crossing Cell's memo boundary (per Phase 3.5 perf
   * invariant). */
  selectedCellIds?: Set<number>
  /** Cmd/Ctrl-click toggle handler. */
  onCellClick?: (columnId: number, modKey: boolean) => void
  /** Phase 4.4: project ID + type-change callback for TypePickerPopover. */
  projectId?: number
  onTypeChange?: (columnId: number, datasetId: number, newType: string) => void
  /** Resolver: dataset_id → effective accent color (stored OR palette).
   * Caller memoizes this so the cell's React.memo boundary still bites. */
  resolveDatasetColor?: (datasetId: number) => string
  /** Per-dataset muted predicate. When `isDatasetDotMuted(ds_id)` is true,
   * the cell's dataset dot renders as a faint hollow ring. */
  isDatasetDotMuted?: (datasetId: number) => boolean
  /** Click handler for cell-level dataset dots — toggles muted state across
   * all crosswalk surfaces. */
  onToggleDatasetMute?: (datasetId: number) => void
}

export const EquivalenceRow = memo(function EquivalenceRow({
  row,
  activeDatasetIds,
  datasetNames,
  bracketName,
  domainId,
  rowIndex,
  rowCount,
  searchHighlightIds,
  activeDragColumnId = null,
  conflictFlashColumnId = null,
  swapFlashColumnIds,
  onRemoveFromRow,
  onCopyRecode,
  onDeleteRow,
  onReorderRow,
  domainMemberColumnIds,
  onRemoveFromVariableGroup,
  blockDragStartRef,
  onViewInDataset,
  selectedCellIds,
  onCellClick,
  projectId,
  onTypeChange,
  resolveDatasetColor,
  isDatasetDotMuted,
  onToggleDatasetMute,
}: EquivalenceRowProps) {
  const ariaLabel = `${bracketName}, row ${rowIndex} of ${rowCount}: ${row.auto_label}`

  const canMoveUp = rowIndex > 0
  const canMoveDown = rowIndex < rowCount - 1

  const onMoveUp = useMemo(
    () =>
      canMoveUp && onReorderRow
        ? () => onReorderRow(domainId, rowIndex, 'up')
        : undefined,
    [canMoveUp, onReorderRow, domainId, rowIndex],
  )
  const onMoveDown = useMemo(
    () =>
      canMoveDown && onReorderRow
        ? () => onReorderRow(domainId, rowIndex, 'down')
        : undefined,
    [canMoveDown, onReorderRow, domainId, rowIndex],
  )

  // Collect the row's populated cell column IDs — used for the row context
  // menu's delete confirm (count of cells affected) and for copy-recode
  // sibling resolution.
  const rowColumnIds = useMemo(() => {
    const ids: number[] = []
    for (const dsId of activeDatasetIds) {
      const c = row.cells_by_dataset.get(dsId)
      if (c && 'column_id' in c) ids.push(c.column_id)
    }
    return ids
  }, [activeDatasetIds, row.cells_by_dataset])

  // Stable empty-cell fallback objects — one per active dataset. Without
  // this, a fresh EmptyCellData is allocated per render in the .map() and
  // Cell's React.memo invalidates for every empty placeholder.
  const emptyFallbacks = useMemo(() => {
    const m = new Map<number, EmptyCellData>()
    for (const did of activeDatasetIds) {
      m.set(did, {
        dataset_id: did,
        dataset_name: datasetNames.get(did) ?? `Dataset ${did}`,
      })
    }
    return m
  }, [activeDatasetIds, datasetNames])

  // Phase 4.5: per-cell scale_labels for the mismatch icon's tooltip.
  // Only built when this is an EG row with a detected mismatch — keeps the
  // useMemo identity stable in the common (no-mismatch) case.
  const mismatchLabelsByDataset = useMemo(() => {
    if (row.kind !== 'eg' || !row.has_scale_labels_mismatch) return []
    const out: Array<{ dataset_id: number; dataset_name: string; scale_labels: string[] | null }> = []
    for (const dsId of activeDatasetIds) {
      const c = row.cells_by_dataset.get(dsId)
      if (c && 'column_id' in c) {
        out.push({
          dataset_id: dsId,
          dataset_name: c.dataset_name,
          scale_labels: c.scale_labels,
        })
      }
    }
    return out
  }, [row, activeDatasetIds])

  // Layer 2 (#317-flavored): equivalence indicator between paired cells.
  // Compute once at row level: which positions in `activeDatasetIds`
  // correspond to populated EG cells and (after the first populated one)
  // should render an ⇄ indicator at the cell's left edge to make the
  // "same variable across datasets" relationship explicit.
  //
  // Rules:
  //   - Only on EG rows (`kind === 'eg'`) — synthetic single-cell rows
  //     by definition have no peers.
  //   - Only on populated cells (skip empty placeholders).
  //   - Skip the first populated cell (nothing to its left to point at).
  //   - Skip rows with only one visible populated cell (current dataset
  //     toggles can hide all but one — indicator would point at nothing).
  //
  // Output is a Set of position-indices into activeDatasetIds. Reduced
  // to a primitive boolean per cell BEFORE crossing Cell's memo boundary
  // (foot-gun #332): we look up `equivalencePositions.has(idx)` in the
  // .map() and pass `showEquivalenceIndicator: boolean` down.
  const equivalencePositions = useMemo(() => {
    const out = new Set<number>()
    if (row.kind !== 'eg') return out
    let firstPopulatedIdx = -1
    let populatedCount = 0
    for (let i = 0; i < activeDatasetIds.length; i++) {
      const c = row.cells_by_dataset.get(activeDatasetIds[i])
      if (c && 'column_id' in c) {
        populatedCount++
        if (firstPopulatedIdx === -1) firstPopulatedIdx = i
        else out.add(i)
      }
    }
    // Edge case: only one populated cell visible — clear the set.
    if (populatedCount < 2) out.clear()
    return out
  }, [row, activeDatasetIds])

  const handleDelete = useCallback(() => {
    onDeleteRow?.(row, rowColumnIds.length)
  }, [onDeleteRow, row, rowColumnIds.length])

  // Row-level items appended to each populated cell's ContextMenu via the
  // Cell's `extraContextMenuItems` slot. Keeps Move up/down + Delete row
  // one right-click away regardless of whether the click lands on a cell
  // or the row padding (the row-container ContextMenu below is a fallback).
  const rowMenuItems = useMemo(
    () => (
      <>
        <ContextMenuItem onSelect={() => onMoveUp?.()} disabled={!onMoveUp}>
          Move row up
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onMoveDown?.()} disabled={!onMoveDown}>
          Move row down
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={handleDelete}
          className="text-red-600 focus:text-red-600"
        >
          Delete row
        </ContextMenuItem>
      </>
    ),
    [onMoveUp, onMoveDown, handleDelete],
  )

  const handleContextMenuOpenChange = useCallback(
    (open: boolean) => {
      if (blockDragStartRef) blockDragStartRef.current = open
    },
    [blockDragStartRef],
  )

  return (
    <ContextMenu onOpenChange={handleContextMenuOpenChange}>
      <ContextMenuTrigger asChild>
        <div
          role="row"
          aria-label={ariaLabel}
          data-testid={
            row.kind === 'eg'
              ? `crosswalk-row-eg-${row.equivalence_group_id}`
              : `crosswalk-row-col-${row.column_id}`
          }
          className="group relative grid gap-[var(--crosswalk-gap)] items-center py-1.5 px-3 transition-colors hover:bg-violet-50/40 dark:hover:bg-violet-900/10 [&+&]:border-t [&+&]:border-violet-100 dark:[&+&]:border-violet-900/30"
          style={{
            gridTemplateColumns: 'var(--crosswalk-cols)',
            // #355: badge centering depends on knowing the gap. Define it once
            // here and let CrosswalkColumnHeaders + the equivalence indicator
            // both read it via CSS var. Fallback in indicator's calc() ensures
            // correct behavior if a future refactor drops this var on the parent.
            ['--crosswalk-gap' as string]: '0.625rem',
          }}
        >
          <button
            type="button"
            tabIndex={0}
            aria-label={`Drag row ${rowIndex} of ${rowCount}. Ctrl+Shift+Up or Down to reorder.`}
            className="absolute left-0.5 top-1/2 -translate-y-1/2 text-mm-text-muted opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity cursor-grab focus-visible:ring-2 focus-visible:ring-ring focus:outline-none rounded"
            onKeyDown={(e) => {
              if (e.ctrlKey && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'Up')) {
                e.preventDefault()
                onMoveUp?.()
              } else if (e.ctrlKey && e.shiftKey && (e.key === 'ArrowDown' || e.key === 'Down')) {
                e.preventDefault()
                onMoveDown?.()
              }
            }}
          >
            <GripVertical className="w-3.5 h-3.5" />
          </button>

          {row.kind === 'eg' && row.has_scale_labels_mismatch && (
            <ScaleLabelsMismatchIcon labelsByDataset={mismatchLabelsByDataset} />
          )}

          {activeDatasetIds.map((dataset_id, idx) => {
            const cell = row.cells_by_dataset.get(dataset_id)
            const cellData = cell ?? emptyFallbacks.get(dataset_id)!
            const isData = cell != null && 'column_id' in cell
            const columnId = isData ? (cell as CellData).column_id : null
            const isSearchMatch = columnId != null && searchHighlightIds.has(columnId)
            const isDragging = columnId != null && activeDragColumnId === columnId
            const isConflictFlash = columnId != null && conflictFlashColumnId === columnId
            const isSwapFlash = columnId != null && (swapFlashColumnIds?.has(columnId) ?? false)
            const isDomainMember =
              columnId != null && (domainMemberColumnIds?.has(columnId) ?? false)
            const isSelected =
              columnId != null && (selectedCellIds?.has(columnId) ?? false)
            // Primitive boolean — does NOT cross Cell's memo boundary; rendered
            // as a sibling adornment in the wrapping div instead.
            const showEquivalenceIndicator = equivalencePositions.has(idx)

            return (
              <div
                key={dataset_id}
                className="relative min-w-0"
                data-testid={`crosswalk-cell-${columnId ?? `empty-${dataset_id}`}`}
              >
                {showEquivalenceIndicator && (
                  <span
                    aria-label="Equivalent variable across datasets"
                    title="Equivalent across datasets — these are the same variable recorded in different datasets."
                    className="pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2 z-10 inline-flex items-center justify-center w-4 h-4 rounded-full bg-mm-bg/90 border border-mm-border-subtle text-mm-text-faint shadow-sm"
                    // #355: anchor the badge center at the midpoint of the
                    // grid gap (not at the cell-boundary line). `left` is set
                    // to negative half-gap; `translate-x-[-50%]` then centers
                    // the badge on that point. CSS-var fallback ensures
                    // correctness if --crosswalk-gap is undefined upstream.
                    style={{ left: 'calc(var(--crosswalk-gap, 0.625rem) / -2)' }}
                  >
                    <ArrowLeftRight className="w-2.5 h-2.5" aria-hidden />
                  </span>
                )}
                <Cell
                  cell={cellData}
                  rowEgId={row.kind === 'eg' ? row.equivalence_group_id : null}
                  rowSyntheticColumnId={row.kind === 'unlinked' ? row.column_id : null}
                  isSearchMatch={isSearchMatch}
                  isDragging={isDragging}
                  isConflictFlash={isConflictFlash}
                  isSwapFlash={isSwapFlash}
                  rowColumnIds={rowColumnIds}
                  onRemoveFromRow={onRemoveFromRow}
                  onCopyRecode={onCopyRecode}
                  isDomainMember={isDomainMember}
                  onRemoveFromVariableGroup={onRemoveFromVariableGroup}
                  blockDragStartRef={blockDragStartRef}
                  onViewInDataset={onViewInDataset}
                  extraContextMenuItems={isData ? rowMenuItems : undefined}
                  isSelected={isSelected}
                  onCellClick={onCellClick}
                  projectId={projectId}
                  onTypeChange={onTypeChange}
                  datasetColor={
                    isData ? resolveDatasetColor?.(dataset_id) : undefined
                  }
                  isDatasetDotMuted={
                    isData ? isDatasetDotMuted?.(dataset_id) : undefined
                  }
                  onToggleDatasetMute={onToggleDatasetMute}
                />
              </div>
            )
          })}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onMoveUp?.()} disabled={!onMoveUp}>
          Move up
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onMoveDown?.()} disabled={!onMoveDown}>
          Move down
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={handleDelete}
          className="text-red-600 focus:text-red-600"
        >
          Delete row
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
})
