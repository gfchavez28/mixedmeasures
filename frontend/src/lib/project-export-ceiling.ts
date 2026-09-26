/**
 * The ONE place a project's share-ceiling figure becomes a sentence (#974).
 *
 * ## What this is about
 *
 * `MAX_PROJECT_EXPORT_VALUES` bounds the stored dataset values in one project.
 * Crossing it blocks three things — exporting a copy, Duplicate, and the safety
 * snapshot taken before a colleague's merge, which aborts the merge if it cannot
 * be written. **Before this, `assert_project_exportable` had exactly one caller,
 * inside the export itself, so the only signal was the refusal.** MEASURED
 * 2026-09-20: the developer's GSS project sits at 90.8%, four computed variables
 * from losing all three, with nothing on any screen saying so.
 *
 * ## Why a shared module rather than two call sites
 *
 * Two surfaces show this (the Overview and the export dialog) and a third may
 * later. A threshold duplicated across them drifts, and then one screen calls a
 * project "nearing the limit" while the other calls it fine.
 *
 * 🔴 **The threshold is the SERVER's** (`warn_fraction` on the payload, from
 * `PROJECT_EXPORT_WARN_FRACTION` beside the limit it is a fraction of). It is not
 * redeclared here — a second copy is the drift this module exists to prevent, and
 * the limit is already server-sent for the same reason.
 *
 * ⚠️ **`dataset_values` is the GATE's quantity, not the archive's true size.** The
 * export also streams `dataset_rows` and `row_scores` (455,102 on the developer's
 * install, 12.5% on top of GSS) and the gate counts neither. Mirroring the gate is
 * deliberate: a disclosure counting MORE than the gate would predict a refusal
 * that never comes. Whether the gate should count them is #974's other half.
 */

import type { ProjectExportCeiling } from './api'

export type CeilingLevel = 'fine' | 'nearing' | 'over'

export interface CeilingDisclosure {
  level: CeilingLevel
  /** Always present: the figure itself, e.g. "3,633,552 of 4,000,000 values (91%)". */
  figure: string
  /** Only for 'nearing'/'over' — what crossing costs. Empty at 'fine'. */
  consequence: string
}

/**
 * Whether the figure is worth rendering at all.
 *
 * 🔴 **Not `storage.media_bytes > 0 || documents_bytes > 0`, which is the Overview's
 * EXISTING size line — and that condition is why this needed its own.** MEASURED:
 * the two projects nearest the ceiling (GSS, BES) have zero conversations and zero
 * documents and no media directory on disk, so that line does not render for them
 * at all. Attaching this to it would have left silent exactly the projects that
 * need it.
 *
 * A project with no dataset values is not near a limit on dataset values, and
 * "0 of 4,000,000" is noise on every qualitative-only project in the app.
 */
export function hasCeilingToReport(c: ProjectExportCeiling | undefined): c is ProjectExportCeiling {
  return !!c && c.limit > 0 && c.dataset_values > 0
}

export function ceilingLevel(c: ProjectExportCeiling): CeilingLevel {
  if (c.dataset_values > c.limit) return 'over'
  if (c.dataset_values >= c.limit * c.warn_fraction) return 'nearing'
  return 'fine'
}

/**
 * The sentence, in the register of the Overview's neighbouring "On disk:" line.
 *
 * ⚠️ The percentage is FLOORED, never rounded: at 3,999,999 of 4,000,000 a rounded
 * figure reads "100%" beside a project that can still be shared, which is the
 * refusal's own claim made false one value early.
 *
 * ⚠️ **And a non-empty project never reads "(0%)"** — found by DRIVING it, not by
 * a test: a real 1,646-value project rendered *"1,646 of 4,000,000 values (0%)"*,
 * where the zero looks like a computation that failed rather than a project that
 * is small. Flooring is right at the top of the range and wrong at the bottom, so
 * the bottom says "<1%".
 */
export function describeCeiling(c: ProjectExportCeiling): CeilingDisclosure {
  const level = ceilingLevel(c)
  const pct = Math.floor((c.dataset_values / c.limit) * 100)
  const share = pct < 1 && c.dataset_values > 0 ? '<1%' : `${pct}%`
  const figure =
    `${c.dataset_values.toLocaleString()} of ${c.limit.toLocaleString()} values (${share})`

  if (level === 'over') {
    return {
      level,
      figure,
      consequence:
        'over the limit — sharing a copy, Duplicate, and merging a colleague’s ' +
        'coding are blocked until this project holds fewer records or variables.',
    }
  }
  if (level === 'nearing') {
    return {
      level,
      figure,
      consequence:
        'nearing the limit for sharing a copy, Duplicate, and merging a ' +
        'colleague’s coding.',
    }
  }
  return { level, figure, consequence: '' }
}
