/**
 * useCellDragIdRegistry — dev-mode defensive check for the F1 invariant
 * documented in the internal design notes and `drop-ids.ts`:
 *
 *   "A column's `cell-${columnId}` draggable must register exactly once
 *    across the rendered tree. dnd-kit's draggable Map is keyed by id;
 *    duplicate registrations silently overwrite (last-render wins) and
 *    the surviving registration's rect anchors the DragOverlay regardless
 *    of where the drag actually started."
 *
 * The two surfaces that legitimately register `cell-${id}` draggables are
 * `Cell.tsx` (in-bracket cells) and `UnassignedPanel.tsx`'s `<UnassignedCard>`
 * (panel cards). Their data filters are designed to be disjoint:
 *
 *   - Brackets render columns from `domains[].members[]` (member_type='column')
 *   - Panel renders `computeUnassignedColumns(allColumns, domainMemberColumnIds)`
 *
 * If a future refactor adds a third surface, drifts the panel's exclusion
 * filter (the #334 root-cause class), or re-introduces a synthetic-row case
 * that the panel filter misses, this hook will console.error in dev with
 * the colliding surface labels — pointing the next debugger directly at the
 * offenders instead of asking them to reverse-engineer dnd-kit's internals.
 *
 * Production cost: zero. `import.meta.env.DEV` is statically false in
 * production builds; Vite tree-shakes the whole effect body.
 *
 * StrictMode safety: per-surface mount counts balance themselves through
 * React's mount → cleanup → mount simulated cycle, so a single component
 * does not trip its own check. Two distinct surfaces with the same dragId
 * leave `surfaces.size > 1` and warn — that's the bug we're catching.
 */

import { useEffect } from 'react'

// Module-scoped registry: dragId → (surface label → live mount count).
// Per-surface counter (not a flat Set) because StrictMode dev simulates a
// mount → cleanup → mount cycle for the same component instance, which would
// false-positive a Set-based check on the simulated remount.
const registry = new Map<string, Map<string, number>>()

export function useCellDragIdRegistry(dragId: string, surfaceLabel: string): void {
  useEffect(() => {
    if (!import.meta.env.DEV) return
    let surfaces = registry.get(dragId)
    if (!surfaces) {
      surfaces = new Map<string, number>()
      registry.set(dragId, surfaces)
    }
    surfaces.set(surfaceLabel, (surfaces.get(surfaceLabel) ?? 0) + 1)
    if (surfaces.size > 1) {

      console.error(
        `[crosswalk] duplicate cell drag-id ${dragId} registered by surfaces: ` +
          `${[...surfaces.keys()].join(', ')}. dnd-kit's draggable Map silently ` +
          `overwrites — DragOverlay will anchor at the wrong rect. See F1 ` +
          `invariant in the internal design notes.`,
      )
    }
    return () => {
      const live = registry.get(dragId)
      if (!live) return
      const cur = live.get(surfaceLabel) ?? 0
      if (cur <= 1) live.delete(surfaceLabel)
      else live.set(surfaceLabel, cur - 1)
      if (live.size === 0) registry.delete(dragId)
    }
  }, [dragId, surfaceLabel])
}

/** Test-only — reset between tests so module-scoped registry doesn't leak
 * mount counts across test files. NOT exposed in production usage. */
export function __resetCellDragIdRegistryForTests(): void {
  registry.clear()
}
