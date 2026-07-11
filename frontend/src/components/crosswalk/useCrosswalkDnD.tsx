/**
 * useCrosswalkDnD — DndContext wiring for the Tier 3 crosswalk.
 *
 * Phase 3a scope: cell-to-cell swap within a dataset column + cell-to-panel
 * "remove from row" gesture.
 *
 * Phase 3b adds: drag-to-empty-cell → move (via moveColumnMutation), A8
 * context-menu-open gate (blockDragStart ref), SwapErrorOverlay hand-off,
 * and preserves all 3a flash/snapshot behavior.
 *
 * Phase 3.5 renames UnassignedDrawer → UnassignedPanel (right-side hideable
 * panel). The drag-ID constant `drawer-unassigned` is preserved — it's
 * load-bearing in `crosswalkCollisionDetection` and renaming would require
 * a careful audit with no user-facing benefit. See the panel drop-target
 * comment below.
 *
 * ADR — #316 "drag-native remove from variable group": DRAG-A adopted.
 * Dragging a cell to the Panel removes it from its equivalence row (severs
 * the EG link). Removing a card from its VARIABLE GROUP (domain membership)
 * is MENU-ONLY via Cell.tsx's "Remove from variable group (keep equivalence)"
 * context-menu item. Rationale: "drag = row, menu = domain" is a simpler
 * mental model than asking users to distinguish via drag zones or modifier
 * keys. See #316 (closed wontfix) and #324.
 *
 * Drag ID scheme: see `./drop-ids.ts` for all 8 namespaces, the make/parse
 * helpers, and the #334 dragId-uniqueness invariant.
 *
 * Invariants enforced at the UI layer:
 *   1. source must be a data cell (column_id present)
 *   2. source and target must share dataset_id for cell-to-cell swap
 *      (cross-column cells flash conflict). Empty-cell drops don't need
 *      this check because the empty slot's dataset_id comes from the
 *      target row, not from an existing column, and move is cross-dataset-safe.
 *   3. source ≠ target (no-op drops silent)
 *   4. both source and target must have equivalence_group_id for swap
 *      (otherwise the backend would reject with `not_linked`)
 *
 * Mitigations baked in per plan:
 *   - `swapInFlight` ref gates new drags while a mutation is pending
 *   - `blockDragStart` ref gates drag activation while a ContextMenu is
 *     open (Phase 3b A8 — ContextMenu onOpenChange toggles this).
 *   - `activeDatasetIds` watcher cancels the drag if a dataset is toggled
 *     off mid-drag.
 *   - PointerSensor only (foot-gun); Phase 3.14 adds KeyboardSensor.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import { toast } from 'sonner'
import type { ReactNode, MutableRefObject } from 'react'
import type { ColumnSwap } from '@/lib/api/equivalence'
import type { CellData, ProjectColumnInfo } from './crosswalk-types'
import { parseSwapError, type SwapError } from './useCrosswalkMutations'
import type { useCrosswalkMutations } from './useCrosswalkMutations'
import { DragPreviewTooltip } from './DragPreviewTooltip'
import { rejectIneligibleAssignment } from './identifier-guard'
import {
  ADD_ROW_PREFIX,
  DRAWER_DROP_ID,
  NEW_BRACKET_TILE_DROP_ID,
  parseAddRowDropId,
  parseBracketSortId,
  parseCellDragId,
  parseEmptyCellDropId,
} from './drop-ids'

type CrosswalkMutations = ReturnType<typeof useCrosswalkMutations>

/** Ref-carried callbacks — the parent's `useCrosswalkMutations` invokes these
 * to feed snapshot/flash state into the DnD hook. Using a ref avoids a
 * circular dep: parent constructs mutations first (which reference the ref),
 * then useCrosswalkDnD wires actual handler functions into the ref via
 * useEffect. */
export interface CrosswalkDnDHandlerRefs {
  onSwapSuccess?: (info: { inversePayload: ColumnSwap[]; timestamp: number }) => void
  onMoveSuccess?: (info: {
    columnId: number
    targetEgId: number
    datasetId: number
    datasetName: string
    columnCode: string | null
    sourceEgId: number | null
    timestamp: number
  }) => void
  onSwapTypeMismatch?: (payload: ColumnSwap[], error: SwapError) => void
}

