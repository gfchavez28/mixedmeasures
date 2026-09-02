/**
 * Reading a reliability coefficient's confidence interval (#43).
 *
 * ## Why a band word alone is not enough
 *
 * The Reliability panel labels α = 0.72 "tentative" and α = 0.81 "reliable" from
 * the point estimate, as if the cutoff were a fact about the study. With an
 * interval in hand the honest question is different: **can this sample tell the
 * bands apart at all?** α = 0.72 with a 95% interval of [0.55, 0.85] is
 * consistent with "unreliable" AND with "reliable" — the band word is the least
 * informative thing on the row, and quoting it without the interval is exactly
 * what a methods reviewer circles.
 *
 * So this module answers one question the raw bounds do not: which of the
 * interpretation cutoffs does the interval STRADDLE. That sentence is the
 * reason the feature exists; the numbers on their own would just be two more
 * decimals.
 *
 * ## Where the cutoffs come from
 *
 * `interpretation_thresholds` already rides the IRR payload precisely so the
 * client renders bands without hardcoding them (#473). This module takes them as
 * an argument for the same reason — κ's five Landis & Koch bands and α's two
 * Krippendorff cutoffs are different sets, and a module that knew either would
 * be a second place they live.
 */

/** The wire shape of an interval — mirrors `schemas/code_analysis.py::IrrInterval`. */
export interface ReliabilityInterval {
  lower: number | null
  upper: number | null
  level: number
  method: string
  n_resamples: number | null
  unavailable_reason: string | null
}

/** True when the interval carries usable bounds. */
export function hasBounds(
  ci?: ReliabilityInterval | null,
): ci is ReliabilityInterval & { lower: number; upper: number } {
  return ci != null && ci.lower != null && ci.upper != null
}

/**
 * `"0.58 to 0.83"` — the bounds as spoken text.
 *
 * ⚠️ **Deliberately "to", not an en dash or a comma.** A screen reader renders
 * `[0.58, 0.83]` as "left bracket zero point five eight comma…", and a range
 * dash is read as a minus sign — which on a coefficient that can legitimately go
 * negative is not merely ugly but wrong. The bracket notation is for the eye and
 * is `aria-hidden`; this is what gets announced.
 */
export function intervalRangeText(ci?: ReliabilityInterval | null, dp = 2): string | null {
  if (!hasBounds(ci)) return null
  return `${ci.lower.toFixed(dp)} to ${ci.upper.toFixed(dp)}`
}

/** `"[0.58, 0.83]"` — the compact visual form. Never announced. */
export function intervalVisualText(ci?: ReliabilityInterval | null, dp = 2): string | null {
  if (!hasBounds(ci)) return null
  return `[${ci.lower.toFixed(dp)}, ${ci.upper.toFixed(dp)}]`
}

/** `95` from `0.95`, tolerating a missing or malformed level. */
function levelPercent(level?: number | null): string {
  if (typeof level !== 'number' || !Number.isFinite(level) || level <= 0 || level >= 1) {
    return '95'
  }
  return String(Number((level * 100).toFixed(2)))
}

/**
 * The cutoffs the interval straddles, named, in ascending order of value.
 *
 * A cutoff counts as straddled when `lower < cutoff <= upper` — the interval
 * genuinely spans it. A cutoff the interval sits entirely above or below is
 * settled by the data and says nothing.
 */
export function straddledThresholds(
  ci: ReliabilityInterval | null | undefined,
  thresholds: Record<string, number> | undefined,
): { name: string; value: number }[] {
  if (!hasBounds(ci) || !thresholds) return []
  return Object.entries(thresholds)
    .filter(([, value]) => Number.isFinite(value) && ci.lower < value && value <= ci.upper)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => a.value - b.value)
}

/**
 * The sentence, or `null` when the interval settles every cutoff it touches.
 *
 * `bandWord` maps a threshold key to the word the panel shows for it, so this
 * module never invents display vocabulary of its own.
 */
export function straddleNote(
  ci: ReliabilityInterval | null | undefined,
  thresholds: Record<string, number> | undefined,
  bandWord: (key: string) => string,
): string | null {
  const crossed = straddledThresholds(ci, thresholds)
  if (crossed.length === 0) return null
  const named = crossed.map(t => `${t.value} (${bandWord(t.name)})`)
  const list = named.length === 1
    ? named[0]
    : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`
  return `This interval spans the ${list} cutoff${crossed.length > 1 ? 's' : ''}, so these data cannot tell those readings apart.`
}

/**
 * What a screen reader hears for an interval, e.g.
 * `"95% confidence interval 0.58 to 0.83 over units"`.
 *
 * `qualifier` comes from `ci-label.ts::ciQualifier` so the method vocabulary
 * stays single-sourced — this module must not learn what a method means.
 */
export function intervalAccessibleText(
  ci: ReliabilityInterval | null | undefined,
  qualifier: string,
): string | null {
  const range = intervalRangeText(ci)
  if (range == null) return null
  return `${levelPercent(ci?.level)}% confidence interval ${range}${qualifier}`
}
