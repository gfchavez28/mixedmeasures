/**
 * Bracket — one variable group (analysis domain) rendered with the mockup's
 * left-side label pattern: a 210px-wide label column on the left, and a
 * dashed-border rows container on the right.
 *
 * Layout note (post-#326): the section is a flex row (`flex items-stretch
 * gap-[10px]`) with a `w-[210px] flex-none` label and a `flex-1 min-w-0`
 * frame. `items-stretch` lets the label and frame size each other naturally
 * so descriptions remain visible even when the variable group has 0
 * equivalence rows. Earlier `absolute top-0 bottom-0` label clamped to a
 * short frame and clipped descriptions.
 *
 * Phase 3b wires:
 *   - Σ badge click → navigate to Analysis View
 *   - Bracket context menu (Rename, Delete, Move up/down, View scale score,
 *     Create scale score manually)
 *   - "+ Add variable row" button (drag-first; click pulses the button +
 *     opens the Unassigned panel — see CrosswalkView.handleAddRow)
 *   - blockDragStartRef toggle on menu open/close (A8)
 *
 * Perf pass (#332): wrapped in React.memo. `onMoveUp`/`onMoveDown` are
 * derived from primitive props (`bracketIndex`, `bracketCount`,
 * `onReorderDomain`) via useMemo so the prop-chain stays stable when only
 * flash state changes. `getBracketLabelStyles(bracket.color)` is also
 * useMemo'd — the contrast computation isn't free.
 *
 * #327 wires:
 *   - useSortable on the section for drag-to-reorder (grip handle on label)
 *   - Chevron toggle in label header → onToggleCollapse
 *   - Collapsed: section becomes a thin one-line strip (chevron + name +
 *     hover-only grip + hover-only dropdown). Rows / description / score
 *     badge / cross-dataset badge / row count are all hidden so the bracket
 *     footprint actually shrinks. The label-vs-frame split is dissolved in
 *     this state.
 *   - Keyboard reorder via Ctrl+Shift+Up/Down on grip (parallel to row reorder)
 */

import { memo, useCallback, useMemo, type MutableRefObject } from 'react'
import type { BracketData, RowData } from './crosswalk-types'
import { EquivalenceRow } from './EquivalenceRow'
import { getBracketLabelStyles } from './bracket-color'
import { makeAddRowDropId, makeBracketSortId } from './drop-ids'
import { useDroppable } from '@dnd-kit/core'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Plus, Sigma, MoreVertical, ChevronDown, ChevronRight, GripVertical } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

interface BracketProps {
  bracket: BracketData
  activeDatasetIds: number[]
  datasetNames: Map<number, string>
  searchHighlightIds: Set<number>
  activeDragColumnId?: number | null
  conflictFlashColumnId?: number | null
  swapFlashColumnIds?: Set<number>
  /** Position within the parent grid — used to derive Move up/down
   * availability locally so the parent can pass a single stable
   * onReorderDomain callback rather than per-bracket inline closures. */
  bracketIndex: number
  bracketCount: number
  onAddRow?: (bracket: BracketData) => void
  onScoreMetricClick?: (metricId: number, domainId: number) => void
  onRemoveFromRow?: (columnId: number) => void
  onCopyRecode?: (cellColumnId: number, rowColumnIds: number[]) => void
  onDeleteRow?: (row: RowData, cellCount: number) => void
  /** Stable parent callback. Per-row up/down is derived inside
   * EquivalenceRow from rowIndex/rowCount/domainId. */
  onReorderRow?: (domainId: number, rowIndex: number, direction: 'up' | 'down') => void
  onRenameDomain?: (bracket: BracketData) => void
  onDeleteDomain?: (bracket: BracketData) => void
  /** Stable parent callback. Per-bracket up/down is derived inside this
   * component from bracketIndex/bracketCount/domain_id. */
  onReorderDomain?: (domainId: number, direction: 'up' | 'down') => void
  onCreateScoreMetric?: (bracket: BracketData) => void
  /** Phase 3.5 / #324 — passed through to each row's Cell so domain-member
   * cells render the "Remove from variable group" menu item. */
  domainMemberColumnIds?: Set<number>
  onRemoveFromVariableGroup?: (columnId: number) => void
  blockDragStartRef?: MutableRefObject<boolean>
  onViewInDataset?: (col: { id: number; dataset_id: number }) => void
  /** Path A #329: multi-select state — passed through to each cell. */
  selectedCellIds?: Set<number>
  onCellClick?: (columnId: number, modKey: boolean) => void
  /** #327: collapsed state — when true, the frame's rows + "Add variable
   * row" button hide; the label keeps full content. Toggled via the chevron. */
  isCollapsed?: boolean
  onToggleCollapse?: (domainId: number) => void
  /** Phase 4.4: project ID + type-change callback for TypePickerPopover. */
  projectId?: number
  onTypeChange?: (columnId: number, datasetId: number, newType: string) => void
  /** Resolver: dataset_id → effective accent color. Threaded down to each
   * cell so the dataset dot inside the cell renders the right color. */
  resolveDatasetColor?: (datasetId: number) => string
  /** Per-dataset muted predicate — threaded to cells. */
  isDatasetDotMuted?: (datasetId: number) => boolean
  /** Click handler for cell-level dataset dots. */
  onToggleDatasetMute?: (datasetId: number) => void
  /** True when any cell drag is in flight. Used to expand the "+ Add
   * variable row" button into a full-width drop zone with bracket-tinted
   * accent during drag. Idle state stays compact. */
  dragActive?: boolean
  /** When true, briefly pulse the "+ Add variable row" button to draw the
   * researcher's attention (set on click when the unassigned panel is
   * empty or just-opened). Cleared by the parent after the pulse animation
   * finishes (~1.2s). */
  pulseAddRow?: boolean
}

