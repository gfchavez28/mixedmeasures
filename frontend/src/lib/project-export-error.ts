import { toast } from 'sonner'
import { ApiError } from './api/client'

/**
 * The reason a `.mmproject` export or duplicate failed, and how to show it.
 *
 * **Why this exists (#842, found by driving 2026-08-27).** The backend gained a
 * bounded refusal that names the limit, says backups are unaffected, and says what
 * to do — and **all four call sites threw it away**: three bare
 * `catch { toast.error('Export failed') }` and one
 * `onError: () => toast.error('Could not duplicate project')`. The researcher would
 * have met the same unexplained failure as before, with more work behind it. That is
 * #820's defect one layer up, where a SUCCESSFUL 85.6 s response was discarded
 * behind `alert("R Data Export failed.")`.
 *
 * ⚠️ **The refusal is ~380 characters — four times the longest plain toast in this
 * app — so it is a TWO-PART toast, not a one-liner.** Title = what failed (the
 * client's own words, since it knows which operation it invoked); description = the
 * server's reason, verbatim, because it is the authority on why. That is the shape
 * `DROPPED_RECORDING_TITLE`/`_DETAIL` already uses. The `Toaster` sets no `duration`,
 * so sonner's 4 s default applies — far too short to read a paragraph, hence the
 * explicit dwell whenever there is a description to read.
 *
 * ⚠️ **Report the reason you have; never substitute a guess** — the rule
 * `describeDatasetUploadError` was written for, applied to the other direction of the
 * same file format.
 */
export interface ProjectExportFailure {
  title: string
  description?: string
  /** ms; only set when there is a description long enough to need reading time. */
  duration?: number
}

/** How long a paragraph-length refusal stays on screen. */
export const LONG_TOAST_MS = 12_000

export function describeProjectExportError(
  err: unknown,
  fallbackTitle: string,
): ProjectExportFailure {
  const withDetail = (detail: string): ProjectExportFailure =>
    detail
      ? { title: fallbackTitle, description: detail, duration: LONG_TOAST_MS }
      : { title: fallbackTitle }

  if (err instanceof ApiError) {
    const raw = typeof err.message === 'string' ? err.message : ''
    // ApiError.message falls back to "Request failed with status N" when the
    // response carried no `detail` — treat that placeholder as "no detail",
    // because showing it to a researcher is worse than showing the fallback.
    const detail = /^request failed with status/i.test(raw) ? '' : raw
    switch (err.status) {
      case 401:
        return { title: 'Your session expired', description: 'Reload the page and try again.' }
      case 404:
        return { title: 'That project no longer exists' }
      default:
        // The size refusal is a 400 and its `detail` IS the explanation.
        return withDetail(detail)
    }
  }
  const name = (err as { name?: string } | null)?.name
  if (name === 'TimeoutError' || name === 'AbortError') {
    return {
      title: fallbackTitle,
      // Deliberately does NOT say "try again": the budget is fixed, so a retry gets
      // the same one. A very large project simply takes longer than the client waits.
      description: 'The export ran longer than the app waits for it. Very large projects can exceed that budget.',
      duration: LONG_TOAST_MS,
    }
  }
  return { title: fallbackTitle }
}

/** Show the failure. One call so no site has to remember the dwell. */
export function toastProjectExportError(err: unknown, fallbackTitle: string): void {
  const { title, description, duration } = describeProjectExportError(err, fallbackTitle)
  toast.error(title, description ? { description, duration } : undefined)
}
