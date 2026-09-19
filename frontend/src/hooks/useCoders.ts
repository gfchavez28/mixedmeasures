import { useMemo } from 'react'
import { useQuery, type QueryClient, type UseQueryResult } from '@tanstack/react-query'
import { authApi, type Coder } from '@/lib/api'
import { listStatus, type ListStatus } from '@/lib/list-status'

export const CODERS_QUERY_KEY = ['coders'] as const

export interface CoderContext {
  coders: Coder[]
  /** user_id → Coder. Stable identity across renders (safe to pass to memoized rows). */
  coderMap: Map<number, Coder>
  /** ≥2 roster coders → surface attribution badges + the per-coder visibility filter. */
  multiCoder: boolean
  /**
   * #964 — has the roster ANSWERED? `coders` is `[]` both before the server
   * answers and after the request fails, and an empty roster reads as a
   * one-person one: `multiCoder` false, so blind mode off. Anything whose
   * correctness depends on WHO the other coders are asks this, never `coders`.
   */
  status: ListStatus
  /** The roster query itself — for a page gate's `useListLoad` (its Retry). */
  query: UseQueryResult<Coder[]>
}

/**
 * Shared coder-roster lens (Track J · J1). Reuses the instance-global ['coders']
 * query (also driven by the TopRail switcher). The returned `coderMap` is memoized
 * on the query data so passing it into React.memo'd rows (SegmentRow) doesn't bust
 * their comparator every render.
 *
 * `multiCoder` gates all attribution UI: a single-researcher project (the default)
 * sees zero change — no badges, no filter — so the chrome only appears once a
 * second coder exists.
 */
export function useCoders(): CoderContext {
  const query = useQuery({
    queryKey: CODERS_QUERY_KEY,
    queryFn: () => authApi.listCoders(),
    staleTime: 60_000,
  })
  const { data } = query
  const roster = useMemo(() => {
    const coders = data ?? []
    return {
      coders,
      coderMap: new Map(coders.map(c => [c.id, c])),
      multiCoder: coders.length > 1,
    }
  }, [data])
  return { ...roster, status: listStatus(query), query }
}

/**
 * #964 — call after anything that may have ADDED coders to this install (a
 * project import creates the file's coders; a merge can create them too).
 *
 * RESET, not invalidate: an invalidated query keeps serving the old roster as
 * an answer until the refetch lands, and a stale one-coder roster turns blind
 * mode off. Measured: importing a colleague's project and opening a
 * conversation showed 8 of their chips with no blind toggle, still there a
 * minute later, because nothing refetched the roster while the page stayed
 * open. A reset makes the roster honestly unknown, which the blind lens treats
 * as blind. Prefix-matched, so Settings' `['coders', 'all']` resets too.
 */
export function resetCoderRoster(queryClient: QueryClient): Promise<void> {
  return queryClient.resetQueries({ queryKey: CODERS_QUERY_KEY })
}