export const Bracket = memo(function Bracket({
  bracket,
  activeDatasetIds,
  datasetNames,
  searchHighlightIds,
  activeDragColumnId = null,
  conflictFlashColumnId = null,
  swapFlashColumnIds,
  bracketIndex,
  bracketCount,
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
  isCollapsed = false,
  onToggleCollapse,
  projectId,
  onTypeChange,
  resolveDatasetColor,
  isDatasetDotMuted,
  onToggleDatasetMute,
  dragActive = false,
  pulseAddRow = false,
}: BracketProps) {
  const scoreState = bracket.scale_score_metric_state
  const showScoreBadge =
    (scoreState === 'ok' || scoreState === 'stale') && bracket.scale_score_metric_id != null
  const scoreMissing = scoreState === 'missing' || scoreState === 'failed'

  // #318: unified color rendering — tint label interior from bracket.color
  // (neutral indigo fallback when null). Amber on "Score unavailable" stays
  // unchanged — amber is the failure signal, not the domain color.
  // Memoized: getBracketLabelStyles runs a contrast computation that isn't
  // worth re-doing every flash transition.
  const labelStyles = useMemo(
    () => getBracketLabelStyles(bracket.color),
    [bracket.color],
  )

  const canMoveUp = bracketIndex > 0
  const canMoveDown = bracketIndex < bracketCount - 1

  const onMoveUp = useMemo(
    () =>
      canMoveUp && onReorderDomain
        ? () => onReorderDomain(bracket.domain_id, 'up')
        : undefined,
    [canMoveUp, onReorderDomain, bracket.domain_id],
  )
  const onMoveDown = useMemo(
    () =>
      canMoveDown && onReorderDomain
        ? () => onReorderDomain(bracket.domain_id, 'down')
        : undefined,
    [canMoveDown, onReorderDomain, bracket.domain_id],
  )

  const handleRename = useCallback(() => onRenameDomain?.(bracket), [onRenameDomain, bracket])
  const handleDelete = useCallback(() => onDeleteDomain?.(bracket), [onDeleteDomain, bracket])
  const handleAddRow = useCallback(() => onAddRow?.(bracket), [onAddRow, bracket])

  // Drop target on the "+ Add variable row" button — accepts cell drags
  // (including drag-from-Unassigned in commit 2) and lands them as
  // synthetic single-cell rows in this bracket via move_members.
  const addRowDrop = useDroppable({ id: makeAddRowDropId(bracket.domain_id) })
  const handleCreateScore = useCallback(
    () => onCreateScoreMetric?.(bracket),
    [onCreateScoreMetric, bracket],
  )
  const handleScoreClick = useCallback(() => {
    if (bracket.scale_score_metric_id != null) {
      onScoreMetricClick?.(bracket.scale_score_metric_id, bracket.domain_id)
    }
  }, [onScoreMetricClick, bracket.scale_score_metric_id, bracket.domain_id])

  const handleMenuOpenChange = useCallback(
    (open: boolean) => {
      if (blockDragStartRef) blockDragStartRef.current = open
    },
    [blockDragStartRef],
  )

  const handleToggleCollapse = useCallback(() => {
    onToggleCollapse?.(bracket.domain_id)
  }, [onToggleCollapse, bracket.domain_id])

  // #327 sortable wiring. Attributes + listeners apply ONLY to the grip
  // handle below — never to the section, chevron, or label container — so a
  // chevron click never activates the drag.
  const {
    attributes: sortableAttrs,
    listeners: sortableListeners,
    setNodeRef: setSortableRef,
    transform: sortableTransform,
    transition: sortableTransition,
    isDragging: isSortDragging,
  } = useSortable({ id: makeBracketSortId(bracket.domain_id) })

  const sortableStyle = useMemo<React.CSSProperties>(
    () => ({
      transform: CSS.Transform.toString(sortableTransform),
      transition: sortableTransition,
      opacity: isSortDragging ? 0.5 : 1,
    }),
    [sortableTransform, sortableTransition, isSortDragging],
  )

  const handleGripKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'Up')) {
        e.preventDefault()
        onMoveUp?.()
      } else if (e.ctrlKey && e.shiftKey && (e.key === 'ArrowDown' || e.key === 'Down')) {
        e.preventDefault()
        onMoveDown?.()
      }
    },
    [onMoveUp, onMoveDown],
  )

  // Shared dropdown — same trigger button + same items for both states.
  // Extracted so the collapsed thin row and the expanded label can each
  // mount it without duplicating the items list.
  const dropdownTrigger = (
    <DropdownMenu onOpenChange={handleMenuOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex-none opacity-50 hover:opacity-100 transition-opacity focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus:outline-none rounded"
          style={labelStyles.heading}
          aria-label={`Actions for ${bracket.name}`}
          title="More actions"
        >
          <MoreVertical className="w-3 h-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={handleRename}>
          Rename variable group
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onMoveUp?.()} disabled={!onMoveUp}>
          Move up
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onMoveDown?.()} disabled={!onMoveDown}>
          Move down
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {bracket.scale_score_metric_id != null && (
          <DropdownMenuItem onSelect={handleScoreClick}>
            View scale score metric
          </DropdownMenuItem>
        )}
        {scoreMissing && (
          <DropdownMenuItem onSelect={handleCreateScore}>
            Create scale score manually
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={handleDelete}
          className="text-red-600 focus:text-red-600"
        >
          Delete variable group
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  // Shared section context-menu — exposed via right-click on the bracket
  // body whether collapsed or expanded.
  const sectionContextMenuContent = (
    <ContextMenuContent>
      <ContextMenuItem onSelect={handleRename}>
        Rename variable group
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => onMoveUp?.()} disabled={!onMoveUp}>
        Move up
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => onMoveDown?.()} disabled={!onMoveDown}>
        Move down
      </ContextMenuItem>
      <ContextMenuSeparator />
      {bracket.scale_score_metric_id != null && (
        <ContextMenuItem onSelect={handleScoreClick}>
          View scale score metric
        </ContextMenuItem>
      )}
      {scoreMissing && (
        <ContextMenuItem onSelect={handleCreateScore}>
          Create scale score manually
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem
        onSelect={handleDelete}
        className="text-red-600 focus:text-red-600"
      >
        Delete variable group
      </ContextMenuItem>
    </ContextMenuContent>
  )

  // Collapsed: thin one-row strip. Replaces the entire label+frame split.
  // Bracket-color is rendered as a 3px left border (matches the expanded
  // label's left edge so the visual identity is preserved at a glance).
  // Strict per #327 user feedback: chevron, name, hover-only grip,
  // hover-only dropdown. No description, no row count, no Σ badge, no
  // cross-dataset chip. Those are all reachable by expanding.
  if (isCollapsed) {
    return (
      <section
        ref={setSortableRef}
        style={sortableStyle}
        tabIndex={-1}
        role="grid"
        aria-label={`Variable group: ${bracket.name} (collapsed)`}
        data-testid={`crosswalk-bracket-${bracket.domain_id}`}
        className="mb-1.5 flex items-stretch group/bracket focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
      >
        <ContextMenu onOpenChange={handleMenuOpenChange}>
          <ContextMenuTrigger asChild>
            <div
              className="flex-1 min-w-0 flex items-center gap-2 px-3 py-1.5 border-l-[3px] border border-dashed rounded-md"
              style={labelStyles.container}
            >
              <button
                type="button"
                onClick={handleToggleCollapse}
                aria-expanded={false}
                aria-label={`Expand ${bracket.name}`}
                className="flex-none opacity-70 hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus:outline-none rounded transition-opacity"
                style={labelStyles.heading}
                title="Expand variable group"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
              <h3
                className="flex-1 text-[13px] font-semibold leading-tight min-w-0 truncate"
                style={labelStyles.heading}
                title={bracket.name}
              >
                {bracket.name}
              </h3>
              <button
                type="button"
                {...sortableAttrs}
                {...sortableListeners}
                onKeyDown={handleGripKeyDown}
                aria-label={`Reorder variable group: ${bracket.name}. Ctrl+Shift+Up or Down to move via keyboard.`}
                className="flex-none cursor-grab touch-none opacity-0 group-hover/bracket:opacity-70 hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus:outline-none rounded transition-opacity"
                style={labelStyles.heading}
                title="Drag to reorder"
              >
                <GripVertical className="w-3.5 h-3.5" />
              </button>
              {dropdownTrigger}
            </div>
          </ContextMenuTrigger>
          {sectionContextMenuContent}
        </ContextMenu>
      </section>
    )
  }

  const ariaCountSummary = bracket.rows.length === 0
    ? 'empty'
    : `${bracket.rows.length} ${bracket.rows.length === 1 ? 'variable' : 'variables'} across ${bracket.dataset_count} ${bracket.dataset_count === 1 ? 'dataset' : 'datasets'}`

  return (
    <section
      ref={setSortableRef}
      style={sortableStyle}
      tabIndex={-1}
      role="grid"
      aria-label={`Variable group: ${bracket.name}, ${ariaCountSummary}`}
      data-testid={`crosswalk-bracket-${bracket.domain_id}`}
      className="mb-5 flex items-stretch gap-[10px] group/bracket focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
    >
      <ContextMenu onOpenChange={handleMenuOpenChange}>
        <ContextMenuTrigger asChild>
          <div
            className="w-[210px] flex-none flex flex-col justify-start px-3 py-3 border-l-[3px] border-t-2 border-b-2 border-dashed rounded-l-md"
            style={labelStyles.container}
          >
            <div className="flex items-start gap-1">
              <button
                type="button"
                onClick={handleToggleCollapse}
                aria-expanded={!isCollapsed}
                aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${bracket.name}`}
                className="flex-none mt-0.5 opacity-70 hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus:outline-none rounded transition-opacity"
                style={labelStyles.heading}
                title={isCollapsed ? 'Expand variable group' : 'Collapse variable group'}
              >
                {isCollapsed
                  ? <ChevronRight className="w-3.5 h-3.5" />
                  : <ChevronDown className="w-3.5 h-3.5" />}
              </button>
              <h3
                className="flex-1 text-[13px] font-bold leading-tight min-w-0"
                style={labelStyles.heading}
              >
                {bracket.name}
              </h3>
              <button
                type="button"
                {...sortableAttrs}
                {...sortableListeners}
                onKeyDown={handleGripKeyDown}
                aria-label={`Reorder variable group: ${bracket.name}. Ctrl+Shift+Up or Down to move via keyboard.`}
                className="flex-none mt-0.5 cursor-grab touch-none opacity-0 group-hover/bracket:opacity-70 hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus:outline-none rounded transition-opacity"
                style={labelStyles.heading}
                title="Drag to reorder"
              >
                <GripVertical className="w-3.5 h-3.5" />
              </button>
              {dropdownTrigger}
            </div>
            {bracket.rows.length === 0 ? (
              <div className="text-[10px] mt-0.5 italic" style={labelStyles.muted}>
                Empty
              </div>
            ) : (
              <div
                className="text-[10px] mt-0.5"
                style={labelStyles.muted}
                title={
                  bracket.dataset_count > 1
                    ? `${bracket.rows.length} ${bracket.rows.length === 1 ? 'variable' : 'variables'} across ${bracket.dataset_count} datasets. Cells in the same row are the same variable recorded in different datasets; rows stacked together are combined into one composite.`
                    : `${bracket.rows.length} ${bracket.rows.length === 1 ? 'variable' : 'variables'} from ${bracket.dataset_count} dataset. Rows stacked together are combined into one composite.`
                }
              >
                {bracket.rows.length} {bracket.rows.length === 1 ? 'variable' : 'variables'}
                {' · '}
                {bracket.dataset_count} {bracket.dataset_count === 1 ? 'dataset' : 'datasets'}
              </div>
            )}
            {bracket.description && (
              <p
                className="text-[10px] mt-1 line-clamp-2"
                style={{ ...labelStyles.muted, opacity: 0.7 }}
              >
                {bracket.description}
              </p>
            )}
            {showScoreBadge && bracket.scale_score_metric_id != null && (
              <button
                type="button"
                className="mt-1.5 inline-flex items-center gap-1 self-start rounded px-1.5 py-0.5 text-[10px] font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-ring focus:outline-none hover:opacity-90"
                style={labelStyles.scoreBadge}
                onClick={handleScoreClick}
                aria-label={`Open scale score metric for ${bracket.name}`}
                title={
                  scoreState === 'stale'
                    ? 'Scale score — stale, click to view'
                    : 'Scale score — click to open in Analysis'
                }
              >
                <Sigma className="w-2.5 h-2.5" />
                Score
                {scoreState === 'stale' && (
                  <span
                    className="ml-0.5 inline-block w-1.5 h-1.5 rounded-full bg-amber-500"
                    aria-label="stale"
                  />
                )}
              </button>
            )}
            {scoreState === 'failed' && (
              <span
                className="mt-1.5 inline-flex items-center self-start rounded px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40"
                title="Scale score could not compute — right-click to retry"
              >
                Score unavailable
              </span>
            )}
          </div>
        </ContextMenuTrigger>
        {sectionContextMenuContent}
      </ContextMenu>

      <div
        className="flex-1 min-w-0 border-t-2 border-r-2 border-b-2 border-dashed rounded-r-md py-2 bg-white dark:bg-mm-surface/40"
        style={labelStyles.frame}
      >
        {bracket.rows.length === 0 ? (
          <div className="text-xs text-mm-text-muted italic px-3 py-2">
            No columns yet. Drag a column from Unassigned, or click + Add variable row below.
          </div>
        ) : (
          <div>
            {bracket.rows.map((row, idx) => (
              <EquivalenceRow
                key={row.kind === 'eg' ? `eg-${row.equivalence_group_id}` : `col-${row.column_id}`}
                row={row}
                activeDatasetIds={activeDatasetIds}
                datasetNames={datasetNames}
                bracketName={bracket.name}
                domainId={bracket.domain_id}
                rowIndex={idx}
                rowCount={bracket.rows.length}
                searchHighlightIds={searchHighlightIds}
                activeDragColumnId={activeDragColumnId}
                conflictFlashColumnId={conflictFlashColumnId}
                swapFlashColumnIds={swapFlashColumnIds}
                onRemoveFromRow={onRemoveFromRow}
                onCopyRecode={onCopyRecode}
                onDeleteRow={onDeleteRow}
                onReorderRow={onReorderRow}
                domainMemberColumnIds={domainMemberColumnIds}
                onRemoveFromVariableGroup={onRemoveFromVariableGroup}
                blockDragStartRef={blockDragStartRef}
                onViewInDataset={onViewInDataset}
                selectedCellIds={selectedCellIds}
                onCellClick={onCellClick}
                projectId={projectId}
                onTypeChange={onTypeChange}
                resolveDatasetColor={resolveDatasetColor}
                isDatasetDotMuted={isDatasetDotMuted}
                onToggleDatasetMute={onToggleDatasetMute}
              />
            ))}
          </div>
        )}

        <div className="px-3 pt-2">
          {/* "+ Add variable row" — dual-affordance button:
           *   - click → onAddRow (parent flashes pulse + opens panel)
           *   - drop  → registered as droppable via useDroppable; the
           *     useCrosswalkDnD::handleDragEnd add-row branch handles the
           *     mutation. Three visual modes:
           *       idle (no drag): compact dashed pill, current width.
           *       dragActive: full-width strip with bracket accent tint.
           *       isOver: solid accent + crosswalk-add-row-drop-over pulse.
           */}
          <button
            ref={addRowDrop.setNodeRef}
            type="button"
            className={`inline-flex items-center gap-1.5 rounded border border-dashed text-xs transition-all focus-visible:ring-2 focus-visible:ring-ring focus:outline-none disabled:opacity-50 ${
              addRowDrop.isOver
                ? 'crosswalk-add-row-drop-over w-full justify-center px-3 py-2 font-medium'
                : dragActive
                  ? 'w-full justify-center px-3 py-2 border-mm-border-medium bg-mm-surface-hover/40'
                  : 'px-3 py-1 border-mm-border-medium text-mm-text-secondary hover:border-mm-border-medium hover:bg-mm-surface-hover'
            } ${pulseAddRow ? 'crosswalk-add-row-pulse' : ''}`}
            style={
              addRowDrop.isOver
                ? labelStyles.scoreBadge
                : dragActive
                  ? labelStyles.muted
                  : undefined
            }
            onClick={handleAddRow}
            disabled={!onAddRow}
            aria-label={
              addRowDrop.isOver
                ? `Drop to add a new row to ${bracket.name}`
                : dragActive
                  ? `Drop here to add a new row to ${bracket.name}`
                  : `Add a new variable row to ${bracket.name}`
            }
          >
            <Plus className="w-3 h-3" />
            {addRowDrop.isOver
              ? `Drop to add as new row in ${bracket.name}`
              : dragActive
                ? 'Drop to add as new row'
                : 'Add variable row'}
          </button>
        </div>
      </div>
    </section>
  )
})
