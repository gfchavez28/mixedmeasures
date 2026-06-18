/**
 * useDatasetToggles — URL-synced dataset visibility state for the crosswalk
 * header (GAP 3.10).
 *
 * - Reads the `?datasets=1,3,7` query param on mount and builds a
 *   `Set<number>` of active dataset IDs.
 * - Omitted param means "all datasets selected" (default).
 * - Explicitly empty (`?datasets=`) means "none selected" and triggers
 *   the AllDatasetsOffState informational empty state (§2 item 35).
 * - Writes back to the URL via `replace-navigate` (no history pollution).
 *
 * This mirrors the existing `useAnalysisUrlState` pattern from
 * `frontend/src/hooks/useAnalysisUrlState.ts` — `useSearchParams` + manual
 * encode/decode.
 */

import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'

export interface DatasetToggleState {
  /** Set of active dataset IDs, or null if "all datasets selected" (default). */
  activeDatasetIds: Set<number> | null
  /** Test if a specific dataset is currently active (includes the default case). */
  isActive: (dataset_id: number) => boolean
  /** Toggle a dataset's membership in the active set. */
  toggle: (dataset_id: number) => void
  /** Set the active set to a specific list (or null for "all selected"). */
  setActive: (ids: number[] | null) => void
  /** True if the user explicitly deselected every dataset. */
  isAllOff: boolean
}

export function useDatasetToggles(availableDatasetIds: number[]): DatasetToggleState {
  const [searchParams, setSearchParams] = useSearchParams()

  const paramValue = searchParams.get('datasets')

  const activeDatasetIds = useMemo<Set<number> | null>(() => {
    // Param missing → default "all selected"
    if (paramValue === null) return null
    // Param explicitly empty → "none selected" (AllDatasetsOffState)
    if (paramValue === '') return new Set()
    // Parse comma-separated IDs
    const ids = paramValue
      .split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !isNaN(n))
    return new Set(ids)
  }, [paramValue])

  const isActive = useCallback(
    (dataset_id: number): boolean => {
      if (activeDatasetIds === null) return true  // default: all on
      return activeDatasetIds.has(dataset_id)
    },
    [activeDatasetIds],
  )

  const setActive = useCallback(
    (ids: number[] | null) => {
      setSearchParams(
        prev => {
          const next = new URLSearchParams(prev)
          if (ids === null) {
            next.delete('datasets')
          } else if (ids.length === 0) {
            next.set('datasets', '')
          } else {
            next.set('datasets', ids.join(','))
          }
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  const toggle = useCallback(
    (dataset_id: number) => {
      // Start from the effective active set. If the param is absent (default
      // "all on"), we materialize the full list first, then remove the target.
      const currentSet =
        activeDatasetIds ?? new Set<number>(availableDatasetIds)
      const next = new Set(currentSet)
      if (next.has(dataset_id)) {
        next.delete(dataset_id)
      } else {
        next.add(dataset_id)
      }
      // If toggling brought us back to "all datasets", revert to the default
      // URL-less state for cleaner shareable links.
      const allOn =
        next.size === availableDatasetIds.length &&
        availableDatasetIds.every(id => next.has(id))
      if (allOn) {
        setActive(null)
      } else {
        setActive(Array.from(next))
      }
    },
    [activeDatasetIds, availableDatasetIds, setActive],
  )

  const isAllOff = activeDatasetIds !== null && activeDatasetIds.size === 0

  return {
    activeDatasetIds,
    isActive,
    toggle,
    setActive,
    isAllOff,
  }
}
