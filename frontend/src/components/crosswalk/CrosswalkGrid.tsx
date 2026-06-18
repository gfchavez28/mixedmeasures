/**
 * CrosswalkGrid — consumes the single-slice grid from buildGrid and renders
 * each bracket. Brackets sit inside a SortableContext so they can be
 * drag-reordered (#327).
 *
 * Perf pass (#332): this is intentionally NOT memoized — it's a thin
 * .map() wrapper. The expensive children (Bracket, EquivalenceRow, Cell)
 * are individually memoized and receive primitive props (bracketIndex,
 * bracketCount, stable callbacks) so they skip re-renders correctly even
 * when this component renders.
 */

import { useMemo, type MutableRefObject } from 'react'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import type {
  BracketData,
  CrosswalkGrid as CrosswalkGridType,
  RowData,
} from './crosswalk-types'
import { Bracket } from './Bracket'
import { AddVariableGroupTile } from './AddVariableGroupTile'
import { makeBracketSortId } from './drop-ids'

interface CrosswalkGridProps {
  grid: CrosswalkGridType
  activeDatasetIds: number[]
  datasetNames: Map<number, string>
  searchHighlightIds: Set<number>
  activeDragColumnId?: number | null
  conflictFlashColumnId?: number | null
  swapFlashColumnIds?: Set<number>
  /** Phase 3b: action callbacks threaded through to Bracket / Row / Cell */
  onAddRow?: (bracket: BracketData) => void
  onScoreMetricClick?: (metricId: number, domainId: number) => void
  onRemoveFromRow?: (columnId: number) => void
  onCopyRecode?: (cellColumnId: number, rowColumnIds: number[]) => void
  onDeleteRow?: (row: RowData, cellCount: number) => void
  onReorderRow?: (domainId: number, rowIndex: number, direction: 'up' | 'down') => void
  onRenameDomain?: (bracket: BracketData) => void
  onDeleteDomain?: (bracket: BracketData) => void
  onReorderDomain?: (domainId: number, direction: 'up' | 'down') => void
  onCreateScoreMetric?: (bracket: BracketData) => void
  /** Phase 3.5 / #324 — threaded to each bracket → row → cell. */
  domainMemberColumnIds?: Set<number>
  onRemoveFromVariableGroup?: (columnId: number) => void
  blockDragStartRef?: MutableRefObject<boolean>
  onViewInDataset?: (col: { id: number; dataset_id: number }) => void
  /** Path A #329: multi-select state — threaded through to cells. */
  selectedCellIds?: Set<number>
  onCellClick?: (columnId: number, modKey: boolean) => void
  /** #327: per-bracket effective collapsed state (already accounts for
   * search auto-expand and dragOver auto-expand). */
  effectiveCollapsedIds?: Set<number>
  onToggleCollapse?: (domainId: number) => void
  /** Inline tile (#discoverability): click handler for the "+ New variable
   * group" tile rendered after the last bracket. The drop branch is wired
   * separately via useCrosswalkDnD's `onNewBracketDrop` option. */
  onCreateDomain?: () => void
  /** Phase 4.4: project ID + type-change callback for TypePickerPopover. */
  projectId?: number
  onTypeChange?: (columnId: number, datasetId: number, newType: string) => void
  /** Resolver: dataset_id → effective accent color. Threaded down to cells. */
  resolveDatasetColor?: (datasetId: number) => string
  /** Per-dataset muted predicate. */
  isDatasetDotMuted?: (datasetId: number) => boolean
  /** Click handler for cell-level dataset dots. */
  onToggleDatasetMute?: (datasetId: number) => void
  /** Domain ID currently flagged for the "+ Add variable row" pulse. Set
   * by CrosswalkView.handleAddRow and cleared after ~1.2s. The matching
   * bracket renders with `pulseAddRow=true` for that window. */
  pulseAddRowDomainId?: number | null
}

export function CrosswalkGrid({
  grid,
  activeDatasetIds,
  datasetNames,
  searchHighlightIds,
  activeDragColumnId = null,
  conflictFlashColumnId = null,
  swapFlashColumnIds,
  onAddRow,
  onScoreMetricClick,
  onRemoveFromRow,
  onCopyRecode,
  onDeleteRow,
  onReorderRow,
  onRenameDomain,
  onDeleteDomain,
  onReorderDomain,
  onCreateScoreMetric,
  domainMemberColumnIds,
  onRemoveFromVariableGroup,
  blockDragStartRef,
  onViewInDataset,
  selectedCellIds,
  onCellClick,
  effectiveCollapsedIds,
  onToggleCollapse,
  onCreateDomain,
  projectId,
  onTypeChange,
  resolveDatasetColor,
  isDatasetDotMuted,
  onToggleDatasetMute,
  pulseAddRowDomainId = null,
}: CrosswalkGridProps) {
  // #327: SortableContext consumes a stable list of sortable IDs. Memoize
  // so the array identity doesn't churn on every render — see #332 perf
  // invariants. Must be declared before the early return below to satisfy
  // rules-of-hooks.
  const sortableIds = useMemo(
    () => grid.brackets.map((b) => makeBracketSortId(b.domain_id)),
    [grid.brackets],
  )

  if (grid.brackets.length === 0) return null

  const bracketCount = grid.brackets.length

  // Drag-active hint — when any cell is being dragged, the inline tile
  // signals it's a valid drop zone even before the pointer enters its
  // hit-test region. Cheap to derive (single nullable check).
  const dragActive = activeDragColumnId != null

  return (
    <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
      <div data-testid="crosswalk-grid">
        {grid.brackets.map((bracket, idx) => {
          const isCollapsed = effectiveCollapsedIds?.has(bracket.domain_id) ?? false
          return (
            <Bracket
              key={bracket.domain_id}
              bracket={bracket}
              activeDatasetIds={activeDatasetIds}
              datasetNames={datasetNames}
              searchHighlightIds={searchHighlightIds}
              activeDragColumnId={activeDragColumnId}
              conflictFlashColumnId={conflictFlashColumnId}
              swapFlashColumnIds={swapFlashColumnIds}
              bracketIndex={idx}
              bracketCount={bracketCount}
              onAddRow={onAddRow}
              onScoreMetricClick={onScoreMetricClick}
              onRemoveFromRow={onRemoveFromRow}
              onCopyRecode={onCopyRecode}
              onDeleteRow={onDeleteRow}
              onReorderRow={onReorderRow}
              onRenameDomain={onRenameDomain}
              onDeleteDomain={onDeleteDomain}
              onReorderDomain={onReorderDomain}
              onCreateScoreMetric={onCreateScoreMetric}
              domainMemberColumnIds={domainMemberColumnIds}
              onRemoveFromVariableGroup={onRemoveFromVariableGroup}
              blockDragStartRef={blockDragStartRef}
              onViewInDataset={onViewInDataset}
              selectedCellIds={selectedCellIds}
              onCellClick={onCellClick}
              isCollapsed={isCollapsed}
              onToggleCollapse={onToggleCollapse}
              projectId={projectId}
              onTypeChange={onTypeChange}
              resolveDatasetColor={resolveDatasetColor}
              isDatasetDotMuted={isDatasetDotMuted}
              onToggleDatasetMute={onToggleDatasetMute}
              dragActive={dragActive}
              pulseAddRow={pulseAddRowDomainId === bracket.domain_id}
            />
          )
        })}
        {onCreateDomain && (
          <AddVariableGroupTile
            onCreate={onCreateDomain}
            dragActive={dragActive}
          />
        )}
      </div>
    </SortableContext>
  )
}