interface UseCrosswalkDnDOptions {
  activeDatasetIds: number[]
  allColumns: ProjectColumnInfo[]
  mutations: Pick<
    CrosswalkMutations,
    | 'swapMutation'
    | 'removeColumnFromRowMutation'
    | 'moveColumnMutation'
    | 'moveMembersMutation'
    | 'reorderDomainsMutation'
  >
  /** Parent passes a ref object; useCrosswalkDnD fills in its callbacks so
   * the parent's `useCrosswalkMutations` can call through. */
  handlerRefs: MutableRefObject<CrosswalkDnDHandlerRefs>
  /** Path A #325: column → owning analysis-domain ID. Used to recognize
   * cross-bracket gestures and route them through `moveMembersMutation`. */
  domainByColumnId?: Map<number, number>
  /** Path A #325: EG → owning analysis-domain ID. Used to resolve the
   * target domain when dropping into an empty EG cell. */
  domainByEgId?: Map<number, number>
  /** Path A #329: columns selected via Ctrl/Cmd-click in the crosswalk —
   * a drag with selectedColumnIds.size ≥ 2 (and the dragged column in the
   * set) becomes a multi-move. */
  selectedColumnIds?: Set<number>
  /** Add-row redesign commit 3: columns checkbox-selected in the
   * Unassigned panel. When the dragged unassigned card is in this set
   * (size ≥ 2), the drag fans out into a single multi-column
   * `move_members` call. The two selection sets are mutually exclusive in
   * practice — a column is either unassigned (panel set) or in a bracket
   * (selectedColumnIds set). */
  selectedUnassignedColumnIds?: Set<number>
  /** #327: current ordering of bracket domain IDs. Used by the bracket
   * sortable drag-end branch to compute oldIndex/newIndex from active.id /
   * over.id. Must be kept in sync with `domains.map(d => d.id)`. */
  bracketIds?: number[]
  /** #327: called when a cell drag hovers over a collapsed bracket's
   * sortable handle for ≥500ms. Consumer (CrosswalkView) uses this to
   * transiently expand the bracket so the drag can land. */
  onBracketHoverExpand?: (domainId: number | null) => void
  /** Inline tile (#discoverability): called when a cell drag is dropped on
   * the "+ New variable group" tile. The consumer (CrosswalkView) opens
   * `CreateDomainDialog` with `columnIds` pre-selected. Multi-select
   * follows the same convention as `move_members` — if the dragged cell is
   * in `selectedColumnIds`, all selected IDs are passed. */
  onNewBracketDrop?: (columnIds: number[]) => void
  /** Per-domain set of dataset IDs already represented in the bracket. Used
   * to pre-validate "+ Add variable row" drops against the #290 cross-
   * dataset pairing invariant: dropping a foreign-dataset column into a
   * cross-dataset bracket as a synthetic single-cell row would 409 on the
   * server (`assert_cross_dataset_members_are_paired`). Pre-blocking client-
   * side avoids the round-trip and gives an actionable toast instead. */
  bracketDatasetsByDomainId?: Map<number, Set<number>>
}

export interface CrosswalkDnDProviderProps {
  dnd: UseCrosswalkDnDResult
  children: ReactNode
}

const crosswalkCollisionDetection: CollisionDetection = (args) => {
  // Pointer-precise targets first: the Unassigned panel (DRAWER_DROP_ID) and
  // any "+ Add variable row" droppables (`add-row-*`). These must be aimed at
  // explicitly, not auto-snapped via closestCenter — otherwise a drag near
  // the bottom of a bracket would alternately snap between the row-end
  // button and the last row's empty cells based on fuzzy centroid math.
  const precisionDroppables = args.droppableContainers.filter(
    (c) =>
      c.id === DRAWER_DROP_ID ||
      (typeof c.id === 'string' && c.id.startsWith(ADD_ROW_PREFIX)),
  )
  if (precisionDroppables.length > 0) {
    const pointerHits = pointerWithin({
      ...args,
      droppableContainers: precisionDroppables,
    })
    if (pointerHits.length > 0) return pointerHits
  }
  return closestCenter({
    ...args,
    droppableContainers: args.droppableContainers.filter(
      (c) =>
        c.id !== DRAWER_DROP_ID &&
        !(typeof c.id === 'string' && c.id.startsWith(ADD_ROW_PREFIX)),
    ),
  })
}

