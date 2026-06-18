/**
 * useCrosswalkSearch — full-grid search for the crosswalk view (§2 item 33).
 *
 * Maintains a local search query (NOT URL-synced — per directive open
 * question #4 / item 33) and computes a `Set<number>` of column IDs that
 * match the query across all brackets and the Unassigned panel.
 *
 * Match predicate: substring of `column_code` OR `column_text` (case-
 * insensitive, trimmed).
 *
 * **Highlight color (§2 item 36):** this hook returns the match set; the
 * consuming components (Cell, UnassignedPanel) render highlights in
 * sky-200 / dark:sky-900 — NOT amber. Amber is reserved for Suggest Groups
 * ghost rows and conflict flashes. The two must be visually distinct when
 * both are present simultaneously.
 */

import { useCallback, useMemo, useState } from 'react'
import type { CrosswalkGrid, ProjectColumnInfo } from './crosswalk-types'

interface UseCrosswalkSearchParams {
  grid: CrosswalkGrid
  unassigned: ProjectColumnInfo[]
}

export interface CrosswalkSearchState {
  query: string
  setQuery: (q: string) => void
  clear: () => void
  searchHighlightIds: Set<number>
  isActive: boolean
}

export function useCrosswalkSearch({
  grid,
  unassigned,
}: UseCrosswalkSearchParams): CrosswalkSearchState {
  const [query, setQueryState] = useState('')

  const setQuery = useCallback((q: string) => {
    setQueryState(q)
  }, [])

  const clear = useCallback(() => {
    setQueryState('')
  }, [])

  const normalizedQuery = query.trim().toLowerCase()
  const isActive = normalizedQuery.length > 0

  const searchHighlightIds = useMemo<Set<number>>(() => {
    if (!isActive) return new Set()

    const matchIds = new Set<number>()

    // Generic matcher for column code + text
    const matches = (code: string | null, text: string): boolean => {
      if (code && code.toLowerCase().includes(normalizedQuery)) return true
      if (text.toLowerCase().includes(normalizedQuery)) return true
      return false
    }

    // Brackets → rows → cells (Path A #325: unified row model — synthetic
    // single-cell rows are part of `bracket.rows` so this iteration covers
    // both EG-keyed and unlinked members in one pass).
    for (const bracket of grid.brackets) {
      for (const row of bracket.rows) {
        for (const cell of row.cells_by_dataset.values()) {
          if ('column_id' in cell) {
            if (matches(cell.column_code, cell.column_text)) {
              matchIds.add(cell.column_id)
            }
          }
        }
      }
    }

    // Unassigned columns (for the panel)
    for (const col of unassigned) {
      if (matches(col.column_code, col.column_text)) {
        matchIds.add(col.id)
      }
    }

    return matchIds
  }, [grid, unassigned, isActive, normalizedQuery])

  return {
    query,
    setQuery,
    clear,
    searchHighlightIds,
    isActive,
  }
}
