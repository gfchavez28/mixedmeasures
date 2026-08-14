/**
 * User-facing copy for the value-labels / declared-missing dialog.
 *
 * Split out of `ValueLabelsDialog.tsx` so the component file exports only a
 * component (react-refresh), and because this is the project's existing shape
 * for copy that must not be re-typed at a second call site — the
 * `lib/source-kind-copy.ts` pattern.
 */
import { countLabel } from '@/lib/format'

/**
 * Toast copy for values that became data again without a recoverable code
 * (#609d): capped at 5 + "+N more" (the AppendImport convention), count-aware
 * verb — the old string was unbounded and read "…values became data again but
 * has no code yet".
 */
// Pure copy helper, unit-tested. (This carried an eslint-disable for
// react-refresh while it lived in the component file; the reason is still true,
// the directive no longer applies here — #727's convert-don't-delete rule.)
export function describeRecoveredUnmapped(values: string[]): string {
  const shown = values.slice(0, 5).map(v => `"${v}"`).join(', ')
  const more = values.length > 5 ? ` +${values.length - 5} more` : ''
  return values.length === 1
    ? `${shown} became data again but has no code yet.`
    : `${shown}${more} became data again but have no codes yet.`
}

/**
 * What declaring (or un-declaring) a missing value just did to stored cells (#680).
 *
 * `PUT …/missing-values` returns a six-part accounting of a **silent data
 * mutation** — #592's central hazard — and the dialog read exactly one arm of
 * it, the one demanding action. The five that report *what changed* had no
 * reader anywhere, so the disclosure ended up in the release note in prose
 * ("the number you saw yesterday changed, and the new one is right") when the
 * UI had the numbers at the moment it happened.
 *
 * ⚠️ **`labelled_rows` is a SUBSET of `nulled_rows`**, not a separate
 * population (`schemas/recode.py:201`). Listing them as siblings would double
 * count — 47 cleared + 47 relabelled reads as 94 cells touched when 47 were.
 * It is rendered as a qualifier on the clearing, which is what it is.
 *
 * Returns `null` when nothing changed, so the caller can keep saying
 * "Column updated." rather than "Column updated — ."
 */
export function describeMissingValueChanges(res: {
  nulled_rows: number
  labelled_rows: number
  stripped_scale_points: number
  recovered_rows: number
}): string | null {
  const parts: string[] = []
  if (res.nulled_rows > 0) {
    const relabelled = res.labelled_rows > 0 ? `, ${res.labelled_rows} relabelled` : ''
    parts.push(`${countLabel(res.nulled_rows, 'cell', 'cells')} no longer counted in analysis${relabelled}`)
  }
  if (res.recovered_rows > 0) {
    parts.push(`${countLabel(res.recovered_rows, 'cell', 'cells')} counted again`)
  }
  if (res.stripped_scale_points > 0) {
    parts.push(`${countLabel(res.stripped_scale_points, 'scale point', 'scale points')} removed`)
  }
  return parts.length ? `${parts.join('; ')}.` : null
}
