import { useCallback, useLayoutEffect, useRef } from 'react'
import { useSearchParams } from 'react-router'

type SearchParamsUpdate = URLSearchParams | ((prev: URLSearchParams) => URLSearchParams)

/** The setter this hook returns — `SetURLSearchParams`'s shape, narrowed to the
 *  two forms the app uses (a functional update, or the params themselves). */
export type ComposableSetSearchParams = (
  update: SearchParamsUpdate,
  options?: { replace?: boolean },
) => void

/**
 * #1129 — `useSearchParams`, except that two writes in one tick both land.
 *
 * React Router hands a functional `setSearchParams(prev => …)` the params of the
 * last RENDER, not the result of the write before it (react-router 8.3.0:
 * `nextInit(new URLSearchParams(searchParams))`), so N writes made before the
 * next render each start from the same URL and only the LAST one survives.
 * `useQualitativeAnalysis` exposes ~25 setters built that way, and the Content
 * tab's auto-select calls five of them in one effect run: the codes,
 * conversations and documents were dropped and the tab showed observation clips
 * alone. Deleting the active material cleared `material` and then `element`, and
 * the second write put the deleted material back.
 *
 * Here a write made before the next render starts from the PREVIOUS WRITE's
 * result; once a render shows the new URL, writes start from it again. Both are
 * read from refs, so a setter captured by an older render — a toast's *Undo*, say
 * (#1147) — still starts from the URL as it is NOW.
 *
 * ⚠️ **The setter's identity is NOT stable** (#1147 c; this said it was): its deps
 * are `[setSearchParams]`, and React Router's own changes with every URL change
 * (`[navigate, searchParams]`). An effect that lists it re-runs on every URL
 * change — which is why such an effect must write only when it has something to
 * change (#1146).
 */
export function useComposableSearchParams(): [URLSearchParams, ComposableSetSearchParams] {
  const [searchParams, setSearchParams] = useSearchParams()
  const rendered = useRef(searchParams)
  const pending = useRef<URLSearchParams | null>(null)

  // A render carrying a new URL means every write so far has landed in it.
  useLayoutEffect(() => {
    rendered.current = searchParams
    pending.current = null
  }, [searchParams])

  const compose = useCallback<ComposableSetSearchParams>((update, options) => {
    const base = new URLSearchParams(pending.current ?? rendered.current)
    const next = typeof update === 'function' ? update(base) : update
    pending.current = next
    setSearchParams(next, options)
  }, [setSearchParams])

  return [searchParams, compose]
}
