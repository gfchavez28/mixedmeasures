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
 * check can be skipped by scripts and direct API calls (CURRENT_FORMAT_VERSION
 * is 2 as of #414). This module is only about which files the picker offers.
 */

/** The `accept` attribute for a project import / merge file input. */
export const MMPROJECT_ACCEPT = '.mmproject'

/** The `accept` attribute for a codebook import file input. */
export const MMCODEBOOK_ACCEPT = '.mmcodebook,.qdc'

/** The `accept` attribute for a backup-restore file input. */
export const MMBACKUP_ACCEPT = '.mmbackup'
