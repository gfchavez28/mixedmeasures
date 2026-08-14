/**
 * Do these columns measure on the SAME scale? — #693.
 *
 * ## Why this exists
 *
 * A crosswalk scale score is an unweighted mean of per-column means. Nothing in
 * the tool standardises them, and `assert_columns_same_type` cannot help: a 1–5
 * Likert and a 1–7 Likert are BOTH `ordinal`, so they group without complaint
 * and their means are averaged into a number that lies on neither scale.
 *
 *     instrument A (1-5) mean 3.0 · instrument B (1-7) mean 4.0  ->  3.5
 *
 * The detection already existed — as a private helper inside `buildGrid`,
 * feeding a gutter icon on the crosswalk grid. The screen where the score is
 * CREATED and the screen where it is READ were both silent, which made this a
 * last-hop problem rather than an ignorance one. This module is the shared
 * detector so every one of those surfaces reaches the same verdict.
 *
 * ## The three-state verdict, and why `unknown` is not `match`
 *
 * `scaleSignature` returns null for a column carrying no scale metadata at all,
 * and `buildGrid`'s caller treated null as "nothing to disagree with" — so the
 * flagship 1–5 vs 1–7 case escaped entirely whenever either side lacked labels.
 * `unknown` says so out loud instead. Silence about an unchecked claim reads as
 * a passed check, which is the thing this issue is about.
 */

/**
 * Normalise a label list into a comparable key.
 *
 * Trim, lowercase, then JSON-stringify the SORTED array. Sorting is what makes
 * a reverse-direction encoding (1=disagree…5=agree vs 5=disagree…1=agree)
 * compare equal — they are the same scale, differently numbered. Returns null
 * for an absent or empty list.
 */
export function normalizeScaleLabels(labels: string[] | null | undefined): string | null {
  if (!labels || labels.length === 0) return null
  const cleaned = labels.map((l) => (l ?? '').trim().toLowerCase())
  return JSON.stringify([...cleaned].sort())
}

/**
 * A column's scale signature, or null when it has no scale metadata.
 *
 * Composition (preferred → fallback → null):
 *   1. `scale_labels` → the normalized labels. Catches same-point-count,
 *      different-content (a 5-point agreement scale vs a 5-point frequency one).
 *   2. `scale_points` → `points:N`. The fallback for legacy projects that
 *      recorded a point count but no labels.
 *   3. null → unknown.
 *
 * A labelled column and an unlabelled one cannot share a signature even at
 * equal point counts, because the two shapes are textually distinct. That is
 * deliberate: they give the researcher different actionable information.
 */
export function scaleSignature(col: {
  scale_points: number | null
  scale_labels: string[] | null
}): string | null {
  const labels = normalizeScaleLabels(col.scale_labels)
  if (labels != null) return `labels:${labels}`
  if (col.scale_points != null) return `points:${col.scale_points}`
  return null
}

export type ScaleAgreement = 'match' | 'mismatch' | 'unknown'

/**
 * Do these columns agree on a scale?
 *
 * - `mismatch` — two known signatures differ. Averaging their means produces a
 *   number on neither scale.
 * - `unknown`  — fewer than two columns carry scale metadata, so the question
 *   was never answerable. **Not** `match`: see the module docstring.
 * - `match`    — every known signature agrees, and at least two are known.
 *
 * A single column (or none) is `unknown` rather than `match` for the same
 * reason — there is nothing to compare, and a one-item "scale" has no
 * cross-scale claim to verify. Callers that only care about the warning treat
 * `unknown` and `mismatch` differently in wording, never in whether to speak.
 */
export function compareScales(
  cols: { scale_points: number | null; scale_labels: string[] | null }[],
): ScaleAgreement {
  const known = cols.map(scaleSignature).filter((s): s is string => s != null)
  if (known.length < 2) return 'unknown'
  return known.every(s => s === known[0]) ? 'match' : 'mismatch'
}
