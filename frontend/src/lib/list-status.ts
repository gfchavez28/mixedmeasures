/**
 * #961 — what a surface may CLAIM about a list it read from a query.
 *
 * Every page here derives its lists as `data?.items ?? []`, which is right for
 * rendering and wrong for speaking: an EMPTY ARRAY is the same value whether the
 * server answered "there are none" or has not answered at all. Measured on a
 * large project (production build): Text Coding said *"No text columns found in
 * this project"* for ~3.4 s, Qualitative Analysis *"No segments or text has been
 * coded yet"* for ~5.7 s, and the codebook panel *"No codes yet. Add your first
 * code below."* with the new-code box ready — and nothing refused a second code
 * of the same name, because every duplicate check read the same empty array.
 * A request that FAILED made the same claims, permanently.
 *
 * So the question "is this list known?" is asked of the QUERY, never of the
 * array, and it has three answers:
 *
 *   - `ready`   — the server answered; an empty list is a fact and may be said.
 *   - `loading` — no answer yet; say that it is loading, and offer no act that
 *                 depends on the list (creating a code is the one that bites).
 *   - `failed`  — no answer and none coming; say the LOAD failed, which is a
 *                 statement about the request, never about the project.
 *
 * ⚠️ **Decided on `data`, not on `status`.** A refetch that fails while a
 * previous answer is cached reports `isError` with real data in hand; that list
 * is known (if possibly stale) and must not be replaced by a failure notice.
 * React Query v5 never resolves a successful query to `undefined`, so
 * `data !== undefined` is exactly "an answer is in hand".
 *
 * ⚠️ **A DISABLED query with nothing cached reads `loading` forever.** Only ask
 * this of a query that is enabled, or decide the disabled case first (Text
 * Coding's texts query is disabled until a column is selected, and the page
 * says "select a column" before it ever asks).
 */

import { isRequestTimeout, isServerRefusal, serverDetailMessage } from '@/lib/api/error-utils'

export type ListStatus = 'loading' | 'failed' | 'ready'

/** The slice of a React Query result this decision reads. */
export interface ListQueryLike {
  data: unknown
  isError: boolean
}

export function listStatus(query: ListQueryLike): ListStatus {
  if (query.data !== undefined) return 'ready'
  return query.isError ? 'failed' : 'loading'
}

/**
 * A claim that rests on SEVERAL lists is only as known as the least-known one.
 * A failure outranks a wait: once any list has failed the claim cannot be made
 * by waiting, and the Retry offered with the failure refetches only the lists
 * that have no answer.
 */
export function combineListStatus(statuses: readonly ListStatus[]): ListStatus {
  if (statuses.includes('failed')) return 'failed'
  if (statuses.includes('loading')) return 'loading'
  return 'ready'
}

/**
 * Why a load failed, in words that are true of the REQUEST: a timeout is not a
 * server fault, a refusal carries the server's own guidance, and anything else
 * says nothing about the project — whose data is exactly as it was.
 */
export function loadFailureReason(error: unknown): string {
  if (isRequestTimeout(error)) {
    return 'The server took too long to answer — on a large project it may still be busy.'
  }
  // A refusal's detail is the server's guidance; a 5xx body is an exception
  // string or "Internal Server Error", which says nothing (#957).
  const refusal = isServerRefusal(error) ? serverDetailMessage(error) : null
  return refusal ?? 'Something went wrong while loading.'
}

/**
 * Everything a surface needs to render a list's non-ready states: the status,
 * the error behind a failure (for the timeout / refusal wording), and a retry
 * that keeps its own "retrying" state so the failure notice — and the focused
 * Retry button in it — stays mounted while the request runs again.
 * Built by `hooks/useListLoad`.
 */
export interface ListLoad {
  status: ListStatus
  error: unknown
  retry: () => void
  retrying: boolean
}