export function CrosswalkDnDProvider({ dnd, children }: CrosswalkDnDProviderProps) {
  return (
    <DndContext
      sensors={dnd._sensors}
      collisionDetection={crosswalkCollisionDetection}
      onDragStart={dnd._handleDragStart}
      onDragOver={dnd._handleDragOver}
      onDragEnd={dnd._handleDragEnd}
      onDragCancel={dnd._handleDragCancel}
    >
      {children}
      {/* #334: portal the DragOverlay to document.body so its `position: fixed`
       * resolves against the viewport rather than against any ancestor that
       * has `transform` set (e.g. each Bracket's `<section>` carries
       * `transform: translate3d(...)` from `useSortable`, which establishes a
       * CSS containing block and traps `position: fixed` descendants).
       * React Context (DndContext) still flows through the portal because
       * portals preserve React parent-child relationships. */}
      {createPortal(
        <DragOverlay dropAnimation={null}>
          {dnd._activeCell ? (
            <DragPreviewTooltip
              cell={dnd._activeCell}
              multiSelectCount={dnd._activeMultiSelectCount}
            />
          ) : null}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  )
}

interface UseCrosswalkDnDResult {
  activeDragColumnId: number | null
  lastSwapSnapshot: { inversePayload: ColumnSwap[]; timestamp: number } | null
  clearSwapSnapshot: () => void
  conflictFlashColumnId: number | null
  flashConflict: (columnId: number) => void
  swapFlashColumnIds: Set<number>
  submitSwap: (payload: ColumnSwap[]) => void
  /** A8 — set by ContextMenu onOpenChange to block new drags while a menu
   * is open. Flips to false on menu close. */
  blockDragStartRef: MutableRefObject<boolean>
  _sensors: ReturnType<typeof useSensors>
  _handleDragStart: (event: DragStartEvent) => void
  _handleDragEnd: (event: DragEndEvent) => void
  _handleDragOver: (event: DragOverEvent) => void
  _handleDragCancel: () => void
  _activeCell: CellData | null
  /** Multi-select count for the DragOverlay's preview badge (≥2 when the
   * dragged source is part of a selection set, else 1). Passed into
   * `DragPreviewTooltip.multiSelectCount` so the lead card shows a "+N"
   * count badge. Computed lazily from the same selection sets that
   * `handleDragEnd` reads. */
  _activeMultiSelectCount: number
}

// The DnD context provider (CrosswalkDnDProvider) and this hook are an
// intentional cohesive pair — the provider consumes the hook's result type and
// the load-bearing crosswalkCollisionDetection lives alongside it. Splitting
// them only to satisfy Fast Refresh would scatter a documented load-bearing
// module; suppress here as elsewhere in the codebase (e.g. theme-context.tsx).
// eslint-disable-next-line react-refresh/only-export-components
export function useCrosswalkDnD({
  activeDatasetIds,
  allColumns,
  mutations,
  handlerRefs,
  domainByColumnId,
  domainByEgId,
  selectedColumnIds,
  bracketIds,
  onBracketHoverExpand,
  onNewBracketDrop,
  bracketDatasetsByDomainId,
  selectedUnassignedColumnIds,
}: UseCrosswalkDnDOptions): UseCrosswalkDnDResult {
  const [activeDragColumnId, setActiveDragColumnId] = useState<number | null>(null)
  const [conflictFlashColumnId, setConflictFlashColumnId] = useState<number | null>(null)
  const [swapFlashColumnIds, setSwapFlashColumnIds] = useState<Set<number>>(() => new Set())
  const [lastSwapSnapshot, setLastSwapSnapshot] = useState<{
    inversePayload: ColumnSwap[]
    timestamp: number
  } | null>(null)
  const swapInFlight = useRef(false)
  const blockDragStart = useRef(false)
  // #339: monotonic generation counter for the post-swap/move flash timer.
  // The earlier identity guard (`prev === flashed`) lost when a second swap
  // landed within 1300ms — the first timer's `flashed` Set was no longer the
  // current state, so its check failed and it no-op'd, leaving the second
  // flash stuck on screen indefinitely. Latest handler bumps the counter and
  // captures it; only the timer whose captured value matches the current
  // ref clears the flash. Earlier timers always lose and silently no-op.
  const flashGenRef = useRef(0)

  // Single options ref consolidating every prop that handlers read at
  // drop-time. The pattern exists to keep `handleDragEnd` / `handleDragOver`
  // / `submitSwap` / `clearHoverExpand` callback identities stable across
  // parent renders so the leaf React.memo wrappers (Bracket / EquivalenceRow
  // / Cell) skip work during a drag (#332 perf — see equivalence.md). The
  // effect intentionally has no dep array: TanStack Query's mutation object
  // churns identity per render and the prior 9-effect form ran on every
  // render anyway, so the consolidation is a pure simplification — one
  // source of truth, no future-option drift, no dep-array bookkeeping.
  // (Audit Batch C, P6 step 2.)
  const optionsRef = useRef({
    mutations,
    domainByColumnId,
    domainByEgId,
    selectedColumnIds,
    bracketIds,
    onBracketHoverExpand,
    onNewBracketDrop,
    bracketDatasetsByDomainId,
    selectedUnassignedColumnIds,
  })
  useEffect(() => {
    optionsRef.current = {
      mutations,
      domainByColumnId,
      domainByEgId,
      selectedColumnIds,
      bracketIds,
      onBracketHoverExpand,
      onNewBracketDrop,
      bracketDatasetsByDomainId,
      selectedUnassignedColumnIds,
    }
  })

  // #327: bracket-sort dragOver auto-expand. Tracks which bracket is
  // currently hovered + a 500ms timeout that fires the consumer's hook so
  // the bracket transiently expands to accept the drop. Cleared when over
  // changes, drag ends, or drag cancels.
  const hoveredBracketIdRef = useRef<number | null>(null)
  const hoverExpandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearHoverExpand = useCallback(() => {
    if (hoverExpandTimerRef.current != null) {
      clearTimeout(hoverExpandTimerRef.current)
      hoverExpandTimerRef.current = null
    }
    hoveredBracketIdRef.current = null
    optionsRef.current.onBracketHoverExpand?.(null)
  }, [])

  // Register handler callbacks on the parent's ref so useCrosswalkMutations
  // can call through. Ref-based wiring avoids a circular construction
  // order (parent → mutations → DnD hook → parent's mutations' callbacks).
  // (handleDragEnd and submitSwap read mutations through optionsRef.)
  useEffect(() => {
    handlerRefs.current.onSwapSuccess = (info) => {
      setLastSwapSnapshot({ inversePayload: info.inversePayload, timestamp: info.timestamp })
      const flashed = new Set<number>()
      for (const { column_id_a, column_id_b } of info.inversePayload) {
        flashed.add(column_id_a)
        flashed.add(column_id_b)
      }
      setSwapFlashColumnIds(flashed)
      const myGen = ++flashGenRef.current
      setTimeout(() => {
        if (flashGenRef.current === myGen) setSwapFlashColumnIds(new Set())
      }, 1300)
    }
    handlerRefs.current.onMoveSuccess = (info) => {
      const flashed = new Set<number>([info.columnId])
      setSwapFlashColumnIds(flashed)
      const myGen = ++flashGenRef.current
      setTimeout(() => {
        if (flashGenRef.current === myGen) setSwapFlashColumnIds(new Set())
      }, 1300)
    }
    return () => {
      // On unmount, null out the refs so a late mutation callback is a no-op.
      handlerRefs.current.onSwapSuccess = undefined
      // eslint-disable-next-line react-hooks/exhaustive-deps -- handlerRefs is a stable passed-in ref; cleanup intentionally nulls the LIVE ref's props so a late callback is a no-op (snapshotting to a local would defeat that)
      handlerRefs.current.onMoveSuccess = undefined
    }
  }, [handlerRefs])

  const columnsById = useMemo(() => {
    const map = new Map<number, ProjectColumnInfo>()
    for (const c of allColumns) map.set(c.id, c)
    return map
  }, [allColumns])

  const sensors = useSensors(
    useSensor(PointerSensor, {
      // 3px activation distance — tight enough to feel responsive (a 5px
      // threshold was missing too many intended drags per manual testing)
      // but large enough that a bare click stays a click.
      activationConstraint: { distance: 3 },
    }),
  )

  const flashConflict = useCallback((columnId: number) => {
    setConflictFlashColumnId(columnId)
    setTimeout(() => setConflictFlashColumnId((id) => (id === columnId ? null : id)), 700)
  }, [])

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      if (swapInFlight.current) return
      if (blockDragStart.current) return
      const columnId = parseCellDragId(event.active.id)
      if (columnId == null) return
      setActiveDragColumnId(columnId)
    },
    [],
  )

  const handleDragCancel = useCallback(() => {
    setActiveDragColumnId(null)
    clearHoverExpand()
  }, [clearHoverExpand])

  // #327: dragOver tracks bracket-label hover during a CELL drag and
  // schedules a 500ms auto-expand. Bracket-sort drags don't trigger this
  // (a bracket dragging over another bracket is a reorder gesture, not an
  // expand gesture).
  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const { active, over } = event
      const isCellDrag = parseCellDragId(active.id) != null
      if (!isCellDrag) {
        if (hoveredBracketIdRef.current != null) clearHoverExpand()
        return
      }
      const overBracketId = over ? parseBracketSortId(over.id) : null
      if (overBracketId == null) {
        if (hoveredBracketIdRef.current != null) clearHoverExpand()
        return
      }
      if (hoveredBracketIdRef.current === overBracketId) return
      // New bracket — restart the timer.
      if (hoverExpandTimerRef.current != null) {
        clearTimeout(hoverExpandTimerRef.current)
      }
      hoveredBracketIdRef.current = overBracketId
      hoverExpandTimerRef.current = setTimeout(() => {
        optionsRef.current.onBracketHoverExpand?.(overBracketId)
        hoverExpandTimerRef.current = null
      }, 500)
    },
    [clearHoverExpand],
  )

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDragColumnId(null)
      clearHoverExpand()
      const { active, over } = event
      if (!over) return

      // All props are read through optionsRef so this callback's identity
      // stays stable across parent renders — see optionsRef definition above.
      const opts = optionsRef.current
      const m = opts.mutations

      // #327: bracket-sort drag end → reorder mutation. Checked first so
      // a bracket reorder never falls through into cell-drag logic.
      const sortSourceId = parseBracketSortId(active.id)
      if (sortSourceId != null) {
        const sortTargetId = parseBracketSortId(over.id)
        if (sortTargetId == null || sortSourceId === sortTargetId) return
        const ids = opts.bracketIds
        if (!ids || ids.length === 0) return
        const oldIndex = ids.indexOf(sortSourceId)
        const newIndex = ids.indexOf(sortTargetId)
        if (oldIndex < 0 || newIndex < 0) return
        const newOrder = arrayMove(ids, oldIndex, newIndex)
        m.reorderDomainsMutation.mutate({ domainIds: newOrder })
        return
      }

      const sourceColumnId = parseCellDragId(active.id)
      if (sourceColumnId == null) return
      const sourceCol = columnsById.get(sourceColumnId)
      if (!sourceCol) return

      // Path A (#328): resolve current domain memberships for the source
      // column(s). The multi-select case sends N column_ids in one
      // moveMembersMutation call — they all migrate atomically.
      //
      // Two selection sets feed multi-select: in-bracket Cmd/Ctrl-click
      // (`selectedColumnIds`) and Unassigned panel checkboxes
      // (`selectedUnassignedColumnIds`). They're mutually exclusive in
      // practice (a column is either in a bracket or unassigned), so
      // pick whichever contains the dragged column.
      const domainByCol = opts.domainByColumnId
      const domainByEg = opts.domainByEgId
      const inBracketSet = opts.selectedColumnIds
      const inPanelSet = opts.selectedUnassignedColumnIds
      const useBracketSet =
        inBracketSet != null &&
        inBracketSet.size >= 2 &&
        inBracketSet.has(sourceColumnId)
      const usePanelSet =
        !useBracketSet &&
        inPanelSet != null &&
        inPanelSet.size >= 2 &&
        inPanelSet.has(sourceColumnId)
      const isMultiSelect = useBracketSet || usePanelSet
      const movingColumnIds = useBracketSet
        ? Array.from(inBracketSet!)
        : usePanelSet
          ? Array.from(inPanelSet!)
          : [sourceColumnId]
      const sourceDomainId =
        domainByCol?.get(sourceColumnId) ?? null

      // Panel drop — Path A: full unassign (sever both EG and domain
      // membership). When the source has no domain, fall back to the
      // existing severEG-only path so Unassigned panel drops on already-
      // ungrouped cells still work. (DRAWER_DROP_ID literal preserved per
      // equivalence.md — see drop-ids.ts.)
      if (over.id === DRAWER_DROP_ID) {
        if (sourceDomainId != null) {
          swapInFlight.current = true
          m.moveMembersMutation.mutate(
            {
              column_ids: movingColumnIds,
              source_domain_id: sourceDomainId,
              target_domain_id: null,
              target_mode: 'strip',
            },
            {
              onSettled: () => {
                swapInFlight.current = false
              },
            },
          )
          return
        }
        if (sourceCol.equivalence_group_id == null) return
        swapInFlight.current = true
        m.removeColumnFromRowMutation.mutate(
          { groupId: sourceCol.equivalence_group_id, columnId: sourceCol.id },
          {
            onSettled: () => {
              swapInFlight.current = false
            },
          },
        )
        return
      }

      // #556b: every remaining branch except the swap ASSIGNS the dragged
      // column(s) into a variable group / equivalence row. Identifier (and
      // skip) columns can't be members — reject here, once, rather than in
      // each branch. Deliberately placed AFTER the Unassigned-panel branch
      // above: dragging an identifier OUT of a group is the repair gesture and
      // must keep working. Cell-to-cell swap (further down) is also untouched —
      // it exchanges two columns that are already members and adds nothing.
      const isAssigningDrop =
        over.id === NEW_BRACKET_TILE_DROP_ID ||
        parseAddRowDropId(over.id) != null ||
        parseEmptyCellDropId(over.id) != null
      if (
        isAssigningDrop &&
        rejectIneligibleAssignment(movingColumnIds, columnsById, flashConflict)
      ) {
        return
      }

      // "+ New variable group" tile drop — open the create dialog with the
      // dragged column(s) pre-selected. No backend mutation fires here; the
      // parent's CreateDomainDialog confirm handler issues the actual
      // create_group + add_members calls. Multi-select behavior matches
      // move_members (movingColumnIds already gathered above).
      if (over.id === NEW_BRACKET_TILE_DROP_ID) {
        opts.onNewBracketDrop?.(movingColumnIds)
        return
      }

      // "+ Add variable row" drop — land the dragged column(s) as synthetic
      // single-cell rows in the target bracket's domain. Severs each
      // column's EG link (target_mode='strip') so the row is a synthetic
      // unlinked member; if the bracket is cross-dataset, every column
      // being moved needs to share its dataset with at least one existing
      // member to satisfy #290. Pre-blocked client-side to avoid a 409
      // round-trip.
      const addRowDomainId = parseAddRowDropId(over.id)
      if (addRowDomainId != null) {
        // Same-bracket cell → row-end is a silent no-op. Severing the EG
        // via drag is a destructive surprise — if the user wants this, the
        // cell context-menu's "Remove from equivalence row" is the right
        // verb. (Drag-from-unassigned never hits this branch since
        // unassigned columns have null sourceDomainId.)
        if (sourceDomainId === addRowDomainId) return

        // #290 pre-validation: cross-dataset bracket + foreign-dataset
        // source. The bracket is "cross-dataset" when its current member
        // dataset set has size ≥ 2; every moving column's dataset must
        // already be present in that set, otherwise the new synthetic row
        // would leave the column unpaired (no EG sibling) and the
        // post-mutation assert_cross_dataset_members_are_paired would 409.
        const targetDatasets =
          opts.bracketDatasetsByDomainId?.get(addRowDomainId)
        const targetIsCrossDataset =
          targetDatasets != null && targetDatasets.size >= 2
        if (targetIsCrossDataset) {
          const offending: number[] = []
          for (const cid of movingColumnIds) {
            const c = columnsById.get(cid)
            if (c && !targetDatasets!.has(c.dataset_id)) offending.push(cid)
          }
          if (offending.length > 0) {
            flashConflict(sourceColumnId)
            toast.error(
              isMultiSelect
                ? `${offending.length} of ${movingColumnIds.length} selected columns are from datasets not yet in this group.`
                : 'Cross-dataset variable groups need columns paired across datasets.',
              {
                description:
                  'Drop on an empty cell in a paired row, or use Promote to Paired.',
                id: 'crosswalk-add-row-cross-dataset',
              },
            )
            return
          }
        }

        swapInFlight.current = true
        m.moveMembersMutation.mutate(
          {
            column_ids: movingColumnIds,
            source_domain_id: sourceDomainId,
            target_domain_id: addRowDomainId,
            target_mode: 'strip',
          },
          {
            onSettled: () => {
              swapInFlight.current = false
            },
          },
        )
        return
      }

      // Empty-cell drop — Path A routes cross-bracket moves through
      // moveMembersMutation (atomic EG + domain change); same-bracket moves
      // stay on moveColumnMutation (EG-only change, no domain churn).
      const emptyTarget = parseEmptyCellDropId(over.id)
      if (emptyTarget) {
        if (emptyTarget.kind === 'unlinked') {
          // Promote-to-paired: drop a sibling-dataset cell on a synthetic
          // row's empty cell ⇒ create a new EG containing both, both stay
          // in the synthetic row's owning domain. Multi-select doesn't
          // make sense here — promote-to-paired is a 2-column gesture.
          if (isMultiSelect) {
            flashConflict(sourceColumnId)
            toast.error(
              'Promote to Paired is a single-column gesture. Drop one card here to pair it with the synthetic row.',
              { id: 'crosswalk-promote-paired-multi' },
            )
            return
          }
          if (emptyTarget.datasetId !== sourceCol.dataset_id) {
            flashConflict(sourceColumnId)
            return
          }
          // Don't allow the same column to be its own pair (no-op).
          if (emptyTarget.columnId === sourceCol.id) return
          const targetDomainId = domainByCol?.get(emptyTarget.columnId) ?? null
          if (targetDomainId == null) return
          swapInFlight.current = true
          m.moveMembersMutation.mutate(
            {
              column_ids: [sourceCol.id, emptyTarget.columnId],
              source_domain_id: sourceDomainId,
              target_domain_id: targetDomainId,
              target_mode: 'new_eg',
              target_eg_label: sourceCol.column_text || `Promoted ${sourceCol.column_code ?? ''}`,
            },
            {
              onSettled: () => {
                swapInFlight.current = false
              },
            },
          )
          return
        }
        // Can't drop onto the source's own row (same EG — no-op).
        if (emptyTarget.egId === sourceCol.equivalence_group_id) return
        // Empty-cell drops are dataset-scoped to the partial unique index.
        // For multi-select, every moving column must match the target
        // dataset (otherwise the existing_eg drop would 409 on
        // _assert_columns_unique_per_dataset). The dragged source's check
        // is symmetric: if it doesn't match, conflict-flash and bail.
        if (emptyTarget.datasetId !== sourceCol.dataset_id) {
          flashConflict(sourceColumnId)
          return
        }
        if (isMultiSelect) {
          // 1:1-per-dataset (#289): if any moving column shares a dataset
          // with another moving column, the EG would violate the partial
          // unique index. The dataset-match check above ensures the source
          // matches the target dataset; if any OTHER moving column matches
          // the same dataset, we'd be inserting 2+ columns from one dataset
          // into one EG. That's the 409. Reject.
          const sameDatasetCount = movingColumnIds.reduce((acc, cid) => {
            const c = columnsById.get(cid)
            return c?.dataset_id === sourceCol.dataset_id ? acc + 1 : acc
          }, 0)
          if (sameDatasetCount >= 2) {
            flashConflict(sourceColumnId)
            toast.error(
              'Selection contains 2+ columns from the same dataset — they cannot share a variable row.',
              {
                description:
                  'Drop on the row-end "+ Add variable row" target instead so each column lands as its own row.',
                id: 'crosswalk-existing-eg-1to1',
              },
            )
            return
          }
          // Same-type check (target EG ends up with ≥2 cols of mixed type
          // → 409 on assert_columns_same_type). Compare the source's type
          // against any non-source moving column targeting this dataset
          // through this branch (will be at most one given the 1:1 check
          // above). Cross-dataset multi-select with different types is
          // fine in theory — different dataset, different EG row — but
          // since this branch is one EG, we only hit type mismatch when
          // the multi-select drops different-type columns onto the same
          // EG. The 1:1 check rejects all cross-dataset multi-selects
          // implicitly (they'd hit the 1:1 check first if mixed-dataset,
          // or the type check second if same-dataset same-EG).
          // Conservative: also reject mixed-type multi-selects targeting
          // an existing_eg drop.
          const types = new Set<string>()
          for (const cid of movingColumnIds) {
            const c = columnsById.get(cid)
            if (c) types.add(c.column_type)
          }
          if (types.size >= 2) {
            flashConflict(sourceColumnId)
            toast.error(
              'Selection contains mixed column types. Variable rows must contain compatible types.',
              { id: 'crosswalk-existing-eg-types' },
            )
            return
          }
        }
        const targetDomainId = domainByEg?.get(emptyTarget.egId) ?? null
        // Routing rule (post-latent-bug-fix):
        //   - If the target EG belongs to a domain AND the source is not
        //     already a member of that domain → moveMembersMutation
        //     (atomic EG + domain insert). This is the normal Path A path
        //     for cross-bracket drops AND drag-from-unassigned drops.
        //   - Otherwise (same-bracket re-link, or rare no-domain orphan EG
        //     target) → moveColumnMutation (EG-only change).
        // Old code routed unassigned-source drops here through
        // moveColumnMutation, which silently created a domain-membership
        // orphan (column had EG but was not a domain member). The new
        // condition catches that case via `sourceDomainId !== targetDomainId`
        // (treating null source as "not a member of target") and routes
        // through the atomic endpoint.
        const needsAtomicMove =
          targetDomainId != null && sourceDomainId !== targetDomainId
        if (needsAtomicMove) {
          swapInFlight.current = true
          m.moveMembersMutation.mutate(
            {
              column_ids: movingColumnIds,
              source_domain_id: sourceDomainId,
              target_domain_id: targetDomainId,
              target_mode: 'existing_eg',
              target_eg_id: emptyTarget.egId,
            },
            {
              onSettled: () => {
                swapInFlight.current = false
              },
            },
          )
          return
        }
        // Same-bracket EG re-link (or no-domain orphan-EG target) — keep
        // moveColumnMutation. moveColumnMutation does NOT touch
        // AnalysisDomainMember; relying on it for any case where the
        // column would need to gain or lose domain membership creates
        // orphans (the bug fixed above).
        swapInFlight.current = true
        m.moveColumnMutation.mutate(
          {
            columnId: sourceCol.id,
            sourceEgId: sourceCol.equivalence_group_id ?? null,
            targetEgId: emptyTarget.egId,
            datasetId: sourceCol.dataset_id,
            datasetName: sourceCol.dataset_name,
            columnCode: sourceCol.column_code,
          },
          {
            onSettled: () => {
              swapInFlight.current = false
            },
          },
        )
        return
      }

      // Cell drop → swap
      const targetColumnId = parseCellDragId(over.id)
      if (targetColumnId == null) return
      if (targetColumnId === sourceColumnId) return

      const targetCol = columnsById.get(targetColumnId)
      if (!targetCol) return

      if (targetCol.dataset_id !== sourceCol.dataset_id) {
        flashConflict(targetColumnId)
        return
      }

      if (sourceCol.equivalence_group_id == null || targetCol.equivalence_group_id == null) {
        flashConflict(targetColumnId)
        return
      }

      if (sourceCol.equivalence_group_id === targetCol.equivalence_group_id) {
        flashConflict(targetColumnId)
        return
      }

      // No cross-domain guard needed. As of #336 (Batch B, 2026-04-30) the
      // swap endpoint atomically swaps domain membership alongside the EG
      // re-assignment, so cross-variable-group swaps no longer leave phantom
      // cells (col stays a member of the new bracket only).
      const payload: ColumnSwap[] = [
        { column_id_a: sourceColumnId, column_id_b: targetColumnId },
      ]
      swapInFlight.current = true
      m.swapMutation.mutate(payload, {
        onError: (err) => {
          const parsed = parseSwapError(err)
          if (parsed?.error === 'type_mismatch' || parsed?.error === 'cross_dataset_unpaired') {
            flashConflict(targetColumnId)
          }
        },
        onSettled: () => {
          swapInFlight.current = false
        },
      })
    },
    [columnsById, flashConflict, clearHoverExpand],
  )

  const prevActiveDatasetsRef = useRef(activeDatasetIds)
  useEffect(() => {
    const prev = prevActiveDatasetsRef.current
    const changed =
      prev.length !== activeDatasetIds.length ||
      prev.some((id) => !activeDatasetIds.includes(id))
    if (changed && activeDragColumnId != null) {
      setActiveDragColumnId(null)
    }
    prevActiveDatasetsRef.current = activeDatasetIds
  }, [activeDatasetIds, activeDragColumnId])

  const clearSwapSnapshot = useCallback(() => setLastSwapSnapshot(null), [])

  const activeCell = useMemo<CellData | null>(() => {
    if (activeDragColumnId == null) return null
    const col = columnsById.get(activeDragColumnId)
    if (!col) return null
    return {
      column_id: col.id,
      dataset_id: col.dataset_id,
      dataset_name: col.dataset_name,
      column_code: col.column_code,
      column_text: col.column_text,
      column_type: col.column_type,
      scale_points: col.scale_points ?? null,
      scale_labels: col.scale_labels ?? null,
      is_reverse_scored: false,
      recode_def_count: col.recode_def_count ?? 0,
      equivalence_group_id: col.equivalence_group_id ?? null,
    }
  }, [activeDragColumnId, columnsById])

  // Multi-select count for the DragOverlay's preview badge. Recomputes
  // whenever the active drag changes OR the relevant selection set changes
  // — both selection sets are referentially stable per the consumer's
  // existing memoization, so the dep array doesn't churn.
  const activeMultiSelectCount = useMemo<number>(() => {
    if (activeDragColumnId == null) return 0
    if (
      selectedColumnIds != null &&
      selectedColumnIds.size >= 2 &&
      selectedColumnIds.has(activeDragColumnId)
    ) {
      return selectedColumnIds.size
    }
    if (
      selectedUnassignedColumnIds != null &&
      selectedUnassignedColumnIds.size >= 2 &&
      selectedUnassignedColumnIds.has(activeDragColumnId)
    ) {
      return selectedUnassignedColumnIds.size
    }
    return 1
  }, [activeDragColumnId, selectedColumnIds, selectedUnassignedColumnIds])

  const submitSwap = useCallback((payload: ColumnSwap[]) => {
    swapInFlight.current = true
    optionsRef.current.mutations.swapMutation.mutate(payload, {
      onSettled: () => {
        swapInFlight.current = false
      },
    })
  }, [])

  return {
    activeDragColumnId,
    lastSwapSnapshot,
    clearSwapSnapshot,
    conflictFlashColumnId,
    flashConflict,
    swapFlashColumnIds,
    submitSwap,
    blockDragStartRef: blockDragStart,
    _sensors: sensors,
    _handleDragStart: handleDragStart,
    _handleDragEnd: handleDragEnd,
    _handleDragOver: handleDragOver,
    _handleDragCancel: handleDragCancel,
    _activeCell: activeCell,
    _activeMultiSelectCount: activeMultiSelectCount,
  }
}
