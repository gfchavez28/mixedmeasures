import { ApiError } from './client'

/**
 * The server's own words for a refusal, or null — the ONE reader of
 * `response.data.detail` (#871).
 *
 * FastAPI puts a refusal's reason there in THREE shapes, and this codebase
 * writes all three as guidance:
 *   - a string   — `HTTPException(detail="…")`, the common case
 *   - a list     — a 422 validation error, `[{loc, msg, type}, …]`
 *   - an object  — a structured 409 (`recode.py::bulk_type_update`'s
 *                  `recode_definitions_exist`; equivalence's
 *                  `cross_dataset_unpaired` and the #298 cascade subset)
 *
 * 🔴 **Reading only the string shape is #871.** `useHistory` did exactly that
 * through a second, narrower helper, so changing a variable's type with a rule
 * on it toasted "Action failed" over *"Cannot change type: columns have recode
 * definitions."* — while the SIBLING refusal on the same endpoint, a string
 * 409, displayed fine. One control, one of its two reasons shown.
 *
 * ⚠️ **Returns null rather than a stringified object.** The narrower helper
 * existed because "[object Object]" is worse than a generic fallback — true,
 * and the answer is to read the field the object actually carries, not to
 * discard the object. A shape with nothing sayable yields null and the caller
 * uses its own wording.
 *
 * ⚠️ **Duck-typed on purpose, so it is not gated on `instanceof ApiError`.**
 * Production always throws `ApiError` (`client.ts`), but the callers that need
 * this are testable without constructing one, and a detail is a detail.
 */
export function serverDetailMessage(err: unknown): string | null {
  const detail = (err as { response?: { data?: { detail?: unknown } } } | null)
    ?.response?.data?.detail
  if (typeof detail === 'string') return detail.trim() ? detail : null
  if (Array.isArray(detail)) {
    const msg = (detail[0] as { msg?: string } | undefined)?.msg
    return typeof msg === 'string' && msg.trim() ? msg.replace(/^Value error, /, '') : null
  }
  if (detail && typeof detail === 'object') {
    const message = (detail as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) return message
  }
  return null
}

/**
 * Statuses that are a 4xx and still worth retrying, so they are NOT refusals.
 *
 * - **401** — the session lapsed; `client.ts` clears the CSRF token and reloads,
 *   so the page (and any history stack on it) is about to go anyway.
 * - **403** — in this app that is almost always a stale CSRF token, which the
 *   same reload refreshes.
 * - **408 / 425 / 429** — timeout, too-early, throttled. All transient by
 *   definition.
 */
const RETRYABLE_4XX = new Set([401, 403, 408, 425, 429])

/**
 * Did the SERVER receive this request and refuse it in a way that will not
 * change on a retry? (#874)
 *
 * The distinction a caller needs is *transient vs settled*, and only the status
 * carries it: a network drop or a timeout never reaches the server at all
 * (`fetch` rejects with a `TypeError`/`DOMException`, no `status`), a 5xx is a
 * server fault that may pass next time, and a 4xx outside the set above means
 * the request itself is no longer valid — the row is gone, the type now has a
 * rule on it, the code was never applied.
 *
 * ⚠️ **Duck-typed on `status`, deliberately, exactly like `serverDetailMessage`
 * above.** Production always throws `ApiError` (`client.ts:118`), which sets
 * `status`; gating on `instanceof` would force every test that needs this to
 * construct one, and the property we care about is the number.
 *
 * ⚠️ **An error with no `status` is NOT a refusal**, which is the safe
 * direction: the caller keeps whatever it would have kept, and a retry stays
 * available. Widening this to "any thrown error" would make a flaky network
 * look like a settled decision.
 */
export function isServerRefusal(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status
  if (typeof status !== 'number') return false
  if (status < 400 || status >= 500) return false
  return !RETRYABLE_4XX.has(status)
}

/**
 * Did the CLIENT stop waiting? (#957)
 *
 * `client.ts` bounds every request with `AbortSignal.timeout`, which rejects
 * with a `DOMException` named `TimeoutError` — not an `ApiError`, and with no
 * `status`, because no answer arrived. `AbortError` is the same rejection from a
 * signal aborted by hand.
 *
 * ⚠️ **A timeout is not a failure of the work, and "try again" is the wrong
 * advice** (#820): a retry gets the same budget and stops in the same place,
 * while the server may still be finishing the first attempt.
 *
 * ⚠️ **Duck-typed on `name`, like the two readers above** — callers' tests build
 * a timeout as a plain `Error` with that name. This predicate was FIVE
 * hand-rolled copies before it lived here; `request-timeout-single-source.test.ts`
 * fails the suite on a sixth.
 */
export function isRequestTimeout(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name
  return name === 'TimeoutError' || name === 'AbortError'
}

/**
 * A React Query `retry` for a request whose answer will not change if it is
 * asked again: retry ONCE, and only when no answer arrived (#956/#957).
 *
 * The client-wide default (`main.tsx`) retries every failure once. That is
 * wrong for a heavy read in two directions at once:
 *   - **the server answered** (any `status`) — a 500 from a query that exceeds a
 *     database limit, or a refusal, is deterministic for the same request, so the
 *     retry repeats the full cost for the same result;
 *   - **the client timed out** — the server never stopped; a retry starts a
 *     SECOND computation beside the first (measured for #957: pooled
 *     reliability, 46 s and +780 MB each).
 *
 * What is left is a request that never reached an answer for a reason other
 * than the budget — a dropped connection — which is the case a retry exists for.
 */
export function retryUnanswered(failureCount: number, err: unknown): boolean {
  if (failureCount >= 1) return false
  if (isRequestTimeout(err)) return false
  return typeof (err as { status?: unknown } | null)?.status !== 'number'
}

/**
 * Extract a human-readable error message from an API error.
 *
 * The server's reason when it gave one, else the thrown Error's own message,
 * else `fallback`. ⚠️ That middle rung is why `useHistory` does NOT use this
 * function: a network failure would toast "network down" at a coder. Callers
 * that want *the server's words or nothing* call `serverDetailMessage` and
 * supply their own fallback.
 */
export function extractApiError(err: unknown, fallback = 'Something went wrong'): string {
  if (err instanceof ApiError) {
    const detail = serverDetailMessage(err)
    if (detail) return detail
  }
  if (err instanceof Error && err.message && !err.message.startsWith('Request failed')) {
    return err.message
  }
  return fallback
}
