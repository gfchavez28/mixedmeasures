import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { authApi, type Coder } from '@/lib/api'

export interface CoderContext {
  coders: Coder[]
  /** user_id → Coder. Stable identity across renders (safe to pass to memoized rows). */
  coderMap: Map<number, Coder>
  /** ≥2 roster coders → surface attribution badges + the per-coder visibility filter. */
  multiCoder: boolean
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
  const { data } = useQuery({
    queryKey: ['coders'],
    queryFn: () => authApi.listCoders(),
    staleTime: 60_000,
  })
  return useMemo(() => {
    const coders = data ?? []
    return {
      coders,
      coderMap: new Map(coders.map(c => [c.id, c])),
      multiCoder: coders.length > 1,
    }
  }, [data])
}
