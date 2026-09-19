import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { combineListStatus, listStatus, type ListLoad, type ListQueryLike } from '@/lib/list-status'

/** The slice of a React Query result `useListLoad` reads. */
export interface ListLoadQuery extends ListQueryLike {
  error: unknown
  refetch: () => Promise<unknown>
}

/**
 * #961 — one `ListLoad` for the lists a claim rests on.
 *
 * `retry` refetches ONLY the lists with no answer (a list already in hand is
 * not asked again), and `retrying` stays true until every one of those requests
 * has settled. That is what lets a failure notice stay on screen through the
 * retry: with nothing cached, React Query v5 resets an errored query to
 * `pending` the moment it refetches (measured under #957), so a surface that
 * rendered from `status` alone would swap the notice for a loading line and
 * unmount the Retry button under the keyboard user who pressed it.
 *
 * ⚠️ The retry state is a counter of in-flight retries, not a boolean, so a
 * second press while the first is still running cannot clear `retrying` early.
 */
export function useListLoad(...queries: ListLoadQuery[]): ListLoad {
  const [inFlight, setInFlight] = useState(0)

  // Read the latest queries at press time — the result objects are rebuilt on
  // every render, and a stale closure would refetch nothing or the wrong list.
  // Written after commit, never during render.
  const queriesRef = useRef(queries)
  useLayoutEffect(() => { queriesRef.current = queries })

  const statuses = queries.map(listStatus)
  const status = combineListStatus(statuses)
  const error = queries.find(q => q.data === undefined && q.isError)?.error ?? null

  const retry = useCallback(() => {
    const unanswered = queriesRef.current.filter(q => q.data === undefined)
    if (unanswered.length === 0) return
    setInFlight(n => n + 1)
    void Promise.allSettled(unanswered.map(q => q.refetch()))
      .finally(() => setInFlight(n => Math.max(0, n - 1)))
  }, [])

  return useMemo(
    () => ({ status, error, retry, retrying: inFlight > 0 }),
    [status, error, retry, inFlight],
  )
}
