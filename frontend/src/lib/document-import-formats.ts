/**
 * Document upload formats — the single client-side source of truth.
 *
 * Mirror of the backend's document seam, `routers/documents.py` (`ALLOWED_EXTENSIONS`
 * + `_format_from_filename`): .docx via python-docx, .pdf via pdfminer.six, .txt
 * plain. A NEW document format is added at that seam AND here — nowhere else.
 *
 * Extracted with #552's sibling rider: the list was inlined THREE times — an
 * `ALLOWED_EXTENSIONS` array in `DocumentImport.tsx`, a SECOND copy as that same
 * page's `accept` string literal, and a third array in `DocumentsListPage.tsx`.
 * They agreed at the time of writing, which is precisely the state the
 * conversation gates were in before one of them silently drifted (#552).
 *
 * New document-upload surfaces MUST import from here.
 */

/** The `accept` attribute for any document file input. */
export const DOCUMENT_ACCEPT = '.docx,.pdf,.txt'

/** Human-readable format list for upload copy. Keep in step with DOCUMENT_ACCEPT. */
export const DOCUMENT_FORMAT_LABEL = 'Word (.docx), PDF, or plain text (.txt)'

const SUPPORTED_EXTENSIONS = /\.(docx|pdf|txt)$/

/** True when a picked/dropped file is one the backend can extract text from. */
export function isSupportedDocumentFile(filename: string): boolean {
  return SUPPORTED_EXTENSIONS.test(filename.toLowerCase())
}
