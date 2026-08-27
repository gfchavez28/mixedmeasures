/**
 * Dataset upload formats — the single client-side source of truth.
 *
 * Mirror of the backend's format seam, `routers/dataset.py::_upload_to_csv_text`:
 * CSV takes the text path, `.xlsx` converts via openpyxl (#523), `.sav` via
 * pyreadstat (#28). A NEW format is added at that seam AND here — nowhere else.
 *
 * This exists because the gates had already drifted: the dropzone `accept`, the
 * append page's `accept`, and a `handleFilesSelected` regex each re-inlined the
 * extension list, so a backend format the client silently refused to upload was
 * a one-line-away bug. New dataset-upload surfaces MUST import from here.
 *
 * Since #796 this module also owns the upload TIMEOUT and the failure MESSAGE,
 * for the same single-source reason — the four upload calls had no timeout at
 * all, so a valid 11 MB workbook was aborted mid-preview and reported as a
 * malformed file.
 */

import { ApiError } from './api/client'

/** The `accept` attribute for any dataset file input. */
export const DATASET_ACCEPT = '.csv,.xlsx,.sav'

/** Human-readable format list for upload copy. Keep in step with DATASET_ACCEPT. */
export const DATASET_FORMAT_LABEL = 'CSV, Excel (.xlsx), or SPSS (.sav)'

const SUPPORTED_EXTENSIONS = /\.(csv|xlsx|sav)$/

/** True when a picked/dropped file is one the backend can adapt into CSV. */
export function isSupportedDatasetFile(filename: string): boolean {
  return SUPPORTED_EXTENSIONS.test(filename.toLowerCase())
}

/**
 * 50 MB — mirrors backend `routers/helpers.py::MAX_UPLOAD_SIZE`, which
 * `_upload_to_csv_text` applies to every dataset upload via
 * `read_upload_with_limit`. Update both together.
 */
export const MAX_DATASET_UPLOAD_SIZE = 50 * 1024 * 1024

/**
 * Per-upload timeout (ms) for the four dataset upload endpoints (#796).
 *
 * ⚠️ **This is PROCESSING-bound, not transfer-bound — the opposite of
 * `mediaUploadTimeoutMs`.** A recording is big and streams through untouched;
 * a dataset is small and is *parsed cell by cell, then written row by row*.
 *
 * 🔴 **Recalibrated 2026-08-23 (#796b) after the first version shipped too
 * small and the developer's import timed out.** The original floor was derived
 * from the PREVIEW measurement (33s) and extrapolated to import — which was
 * wrong, because preview only READS the cells while import WRITES 3.1M rows.
 * Measured on `GSS_with_union.xlsx` (11,066,857 bytes, 75,699 x 41):
 *
 * | request | measured |
 * |---|---|
 * | preview  | 24.0s convert + 9.8s infer  = **33.8s** |
 * | import   | 24.0s convert + 76.4s write = **100.4s** (was 398.8s before the write path was batched) |
 *
 * So the budget is set from the IMPORT path — the slowest of the four — at its
 * observed ~110 KB/s of input, divided by 3 for a slower machine than this one
 * (the 2 GB VPS this targets): **35,000 B/s**. That gives this file 347s against
 * a measured 100.4s. **Never calibrate this on the preview number again.**
 *
 * Bounded to [2 min, the max-size estimate]. The upper bound is DERIVED from
 * `MAX_DATASET_UPLOAD_SIZE` rather than a fixed constant, per #544: a fixed cap
 * that sits below what an in-limit file legitimately needs aborts it when it is
 * nearly done, which is the same defect one layer up.
 *
 * A flat generous timeout (the `backup.ts` / `project-portability.ts` shape)
 * was considered and rejected: it would give a stalled 5 KB CSV the same
 * ceiling it gives a 50 MB workbook.
 */
