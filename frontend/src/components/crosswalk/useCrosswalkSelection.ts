/**
 * useCrosswalkSelection — owns the two crosswalk multi-select sets.
 *
 * The crosswalk has two mutually-exclusive selection contexts:
 *   - `selectedCellIds` — Cmd/Ctrl-click multi-select on cells inside a
 *     bracket. Plain click is a focus-only no-op (matches Excel/Finder).
 *     Drag from a selected cell with size ≥ 2 fans out into one
 *     moveMembersMutation call. (Path A #329.)
 *   - `selectedUnassignedIds` — checkbox multi-select on Unassigned panel
 *     cards. When dragged, fans out the same way for unassigned columns.
 *
 * The two sets are mutually exclusive in practice — a column is either
 * unassigned (panel set) or in a bracket (cell set), never both.
 *
 * Behavior preserved:
 *   - Escape clears `selectedCellIds` (only registers when size > 0).
 *   - `selectedUnassignedIds` auto-prunes to live `unassigned` IDs after
 *     any mutation that removes columns from the panel.
 *   - `selectedCellIds` does NOT auto-clear after mutations — selection
 *     persists so researchers can chain follow-up actions on the same set.
 *
 * Audit Batch C, P4 step 3.
 */

import { useCallback, useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { ProjectColumnInfo } from './crosswalk-types'

export interface CrosswalkSelection {
  selectedCellIds: Set<number>
  handleCellClick: (columnId: number, modKey: boolean) => void
  selectedUnassignedIds: Set<number>
  setSelectedUnassignedIds: Dispatch<SetStateAction<Set<number>>>
  toggleUnassigned: (columnId: number) => void
  clearUnassignedSelection: () => void
}

export function useCrosswalkSelection(
  unassigned: ProjectColumnInfo[],
): CrosswalkSelection {
  const [selectedUnassignedIds, setSelectedUnassignedIds] = useState<Set<number>>(
    () => new Set(),
  )

  const toggleUnassigned = useCallback((columnId: number) => {
    setSelectedUnassignedIds((prev) => {
      const next = new Set(prev)
      if (next.has(columnId)) next.delete(columnId)
      else next.add(columnId)
      return next
    })
  }, [])

  const clearUnassignedSelection = useCallback(
    () => setSelectedUnassignedIds(new Set()),
    [],
  )

  // Prune `selectedUnassignedIds` to IDs still in the panel — drag-and-drop,
  // dialog confirm, and any other mutation path that removes columns from
  // unassigned would otherwise leave stale IDs in the selection set
  // (toolbar "Add…" count would say "5 selected" with only 4 cards visible).
  // Cheap O(N) check; early-return when nothing changed preserves Set
  // identity so downstream memos can skip.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional prune of stale IDs when the unassigned panel changes (see comment above); identity-preserving early-return
    setSelectedUnassignedIds((prev) => {
      if (prev.size === 0) return prev
      const live = new Set<number>()
      for (const c of unassigned) live.add(c.id)
      let changed = false
      const next = new Set<number>()
      for (const id of prev) {
        if (live.has(id)) next.add(id)
        else changed = true
      }
      return changed ? next : prev
    })
  }, [unassigned])

  // Path A #329: Ctrl/Cmd-click multi-select on crosswalk cells. Plain
  // click is a focus-only no-op; only modifier-key clicks toggle. Drag
  // from a selected cell with size ≥ 2 fans out into moveMembersMutation.
  const [selectedCellIds, setSelectedCellIds] = useState<Set<number>>(
    () => new Set(),
  )

  const handleCellClick = useCallback(
    (columnId: number, modKey: boolean) => {
      if (!modKey) return
      setSelectedCellIds((prev) => {
        const next = new Set(prev)
        if (next.has(columnId)) next.delete(columnId)
        else next.add(columnId)
        return next
      })
    },
    [],
  )

  // Escape clears the cell selection. Listener only registers when the
  // selection is non-empty so we don't fight other Escape consumers.
  useEffect(() => {
    if (selectedCellIds.size === 0) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedCellIds(new Set())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedCellIds.size])

  return {
    selectedCellIds,
    handleCellClick,
    selectedUnassignedIds,
    setSelectedUnassignedIds,
    toggleUnassigned,
    clearUnassignedSelection,
  }
}
