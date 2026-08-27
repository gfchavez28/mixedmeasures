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

/**
 * What a relabel just did to the column's other recode definitions (#584).
 *
 * Substituting labels into `value_text` RE-KEYS every cell, so any definition
 * still keyed on the old codes stops matching — measured, four of five on a
 * realistic column (a linked reverse, an unlinked reverse, a second scale map
 * and a category group), not just the linked reverse the filed entry describes.
 *
 * ⚠️ The sentence names the CONSEQUENCE, not just the state. "No longer match"
 * alone reads as cosmetic; while such a definition stays non-primary it is
 * merely dormant, and the moment someone makes it primary it NULLs
 * `value_numeric` column-wide (the #580 class). That is what earns a warning.
 *
 * ⛔ It never offers to re-derive: that changes stored numbers a researcher may
 * already have reported, which this project treats as a deliberate, visible act.
 */
export function describeStaledDefinitions(
  staled: { name: string }[], max = 5,
): string | null {
  if (staled.length === 0) return null
  const one = staled.length === 1
  const shown = staled.slice(0, max).map(d => `"${d.name}"`).join(', ')
  const more = staled.length > max ? ` +${staled.length - max} more` : ''
  return (
    `${one ? 'Recode' : 'Recodes'} ${shown}${more} ${one ? 'was' : 'were'} written ` +
    `against the old codes and no longer match this column — re-map ` +
    `${one ? 'it' : 'them'} in the Variables view before using ${one ? 'it' : 'them'}.`
  )
}

/**
 * A declared rule that matched NOTHING (#823a).
 *
 * 🔴 **The motivating case cannot be seen on screen, which is why this exists
 * rather than "look more carefully".** GSS stores `".i:  Inapplicable"` with two
 * interior spaces; HTML collapses interior whitespace, so the researcher reads
 * one space, types one space, and the rule matches zero of 28,041 cells —
 * reported as "Column updated." Copy-paste is not a workaround either: the
 * clipboard receives the collapsed form. Two strings differing only in interior
 * whitespace are indistinguishable to the eye, so the message must NOT ask the
 * researcher to compare them; it points at the picker instead.
 *
 * ⚠️ **The verdict is the SERVER's** — `unmatched_rules` on the response, from
 * the same `is_missing` every read surface uses. "Nothing changed" is not a
 * sound client-side proxy: a correct declaration also nulls zero cells when
 * those values were already caught by the recognized-N/A defaults, so a
 * client-derived warning would fire on healthy declarations.
 *
 * `scope` distinguishes the two calls — a bulk apply reports only rules that
 * matched nothing on EVERY column, since one vocabulary across many variables
 * legitimately misses on most of them.
 */
export function describeUnmatchedRules(
  phrases: string[],
  scope: 'column' | 'all-columns',
): string | null {
  if (!phrases.length) return null
  const shown = phrases.slice(0, 5).map(p => `"${p}"`).join(', ')
  const more = phrases.length > 5 ? ` +${phrases.length - 5} more` : ''
  const where = scope === 'column' ? 'this variable' : 'any of the variables'
  return (
    `${shown}${more} matched no values in ${where}. ` +
    'Values can contain spacing you cannot see on screen — pick from the ' +
    'observed values instead of typing them.'
  )
}


/**
 * Fold a bulk declaration's per-column results into the OPERATION's outcome
 * (#823b).
 *
 * 🔴 The dialog used to pick the authoring column's own row out of `applied`
 * and report that as what happened. Measured on GSS: a declaration applied to
 * 41 variables announced **"32276 cells no longer counted in analysis"** when
 * the true figure was **1,099,939** — a 34x understatement, on the largest
 * silent data mutation in the workflow.
 *
 * ⚠️ `nulled_rows` is the SERVER's `nulled_rows_total`, which had been on the
 * wire and read by nobody. The other counts are summed here because the server
 * sends no totals for them — and `bulk-outcome.test.ts` pins the server's total
 * against the client's own sum of `applied[].nulled_rows`, so the two cannot
 * drift into describing the same operation differently.
 *
 * ⚠️ `recovered_unmapped` is aggregated for the same reason the count is: those
 * demand ACTION, so reporting only the authoring column's would leave forty
 * other columns' unmapped values silently unactioned — #823(b)'s own shape, one
 * field over.
 */
export function bulkMissingOutcome<T extends {
  column_id: number
  nulled_rows: number
  labelled_rows: number
  stripped_scale_points: number
  recovered_rows: number
  recovered_unmapped: string[]
}>(
  bulk: { applied: T[]; nulled_rows_total: number; unmatched_everywhere: string[] },
  columnId: number,
  rules: unknown,
) {
  const sum = (pick: (r: T) => number) => bulk.applied.reduce((n, r) => n + pick(r), 0)
  return {
    column_id: columnId,
    missing_values: rules,
    nulled_rows: bulk.nulled_rows_total,
    labelled_rows: sum(r => r.labelled_rows),
    stripped_scale_points: sum(r => r.stripped_scale_points),
    recovered_rows: sum(r => r.recovered_rows),
    recovered_values: [] as string[],
    unmatched_rules: bulk.unmatched_everywhere,
    recovered_unmapped: [...new Set(bulk.applied.flatMap(r => r.recovered_unmapped))],
  }
}
