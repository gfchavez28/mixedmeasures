import { toCsv, UTF8_BOM } from '@/lib/csv'
import { safeFilename } from '@/lib/filename'
import type { CodingImportProblem } from '@/lib/api'

/**
 * What the coding import says about the rows it did not take (Batch 6).
 *
 * Mirrors `backend/app/services/coding_import.py::IMPORT_REASONS`, and
 * `tests/test_coding_import.py` READS this file: a reason the server can emit
 * with no label here fails that suite, and a label for a reason the server no
 * longer emits fails it too.
 */
export const CODING_IMPORT_REASONS = [
  'unit_not_found', 'unit_ambiguous', 'unit_not_codeable',
  'code_not_found', 'code_ambiguous', 'code_inactive',
  'coder_missing', 'coder_skipped',
  'rating_not_a_number', 'rating_outside_scale', 'rating_without_scale',
  'rating_conflict_in_file',
  'set_mismatch', 'set_conflict_in_file', 'duplicate_row',
] as const

export type CodingImportReason = typeof CODING_IMPORT_REASONS[number]

/**
 * The summary line's words for each reason. The summary read the raw slug —
 * "3 × unit not codeable" — which is a variable name, not a sentence; each row's
 * own `detail` stays the full explanation.
 *
 * `satisfies Record<CodingImportReason, …>` so a new reason is a COMPILE error
 * until it has words (the stated-basis family's rule (b)).
 */
export const CODING_IMPORT_REASON_LABEL = {
  unit_not_found: 'no such passage or record',
  unit_ambiguous: 'id names more than one',
  unit_not_codeable: 'not open to coding',
  code_not_found: 'no such code',
  code_ambiguous: 'two codes share the name',
  code_inactive: 'code is inactive',
  coder_missing: 'no coder named',
  coder_skipped: 'coder not imported',
  rating_not_a_number: 'rating is not a number',
  rating_outside_scale: 'rating outside the scale',
  rating_without_scale: 'code has no rating scale',
  rating_conflict_in_file: 'two different ratings',
  set_mismatch: 'different code set',
  set_conflict_in_file: 'two values of one set',
  duplicate_row: 'repeats an earlier row',
} satisfies Record<CodingImportReason, string>

/** A reason's words — a reason from a NEWER server reads as its own slug, never blank. */
export function reasonLabel(reason: string): string {
  return (CODING_IMPORT_REASON_LABEL as Record<string, string>)[reason]
    ?? reason.replace(/_/g, ' ')
}

/**
 * `{reason: n}` as `"no such code (3) · repeats an earlier row (1)"`, largest first.
 *
 * ⚠️ **The count FOLLOWS the label (#1089).** The labels are written to stand
 * alone — the download's *Reason* column prints them with no count — so most of
 * them do not read after a number: the count-first shape rendered *"2 two
 * different ratings"* and *"4 coder not imported"*. Change the shape here, never
 * the labels into phrases that only work after a count.
 */
export function reasonSummary(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, n]) => `${reasonLabel(reason)} (${n.toLocaleString()})`)
    .join(' · ')
}

/**
 * How many problem rows the page renders.
 *
 * 🔴 **A file addressed with the wrong key refuses EVERY row** — up to the
 * 200,000-row cap — and the table rendered all of them, which is #1045's
 * white-window class (a list built in full, in the DOM). The rest are one click
 * away as a file, which is also the more useful form for fixing a spreadsheet.
 */
export const PROBLEM_LIST_LIMIT = 200

/** The problem list as a CSV the researcher can sort beside their own file. */
export function problemsCsv(problems: readonly CodingImportProblem[]): string {
  return UTF8_BOM + toCsv([
    ['Line', 'Reason', 'Why'],
    ...problems.map(p => [String(p.line), reasonLabel(p.reason), p.detail]),
  ])
}

/** The download's name, from the name of the file that was checked. */
export function problemsFilename(sourceName: string | undefined): string {
  const stem = (sourceName ?? '').replace(/\.[^.]+$/, '')
  return `${safeFilename(`${stem || 'codings'} - rows not imported`, { spaces: 'keep' })}.csv`
}
