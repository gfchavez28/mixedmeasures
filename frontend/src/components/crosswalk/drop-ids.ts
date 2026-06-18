/**
 * drop-ids — pure helpers for the Tier 3 crosswalk's dnd-kit drag/drop ID
 * namespaces. Extracted from useCrosswalkDnD.tsx (P6, audit 2026-04-30).
 *
 * Drag/drop ID scheme (8 namespaces):
 *   - `cell-${columnId}`                              — DataCell draggable + droppable
 *   - `empty-eg-${egId}-${datasetId}`                 — empty cell in an EG-keyed row
 *   - `empty-unlinked-${columnId}-${datasetId}`       — empty cell in a synthetic single-cell row
 *   - `bracket-sort-${domainId}`                      — sortable handle on a bracket grip
 *   - `add-row-${domainId}`                           — "+ Add variable row" drop target per bracket
 *   - `drawer-unassigned`                             — singleton Unassigned panel drop target
 *   - `new-bracket-tile`                              — singleton "+ New variable group" tile drop target
 *
 * ADR — drag ID namespaces (#327 + add-row).
 *
 * `bracket-sort-${id}` (BRACKET_SORT_PREFIX, #327) is the @dnd-kit/sortable
 * drag ID for bracket reordering. The grip handle on the bracket label is
 * the only node carrying these listeners.
 *
 * `add-row-${id}` (ADD_ROW_PREFIX) is the per-bracket "+ Add variable row"
 * drop target rendered at the bottom of each bracket frame. Drops here add
 * the dragged column(s) to the bracket's domain as synthetic single-cell
 * rows via `move_members(target_mode='strip', target_domain_id=X)`.
 *
 * Always check sort IDs first in handleDragEnd; bracket-sort drags are a
 * different flow (single mutation: reorderDomainsMutation) from cell drags.
 *
 * Drag-ID uniqueness invariant (#334, see equivalence.md): a column's
 * `cell-${columnId}` draggable must register exactly once across the
 * rendered tree. dnd-kit's draggable Map is keyed by id; duplicate
 * registrations silently overwrite (last-render wins) and the surviving
 * registration's rect anchors the DragOverlay regardless of where the drag
 * actually started. When adding a new surface that calls
 * `useDraggable({ id: makeCellDragId(...) })`, ensure the data filter
 * driving that surface excludes columns already rendered as draggables
 * elsewhere.
 */

export const CELL_PREFIX = 'cell-'
export const EMPTY_EG_PREFIX = 'empty-eg-'
export const EMPTY_UNLINKED_PREFIX = 'empty-unlinked-'
export const BRACKET_SORT_PREFIX = 'bracket-sort-'
export const ADD_ROW_PREFIX = 'add-row-'

const DRAWER_ID = 'drawer-unassigned'
/** Singleton drop target for the "+ New variable group" tile rendered after
 * the last bracket. Drop a column (or multi-select) here ⇒ open
 * CreateDomainDialog with those columns pre-selected. */
const NEW_BRACKET_TILE_ID = 'new-bracket-tile'

/** Phase 3.5: drop-target for the right-side Unassigned panel. Constant name
 * preserved for compatibility with the collision detector; semantically this
 * is "the panel" post-Phase-3.5. The literal value `'drawer-unassigned'` is
 * load-bearing — `crosswalkCollisionDetection` matches on the literal string.
 * See equivalence.md for the rename rationale and constraint. */
export const DRAWER_DROP_ID = DRAWER_ID

/** Drop-target ID for the inline "+ New variable group" tile. Singleton
 * (one tile per page). Drops here are routed to `onNewBracketDrop` in the
 * useCrosswalkDnD options so the parent can open the create dialog with
 * the dropped column IDs pre-selected. */
export const NEW_BRACKET_TILE_DROP_ID = NEW_BRACKET_TILE_ID

export function makeCellDragId(columnId: number): string {
  return `${CELL_PREFIX}${columnId}`
}

export function parseCellDragId(id: string | number | null | undefined): number | null {
  if (typeof id !== 'string') return null
  if (!id.startsWith(CELL_PREFIX)) return null
  const n = Number(id.slice(CELL_PREFIX.length))
  return Number.isFinite(n) ? n : null
}

/** Path A #325 + Path A #327: empty-cell drop ID schemes.
 *
 *   - `empty-eg-${egId}-${datasetId}`: empty cell in an EG-keyed row. Drop
 *     here ⇒ assign source column to that EG (move within bracket if same
 *     domain, full move + atomic add to target domain otherwise).
 *   - `empty-unlinked-${columnId}-${datasetId}`: empty cell in a synthetic
 *     single-cell row. Drop a sibling-dataset cell here ⇒ promote the
 *     synthetic row to a paired EG (target_mode='new_eg' with both columns).
 */
export type EmptyCellDropTarget =
  | { kind: 'eg'; egId: number; datasetId: number }
  | { kind: 'unlinked'; columnId: number; datasetId: number }

export function makeEmptyCellDropId(target: EmptyCellDropTarget): string {
  if (target.kind === 'eg') {
    return `${EMPTY_EG_PREFIX}${target.egId}-${target.datasetId}`
  }
  return `${EMPTY_UNLINKED_PREFIX}${target.columnId}-${target.datasetId}`
}

export function parseEmptyCellDropId(
  id: string | number | null | undefined,
): EmptyCellDropTarget | null {
  if (typeof id !== 'string') return null
  if (id.startsWith(EMPTY_EG_PREFIX)) {
    const rest = id.slice(EMPTY_EG_PREFIX.length)
    const parts = rest.split('-')
    if (parts.length !== 2) return null
    const egId = Number(parts[0])
    const datasetId = Number(parts[1])
    if (!Number.isFinite(egId) || !Number.isFinite(datasetId)) return null
    return { kind: 'eg', egId, datasetId }
  }
  if (id.startsWith(EMPTY_UNLINKED_PREFIX)) {
    const rest = id.slice(EMPTY_UNLINKED_PREFIX.length)
    const parts = rest.split('-')
    if (parts.length !== 2) return null
    const columnId = Number(parts[0])
    const datasetId = Number(parts[1])
    if (!Number.isFinite(columnId) || !Number.isFinite(datasetId)) return null
    return { kind: 'unlinked', columnId, datasetId }
  }
  return null
}

/** #327: sortable drag ID for bracket reorder. */
export function makeBracketSortId(domainId: number): string {
  return `${BRACKET_SORT_PREFIX}${domainId}`
}

export function parseBracketSortId(
  id: string | number | null | undefined,
): number | null {
  if (typeof id !== 'string') return null
  if (!id.startsWith(BRACKET_SORT_PREFIX)) return null
  const n = Number(id.slice(BRACKET_SORT_PREFIX.length))
  return Number.isFinite(n) ? n : null
}

/** Drop target on each bracket's "+ Add variable row" button. Drops here
 * land the dragged column(s) as synthetic single-cell rows in the bracket's
 * domain via `move_members(target_mode='strip', target_domain_id=X)`. */
export function makeAddRowDropId(domainId: number): string {
  return `${ADD_ROW_PREFIX}${domainId}`
}

export function parseAddRowDropId(
  id: string | number | null | undefined,
): number | null {
  if (typeof id !== 'string') return null
  if (!id.startsWith(ADD_ROW_PREFIX)) return null
  const n = Number(id.slice(ADD_ROW_PREFIX.length))
  return Number.isFinite(n) ? n : null
}
