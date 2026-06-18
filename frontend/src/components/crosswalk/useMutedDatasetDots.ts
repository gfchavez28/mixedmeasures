import { useCallback, useState } from 'react'

/**
 * Per-project crosswalk dataset-dot visibility state.
 *
 * Two independent layers:
 *
 *   - `mutedSet` — `Set<datasetId>` of datasets whose dots are individually
 *     hidden. Toggled by clicking any dot for that dataset (column header
 *     OR cell — both surfaces sync via this shared state).
 *
 *   - `allMuted` — boolean. When `true`, ALL crosswalk dots are hidden
 *     regardless of per-dataset state. Toggling restores per-dataset
 *     state (preserved, not destructed).
 *
 * Both layers persist to `localStorage` per project so the researcher's
 * preference survives reloads. Storage keys mirror the existing
 * `mm-crosswalk-collapsed-${projectId}` pattern.
 *
 * Hierarchy: a dot is hidden if `allMuted === true` OR `mutedSet.has(id)`.
 * The render side reads `isMuted(datasetId)` for the combined answer.
 */

export interface MutedDatasetDotsState {
  /** Per-dataset muted IDs. Hidden when `allMuted` is also false. */
  mutedSet: Set<number>
  /** Master switch: when true, all dots are hidden regardless of mutedSet. */
  allMuted: boolean
  /** Combined predicate for render sites. */
  isMuted: (datasetId: number) => boolean
  /** Toggle visibility for a single dataset. */
  toggleMuted: (datasetId: number) => void
  /** Toggle the master switch. Per-dataset state is preserved. */
  toggleAllMuted: () => void
}

function mutedKey(projectId: number): string {
  return `mm-crosswalk-muted-dots-${projectId}`
}

function allMutedKey(projectId: number): string {
  return `mm-crosswalk-all-dots-muted-${projectId}`
}

function readMutedSet(projectId: number): Set<number> {
  if (typeof window === 'undefined') return new Set()
  try {
    const raw = window.localStorage.getItem(mutedKey(projectId))
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((n): n is number => typeof n === 'number'))
  } catch {
    return new Set()
  }
}

function readAllMuted(projectId: number): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(allMutedKey(projectId)) === '1'
  } catch {
    return false
  }
}

export function useMutedDatasetDots(projectId: number): MutedDatasetDotsState {
  const [mutedSet, setMutedSet] = useState<Set<number>>(() => readMutedSet(projectId))
  const [allMuted, setAllMuted] = useState<boolean>(() => readAllMuted(projectId))

  const toggleMuted = useCallback(
    (datasetId: number) => {
      setMutedSet((prev) => {
        const next = new Set(prev)
        if (next.has(datasetId)) next.delete(datasetId)
        else next.add(datasetId)
        try {
          window.localStorage.setItem(
            mutedKey(projectId),
            JSON.stringify(Array.from(next)),
          )
        } catch {
          // privacy mode / quota — silently fall through
        }
        return next
      })
    },
    [projectId],
  )

  const toggleAllMuted = useCallback(() => {
    setAllMuted((prev) => {
      const next = !prev
      try {
        window.localStorage.setItem(allMutedKey(projectId), next ? '1' : '0')
      } catch {
        // ignore
      }
      return next
    })
  }, [projectId])

  const isMuted = useCallback(
    (datasetId: number) => allMuted || mutedSet.has(datasetId),
    [allMuted, mutedSet],
  )

  return { mutedSet, allMuted, isMuted, toggleMuted, toggleAllMuted }
}
