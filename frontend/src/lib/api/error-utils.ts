import { ApiError } from './client'

/**
 * Extract a human-readable error message from an API error.
 * Handles both FastAPI HTTPException (detail: string) and
 * Pydantic validation errors (detail: [{loc, msg, type}, ...]).
 */
export function extractApiError(err: unknown, fallback = 'Something went wrong'): string {
  if (err instanceof ApiError) {
    const data = err.response.data as Record<string, unknown> | undefined
    const detail = data?.detail
    if (typeof detail === 'string') return detail
    if (Array.isArray(detail) && detail.length > 0) {
      const msg = (detail[0] as { msg?: string })?.msg
      if (typeof msg === 'string') return msg.replace(/^Value error, /, '')
      return String(detail[0])
    }
    // Structured 409 detail (e.g. cross_dataset_unpaired from
    // routers/equivalence.py + the #298 cascade subset). The detail is
    // a dict like { error: "...", message: "...", ... }; surface the
    // message so the user gets the actionable text instead of the fallback.
    if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
      const message = (detail as { message?: unknown }).message
      if (typeof message === 'string' && message) return message
    }
  }
  if (err instanceof Error && err.message && !err.message.startsWith('Request failed')) {
    return err.message
  }
  return fallback
}
