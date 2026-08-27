/**
 * #525 — the reading half of the assumption checks.
 *
 * A member of the STATED-BASIS FAMILY: the server states which test it ran and,
 * for Levene, which centre it used; the client displays that and never assumes.
 * Centring on the mean gives a different number from the same data, so a figure
 * without its centre is not reproducible.
 *
 * Constants are hand-mirrored with `services/assumption_checks.py` — no codegen —
 * so `tests/test_assumption_checks.py::TestCrossLanguageContract` reads this file.
 */

export const NORMALITY_TEST_SHAPIRO = 'shapiro_wilk'
export const VARIANCE_TEST_LEVENE = 'levene'
export const LEVENE_CENTER_MEDIAN = 'median'

/**
 * ⚠️ Above this, Shapiro-Wilk rejects normality for departures too small to
 * matter; below the lower bound it has almost no power to detect real ones.
 * These are the reason the caveat is NOT optional — a bare p-value beside a
 * toggle would make the tool more confidently wrong than saying nothing.
 */
export const SHAPIRO_OVERSENSITIVE_N = 200
export const SHAPIRO_UNDERPOWERED_N = 10

/** The test's name, for display. Unknown values are shown verbatim. */
export function assumptionTestLabel(test: string, center?: string | null): string {
  if (test === NORMALITY_TEST_SHAPIRO) return 'Shapiro–Wilk'
  if (test === VARIANCE_TEST_LEVENE) {
    return center === LEVENE_CENTER_MEDIAN
      ? 'Levene (median-centred — Brown–Forsythe)'
      : center ? `Levene (${center}-centred)` : 'Levene'
  }
  return test
}

/**
 * What a normality p-value can and cannot tell you AT THIS n.
 *
 * Keyed on n rather than fixed, because the failure runs in BOTH directions and
 * a researcher needs the one that applies to them. Returns `null` in the middle
 * band, where the test behaves as advertised and a caveat would be noise.
 */
export function normalityCaveat(n: number): string | null {
  if (n >= SHAPIRO_OVERSENSITIVE_N) {
    return `With n = ${n}, this test flags departures from normality too small to `
      + 'affect the comparison. Read the box plot rather than the p-value.'
  }
  if (n > 0 && n < SHAPIRO_UNDERPOWERED_N) {
    return `With n = ${n}, this test has little power — a non-significant result is `
      + 'weak evidence of normality, not evidence of it.'
  }
  return null
}

/**
 * Groups that are in the COMPARISON but not meaningfully in LEVENE'S TEST (#525b).
 *
 * Two distinct cases, and neither was reported before:
 *
 * - **empty** — dropped from the test outright, so the p-value describes fewer
 *   groups than the panel shows.
 * - **singleton** — included, but its deviation from its own median is exactly
 *   0 by construction. That reads as perfect homogeneity when it is really an
 *   absence of evidence. Measured: `levene([1.0], [1,2,3,4], center="median")`
 *   returns a confident-looking `p = 0.219` resting on that structural zero.
 *
 * Neither justifies refusing the statistic — dropping a group would test a
 * different model from the one the panel ran — so both are NAMED, exactly as
 * the normality line already names what Shapiro-Wilk could not test.
 */
export function leveneCaveat(
  v: { excluded_groups?: string[]; singleton_groups?: string[] } | null | undefined,
): string | null {
  if (!v) return null
  const excluded = v.excluded_groups ?? []
  const singles = v.singleton_groups ?? []
  const parts: string[] = []
  if (excluded.length) parts.push(`${excluded.length} empty, not in the test (${excluded.join(', ')})`)
  if (singles.length) parts.push(`${singles.length} with a single observation (${singles.join(', ')})`)
  return parts.length ? parts.join('; ') : null
}

/** The strongest caveat across the groups shown, or null if none applies. */
export function worstNormalityCaveat(ns: number[]): string | null {
  const big = ns.filter(n => n >= SHAPIRO_OVERSENSITIVE_N)
  if (big.length) return normalityCaveat(Math.max(...big))
  const small = ns.filter(n => n > 0 && n < SHAPIRO_UNDERPOWERED_N)
  if (small.length) return normalityCaveat(Math.min(...small))
  return null
}
