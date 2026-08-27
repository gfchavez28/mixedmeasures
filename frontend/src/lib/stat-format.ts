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
  | 'not_numeric'

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
  // #830(b): this used to report as `empty_group`, which says the group is
  // empty and the missing data is why — two claims about the DATA for what is a
  // property of the VARIABLE, repeated once per group. A nominal column is a
  // legitimate metric input (#371), so a researcher reaches this from an
  // ordinary selection and needs to be told which variable to change.
  not_numeric: 'This variable holds categories, not numbers, so it cannot be compared across groups.',
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

/**
 * A DESCRIPTIVE statistic's decimals — how many, and why not one (#823e).
 *
 * The summary table rendered every number at `DISPLAY_PRECISION` (= 1), which
 * is right for the percentages and data labels that constant exists for and
 * wrong for descriptives. Measured live on a 43,000-respondent GSS scale:
 *
 * | column | rendered | actual |
 * |---|---|---|
 * | SE  | `0.0` ×3 | 0.0047, 0.0046, 0.0046 |
 * | SD  | `1.0` ×3 | 0.9681, 0.9506, 0.9630 |
 * | Mean | `2.0`, `2.0` | 1.9948, 2.0367 |
 *
 * **An SE collapses to zero for any large sample by construction** — it is
 * `sd/√n`, so the bigger the study the more certainly this reads `0.0`, on the
 * one column whose job is to say how precise the estimate is. Two SDs that
 * differ read identically, and so do two means 0.04 apart, which is what makes
 * an A-vs-B comparison unreadable from the table. Meanwhile Cronbach's α is
 * shown to 4 dp on the same screen.
 *
 * Two decimals is the base (`formatStat`'s own default, and the APA convention
 * for means and SDs), and a non-zero value is never allowed to render as zero:
 * decimals extend until at least two significant digits show. A REAL zero still
 * prints `0.00` — the falsy-zero rule this codebase has shipped twice.
 *
 * ⚠️ Deliberately NOT a change to `DISPLAY_PRECISION`. That constant has ~40
 * consumers, nearly all percentages (`34.5%`) and chart data labels, where a
 * second decimal is noise on every axis in the app.
 */
export const DESCRIPTIVE_PRECISION = 2

/** Most decimals `formatDescriptive` will spend chasing a significant digit. */
const MAX_DESCRIPTIVE_PRECISION = 6

export function formatDescriptive(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return NO_VALUE
  let digits = DESCRIPTIVE_PRECISION
  // `10 ** (1 - digits)` is the smallest magnitude that still shows two
  // significant digits at `digits` decimals. A genuine 0 skips the loop.
  while (
    value !== 0
    && digits < MAX_DESCRIPTIVE_PRECISION
    && Math.abs(value) < 10 ** (1 - digits)
  ) {
    digits++
  }
  return value.toFixed(digits)
}
