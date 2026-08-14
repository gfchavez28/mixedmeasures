/**
 * Rendering a statistic that has no value (#689 / #566).
 *
 * The backend no longer collapses an undefined statistic to `0.0` — a
 * correlation cell reading `0.00` is read as *no relationship* when the truth
 * is *not computable* — so every numeric render site can now receive `null`,
 * and each one must say the same thing about it.
 *
 * **Why the sentence lives here and not at the render site.** The reason
 * arrives from the server as a code; if each surface wrote its own words for
 * `no_variance`, the tooltip, the empty cell and the exported file would drift
 * apart. That is the two-halves-of-one-fact defect this codebase has now hit
 * four times (#732, #742, #679, #746), and it is why the reason rides the wire
 * at all rather than being derived from the inputs at each surface.
 */

/** The reasons `services/undefined_stats.py` can send. Keep in step with it. */
export type UndefinedReason =
  | 'insufficient_n'
  | 'empty_group'
  | 'no_variance'
  | 'degenerate'

/** What a missing number looks like. One character, everywhere. */
export const NO_VALUE = '—'

/**
 * Format a statistic, or `NO_VALUE` if it has none.
 *
 * ⚠️ A real measured zero formats as `0.00`. Never shorten the guard to
 * `value ? … : NO_VALUE` — that blanks a genuine zero, which is the falsy-zero
 * defect this project has already shipped twice.
 */
export function formatStat(value: number | null | undefined, digits = 2): string {
  return value == null || !Number.isFinite(value) ? NO_VALUE : value.toFixed(digits)
}

const REASON_TEXT: Record<UndefinedReason, string> = {
  insufficient_n: 'Too few values to compute this, after missing data was excluded.',
  empty_group: 'No values in this group, after missing data was excluded.',
  no_variance: 'Every value here is identical, so this cannot be computed.',
  degenerate: 'Too few distinct categories to compute this.',
}

/**
 * The sentence a researcher reads for an absent statistic.
 *
 * Returns `null` for an unknown or absent reason so a caller can fall back to
 * showing nothing rather than inventing an explanation — an unrecognised code
 * from a newer backend must not become a confident wrong sentence.
 */
export function describeUndefined(reason: string | null | undefined): string | null {
  if (!reason) return null
  return REASON_TEXT[reason as UndefinedReason] ?? null
}

/**
 * Tooltip text for a cell that has no value: the sentence if we know it, and a
 * neutral fallback if we do not.
 */
export function undefinedTooltip(reason: string | null | undefined): string {
  return describeUndefined(reason) ?? 'Not computable for this data.'
}
