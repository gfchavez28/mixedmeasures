/**
 * Coding-import formats — the single client-side source of truth (queue row 49).
 *
 * A separate module from `dataset-import-formats.ts` although both accept CSV,
 * and the reason is #552's own: a module pairs an `accept` attribute with a
 * human label and a predicate, and these two families answer to DIFFERENT backend
 * seams. The dataset path adapts `.xlsx` and `.sav` at
 * `routers/dataset.py::_upload_to_csv_text`; a coding import is read by
 * `services/coding_import.py::parse_rows`, which takes CSV and nothing else.
 * Sharing the constant would mean a researcher could drop a workbook into a zone
 * whose server answers "this file is not readable as text".
 *
 * New coding-import surfaces MUST import from here — `lib/import-formats.test.ts`
 * fails the suite for a literal `accept="…"` or a hand-rolled extension test in
 * any page.
 */

/** The `accept` attribute for a coding-import file input. */
export const CODING_IMPORT_ACCEPT = '.csv'

/** Human-readable format list for the drop zone's copy. */
export const CODING_IMPORT_FORMAT_LABEL = 'CSV (.csv)'

const SUPPORTED_EXTENSIONS = /\.csv$/

/** True when a picked/dropped file is one the coding importer can read. */
export function isSupportedCodingImportFile(filename: string): boolean {
  return SUPPORTED_EXTENSIONS.test(filename.toLowerCase())
}

/**
 * The header row a file needs, in order.
 *
 * ⚠️ Shown in the drop zone so the shape is visible BEFORE an upload fails, and
 * kept here rather than in the page so the copy and the accept list move
 * together — the #552 rider ("copy moves with the gate": an empty state that
 * names one format while the filter takes three just relocates the lie).
 */
export const CODING_IMPORT_REQUIRED_HEADERS = ['unit_id', 'coder', 'code'] as const
export const CODING_IMPORT_OPTIONAL_HEADERS = ['code_set', 'magnitude'] as const

/**
 * Another name a header may go by → the header it is read as — the parser's
 * `HEADER_ALIASES`. `rating` is what the coded-segments export writes (#1032 c),
 * which is why that file imports as it is; the drop zone says so.
 */
export const CODING_IMPORT_HEADER_ALIASES = { rating: 'magnitude' } as const