export function datasetUploadTimeoutMs(fileSizeBytes: number): number {
  const FLOOR_BYTES_PER_SEC = 35_000
  const estimateFor = (bytes: number) =>
    Math.ceil(bytes / FLOOR_BYTES_PER_SEC) * 1000 + 30_000
  return Math.min(
    estimateFor(MAX_DATASET_UPLOAD_SIZE),
    Math.max(120_000, estimateFor(fileSizeBytes)),
  )
}

/**
 * Roughly how long this file will take server-side, in seconds — used ONLY to
 * set the researcher's expectation and to pace the progress fill, never to
 * bound a request (that is `datasetUploadTimeoutMs`).
 *
 * ⚠️ **Phase-aware, because the two phases differ by 3x.** Preview reads the
 * cells; import also WRITES ~3.1M rows. Quoting the preview number for an
 * import is what left the developer watching an "Importing..." button for far
 * longer than promised. Rates are the OBSERVED ones from the measurement in
 * `datasetUploadTimeoutMs` (not the pessimistic floor), so the hint reflects a
 * normal machine rather than the worst case.
 */
export function estimatedProcessingSeconds(
  fileSizeBytes: number,
  phase: 'preview' | 'import' = 'preview',
): number {
  const RATE = phase === 'import' ? 110_000 : 334_000
  return Math.max(1, Math.ceil(fileSizeBytes / RATE))
}

/** Files past this take long enough that silence reads as a hang (#796 UX half). */
export const SLOW_UPLOAD_THRESHOLD_BYTES = 2 * 1024 * 1024

/**
 * Turn a caught dataset-upload error into a plain, actionable message (#797).
 *
 * The sibling of `media-constants.ts::describeMediaUploadError`, and it exists
 * for the same reason: the backend sends a usable `detail` for the cases it can
 * name (400 unparseable / undecodable / bad workbook, 413 over the cap), while a
 * timeout or a network reject is not an `ApiError` at all and has to be matched
 * by shape.
 *
 * ⚠️ **The timeout arm is the point.** Before #796 the wizard replaced every
 * failure with "Please check your CSV files" — a diagnosis it had not
 * established, and a wrong one: the file was valid and the client had aborted
 * its own request. **Report the reason you have; never substitute a guess.**
 */
export function describeDatasetUploadError(err: unknown): string {
  const FALLBACK = `The file couldn’t be read. Accepted formats: ${DATASET_FORMAT_LABEL}.`
  if (err instanceof ApiError) {
    const raw = typeof err.message === 'string' ? err.message : ''
    // ApiError.message falls back to "Request failed with status N" when the
    // response carried no `detail` — treat that placeholder as "no detail".
    const detail = /^request failed with status/i.test(raw) ? '' : raw
    const status = err.status
    switch (status) {
      case 413:
        return detail || `This file is over the ${MAX_DATASET_UPLOAD_SIZE / (1024 * 1024)} MB limit.`
      case 400:
        return detail || FALLBACK
      case 401:
        return 'Your session expired — reload the page and try the import again.'
      case 404:
        return 'That project no longer exists.'
      default:
        return detail || FALLBACK
    }
  }
  const name = (err as { name?: string } | null)?.name
  if (name === 'TimeoutError' || name === 'AbortError') {
    // Deliberately does NOT say "try again" — the timeout is derived from the
    // file's size, so a retry gets exactly the same budget and the same result.
    // Saying otherwise would send the researcher round a loop that cannot work.
    // ⚠️ This used to end "Importing fewer files at once may help" — useless,
    // and faintly insulting, when the researcher has selected exactly one file.
    // Advice that cannot apply to the situation in front of the user is worse
    // than no advice. #796b both made the import ~5x faster and raised the
    // budget, so the honest remaining message is that this one is exceptional.
    return 'Timed out waiting for the server. Nothing is wrong with the file — it is simply larger than this import can handle in the time allowed. Splitting it into fewer rows or columns is the reliable way through.'
  }
  const msg = err instanceof Error ? err.message : ''
  if (/network|failed to fetch|load failed/i.test(msg)) {
    return 'The upload was interrupted (connection lost). Check your connection and try again.'
  }
  return msg || FALLBACK
}
