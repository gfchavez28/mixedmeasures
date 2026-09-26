/**
 * MM-authored file formats — the single client-side source of truth.
 *
 * These are the formats Mixed Measures writes and reads back itself, as opposed
 * to the third-party formats the import ADAPTERS convert (see
 * `dataset-import-formats.ts` / `conversation-import-formats.ts` /
 * `document-import-formats.ts`):
 *
 *   .mmproject — full project export/import/merge (services/project_portability.py)
 *   .mmcodebook — codebook-only exchange
 *   .mmbackup  — database + documents + media ZIP (services/backup.py)
 *
 * `.mmproject` was inlined on BOTH the Dashboard import dialog and the merge
 * page; `.mmbackup` on Settings. Same one-line-away drift shape as #552 — the
 * fact that they agreed was luck, not structure.
 *
 * NOTE the format-VERSION gate is a backend concern and is deliberately not
 * mirrored here: `_read_manifest_and_check_format` refuses a newer
 * `format_version` inside the import itself, precisely because a client-side
 * check can be skipped by scripts and direct API calls (`CURRENT_FORMAT_VERSION`
 * lives in `services/project_portability.py` — read it there, never here). This
 * module is only about which files the picker offers.
 */

/** The `accept` attribute for a project import / merge file input. */
export const MMPROJECT_ACCEPT = '.mmproject'

/** Human-readable name for the merge page's refusal sentence (#1012). */
export const MMPROJECT_FORMAT_LABEL = 'a Mixed Measures project file (.mmproject)'

/**
 * True when a picked/dropped file is a project file (#1012) — so the merge page
 * refuses a wrong file itself, instead of uploading it and reporting that it
 * "could not be read".
 */
export function isSupportedProjectFile(filename: string): boolean {
  return filename.toLowerCase().endsWith('.mmproject')
}

/** The `accept` attribute for a codebook import file input. */
export const MMCODEBOOK_ACCEPT = '.mmcodebook,.qdc'

/** The `accept` attribute for a backup-restore file input. */
export const MMBACKUP_ACCEPT = '.mmbackup'
