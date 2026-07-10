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
 */

/** The `accept` attribute for any dataset file input. */
export const DATASET_ACCEPT = '.csv,.xlsx,.sav'

/** Human-readable format list for upload copy. Keep in step with DATASET_ACCEPT. */
export const DATASET_FORMAT_LABEL = 'CSV, Excel (.xlsx), or SPSS (.sav)'

const SUPPORTED_EXTENSIONS = /\.(csv|xlsx|sav)$/

/** True when a picked/dropped file is one the backend can adapt into CSV. */
export function isSupportedDatasetFile(filename: string): boolean {
  return SUPPORTED_EXTENSIONS.test(filename.toLowerCase())
}
