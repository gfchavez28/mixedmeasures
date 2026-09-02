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
