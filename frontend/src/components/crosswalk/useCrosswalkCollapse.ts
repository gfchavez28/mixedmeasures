/**
 * useCrosswalkCollapse — per-bracket collapse state for the Tier 3
 * crosswalk (#327).
 *
 * State managed:
 *   - `collapsedDomainIds`: persisted `Set<number>` of domain IDs the user
 *     has explicitly collapsed. Persists per-project to localStorage under
 *     `mm-crosswalk-collapsed-${pid}` so "fold these scales away" intent
 *     survives reloads. The literal key string is load-bearing.
 *   - `dragHoverExpandedId`: transient, set by the DnD hook's dragOver
 *     handler (500ms hover on a collapsed bracket label during a cell
 *     drag). Cleared on drag end / cancel. Drives transient auto-expand.
 *   - `effectiveCollapsedIds`: derived. Persisted Set ∖ search-matches ∖
 *     dragHoverExpandedId. The persisted Set is unchanged when search
 *     clears or drag ends — collapse intent survives transient overrides.
 *
 * Behaviors preserved:
 *   - Prune stale IDs whenever `domains` changes (deleted domains'
 *     IDs would otherwise accumulate in localStorage forever).
 *   - Try/catch around localStorage `getItem`/`setItem` for quota /
 *     privacy-mode fallthrough.
 *   - "No change → return prev" early-returns preserve Set identity so
 *     downstream memos can skip.
 *
 * Audit Batch C, P4 step 4.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AnalysisDomainResponse } from '@/lib/api'

export interface CrosswalkCollapse {
  collapsedDomainIds: Set<number>
  effectiveCollapsedIds: Set<number>
  toggleCollapse: (domainId: number) => void
  collapseAll: () => void
  expandAll: () => void
  dragHoverExpandedId: number | null
  handleBracketHoverExpand: (domainId: number | null) => void
}

export function useCrosswalkCollapse(
  projectId: number,
  domains: AnalysisDomainResponse[],
  domainIdsWithSearchMatches: Set<number>,
): CrosswalkCollapse {
  const collapsedStorageKey = `mm-crosswalk-collapsed-${projectId}`

  const [collapsedDomainIds, setCollapsedDomainIds] = useState<Set<number>>(() => {
    if (typeof window === 'undefined') return new Set()
    try {
      const raw = window.localStorage.getItem(collapsedStorageKey)
      if (!raw) return new Set()
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return new Set()
      return new Set(parsed.filter((n): n is number => typeof n === 'number'))
    } catch {
      return new Set()
    }
  })

  const persistCollapsed = useCallback(
    (next: Set<number>) => {
      try {
        window.localStorage.setItem(
          collapsedStorageKey,
          JSON.stringify(Array.from(next)),
        )
      } catch {
        // quota / privacy mode — silently fall through.
      }
    },
    [collapsedStorageKey],
  )

  const toggleCollapse = useCallback(
    (domainId: number) => {
      setCollapsedDomainIds((prev) => {
        const next = new Set(prev)
        if (next.has(domainId)) next.delete(domainId)
        else next.add(domainId)
        persistCollapsed(next)
        return next
      })
    },
    [persistCollapsed],
  )

  const collapseAll = useCallback(() => {
    const allIds = new Set(domains.map((d) => d.id))
    setCollapsedDomainIds(allIds)
    persistCollapsed(allIds)
  }, [domains, persistCollapsed])

  const expandAll = useCallback(() => {
    const empty = new Set<number>()
    setCollapsedDomainIds(empty)
    persistCollapsed(empty)
  }, [persistCollapsed])

  // Prune stale IDs from the collapsed Set whenever domains change.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional prune of stale domain IDs when domains change (#327); identity-preserving early-return
    setCollapsedDomainIds((prev) => {
      if (prev.size === 0) return prev
      const liveIds = new Set(domains.map((d) => d.id))
      let changed = false
      const next = new Set<number>()
      for (const id of prev) {
        if (liveIds.has(id)) next.add(id)
        else changed = true
      }
      if (!changed) return prev
      persistCollapsed(next)
      return next
    })
  }, [domains, persistCollapsed])

  const [dragHoverExpandedId, setDragHoverExpandedId] = useState<number | null>(null)
  const handleBracketHoverExpand = useCallback((domainId: number | null) => {
    setDragHoverExpandedId(domainId)
  }, [])

  // Effective per-bracket collapsed state: persisted Set minus the search
  // auto-expand set minus the dragOver hover-expand target. Persisted set
  // is unchanged so the user's collapse intent survives search clear /
  // drag end.
  const effectiveCollapsedIds = useMemo(() => {
    if (collapsedDomainIds.size === 0) return collapsedDomainIds
    if (domainIdsWithSearchMatches.size === 0 && dragHoverExpandedId == null) {
      return collapsedDomainIds
    }
    const next = new Set(collapsedDomainIds)
    for (const id of domainIdsWithSearchMatches) next.delete(id)
    if (dragHoverExpandedId != null) next.delete(dragHoverExpandedId)
    return next
  }, [collapsedDomainIds, domainIdsWithSearchMatches, dragHoverExpandedId])

  return {
    collapsedDomainIds,
    effectiveCollapsedIds,
    toggleCollapse,
    collapseAll,
    expandAll,
    dragHoverExpandedId,
    handleBracketHoverExpand,
  }
}
