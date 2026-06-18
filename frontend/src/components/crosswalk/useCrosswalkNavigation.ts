/**
 * useCrosswalkNavigation — reads `?focusRowId` / `?focusDomainId` URL params
 * on mount and scrolls the target into view with a 1.5s fade highlight, plus
 * persists the crosswalk's search state to sessionStorage so returning from
 * an AnalysisView metric restores where the researcher was.
 *
 * Session storage schema:
 *   crosswalk:{projectId}:search  → string (the search query)
 *   crosswalk:{projectId}:scrollY → string (serialized number)
 *
 * URL-synced state (datasets toggles) is NOT stored here — it's already
 * handled by useDatasetToggles via `?datasets=`. Storing it in two places
 * creates sync bugs (plan 3b.9c mitigation).
 *
 * Stale focus IDs are logged and ignored — we don't throw, don't scroll,
 * and don't reset state.
 */

import { useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { parseFocusRow } from './navigation'

interface UseCrosswalkNavigationOptions {
  projectId: number
  searchQuery: string
  setSearchQuery: (q: string) => void
}

function storageKey(pid: number, field: 'search' | 'scrollY'): string {
  return `crosswalk:${pid}:${field}`
}

export function useCrosswalkNavigation({
  projectId,
  searchQuery,
  setSearchQuery,
}: UseCrosswalkNavigationOptions) {
  const [searchParams] = useSearchParams()
  const mountedRef = useRef(false)

  // On mount: restore search from sessionStorage (URL wins if set); scroll
  // to focusRowId / focusDomainId (both are equivalence_group_id for rows,
  // domain_id for brackets) with fade highlight.
  useEffect(() => {
    if (mountedRef.current) return
    mountedRef.current = true
    // Restore search first — but only if the URL doesn't explicitly carry one.
    try {
      const savedSearch = sessionStorage.getItem(storageKey(projectId, 'search'))
      if (savedSearch && !searchQuery) {
        setSearchQuery(savedSearch)
      }
    } catch {
      // sessionStorage can throw in privacy modes; ignore silently.
    }

    // Tagged-form `?focusRow=eg:N|col:N` (Phase 4.9). Falls through to the
    // legacy `?focusRowId=N` (treated as `eg:N`) with a console.warn so any
    // remaining bookmarks keep working until they refresh.
    const focusRowParam = searchParams.get('focusRow')
    const parsed = parseFocusRow(focusRowParam)
    const legacyFocusRowId = searchParams.get('focusRowId')
    const focusDomainId = searchParams.get('focusDomainId')

    let resolved: { kind: 'eg' | 'col'; id: number } | null = parsed
    if (!resolved && legacyFocusRowId) {
      const id = Number(legacyFocusRowId)
      if (Number.isFinite(id) && id > 0) {
        console.warn(
          '[crosswalk] ?focusRowId= is deprecated — use ?focusRow=eg:N or col:N',
        )
        resolved = { kind: 'eg', id }
      }
    }

    if (resolved) {
      const testId =
        resolved.kind === 'eg'
          ? `crosswalk-row-eg-${resolved.id}`
          : `crosswalk-row-col-${resolved.id}`
      applyFocus(testId)
    } else if (focusDomainId) {
      applyFocus(`crosswalk-bracket-${focusDomainId}`)
    }

    // Restore scroll position if we have one and no focus target took
    // precedence above.
    if (!resolved && !focusDomainId) {
      try {
        const savedY = sessionStorage.getItem(storageKey(projectId, 'scrollY'))
        if (savedY) {
          const y = Number(savedY)
          if (Number.isFinite(y) && y > 0) {
            window.scrollTo({ top: y, behavior: 'instant' as ScrollBehavior })
          }
        }
      } catch {
        // ignore
      }
    }

    return () => {
      // On unmount, persist search + scroll.
      try {
        if (searchQuery) sessionStorage.setItem(storageKey(projectId, 'search'), searchQuery)
        else sessionStorage.removeItem(storageKey(projectId, 'search'))
        sessionStorage.setItem(storageKey(projectId, 'scrollY'), String(window.scrollY))
      } catch {
        // ignore
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}

function applyFocus(testId: string) {
  // Defer one tick so the element has mounted.
  setTimeout(() => {
    const el = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
    if (!el) {
      console.warn(`[crosswalk] Stale focus target: ${testId} not found`)
      return
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('crosswalk-focus-highlight')
    setTimeout(() => el.classList.remove('crosswalk-focus-highlight'), 1500)
  }, 50)
}
