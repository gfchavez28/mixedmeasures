/**
 * What a displayed scale score IS, and what its *n* counts — #693.
 *
 * ## Why this exists
 *
 * A crosswalk scale score averages *k* column-level means. It applies no
 * standardisation of any kind, so a 1–5 instrument and a 1–7 instrument — both
 * `ordinal`, both accepted without complaint — average to a number lying on
 * neither scale. And the *n* beside it is the SUM of the per-item respondent
 * counts, which reads as a respondent count:
 *
 *     item A: n=1000 mean=2.0
 *     item B: n=10   mean=8.0
 *     displayed:  5.0   n = 1010        (respondent-weighted: ≈2.06)
 *
 * Ten respondents moved the number three points and the interface presented it
 * as a respondent-level estimate. The R export has always said this plainly in
 * a comment block; the app said nothing, on both the screen where the score is
 * created and the screen where it is read.
 *
 * ## The rule
 *
 * **The basis rides the wire; the client DISPLAYS it and never derives it.**
 * Identical reasoning to `ci-label.ts` (#690/#715) and the reverse-recode
 * offset (#578/#600): the server owns the computation, so a client that keyed
 * the wording on `metricType === 'domain_aggregate'` would drift the moment a
 * second aggregation exists — and POMP / z-scoring is a planned one (#693(ii)).
 * Read `aggregation_basis` out of `result_data` and pass it in.
 *
 * An unknown or absent basis gets NO caveat: older `ComputedResult` rows
 * predate the field, and inventing a description of a computation we cannot
 * identify is the failure this module exists to prevent.
 */

/** Mirrors `AGGREGATION_BASIS_UNWEIGHTED_ITEM_MEANS` in `services/metrics.py`. */
export const UNWEIGHTED_ITEM_MEANS = 'unweighted_item_means'

export function isUnweightedItemMeans(basis?: string | null): boolean {
  return basis === UNWEIGHTED_ITEM_MEANS
}

/**
 * The short label for the aggregate — the phrase the R export already emits, so
 * a researcher reading the screen and a researcher reading the exported script
 * meet the same words.
 */
export function aggregateBasisLabel(basis?: string | null): string | undefined {
  return isUnweightedItemMeans(basis) ? 'unweighted mean of item means' : undefined
}

/**
 * The full caveat, for a tooltip or a note under the number.
 *
 * Says the two things a caveat has to say here: what the arithmetic does, and
 * that the tool never checked the assumption underneath it. Measurement
 * equivalence is ASSERTED by the researcher when they build the variable group
 * — #693(iii), and the same family as #690, #707 and #708.
 */
export function aggregateBasisCaveat(basis?: string | null): string | undefined {
  return isUnweightedItemMeans(basis)
    ? 'This score is the unweighted mean of each item’s mean, so every item counts equally '
      + 'regardless of how many people answered it. Mixed Measures does not test whether the items '
      + 'measure on a common scale — that equivalence is asserted by you when you group them.'
    : undefined
}

/**
 * How to state the *n* of a scale score.
 *
 * ⚠️ Deliberately NOT the pooled figure alone. "n = 1010" beside a mean is read
 * as respondents, and a caveat beside a misleading number is still a misleading
 * number — so the unit (items) and the spread of per-item respondent counts are
 * stated in the value itself, and the pooled total is left to the tooltip.
 *
 * Returns null when the result predates the fields or contributed no items, so
 * a caller falls back to the plain `n` rather than printing "0 items".
 */
export function aggregateNLabel(rd: {
  member_count?: number | null
  member_n_min?: number | null
  member_n_max?: number | null
}): string | null {
  const k = rd.member_count
  if (k == null || k < 1) return null
  const lo = rd.member_n_min
  const hi = rd.member_n_max
  const items = `${k} ${k === 1 ? 'item' : 'items'}`
  if (lo == null || hi == null) return items
  // An equal range is one number, not "10–10" — the spread is the point, and a
  // repeated bound reads as a formatting bug rather than as agreement.
  return lo === hi ? `${items} · n ${lo}` : `${items} · n ${lo}–${hi}`
}

/** The tooltip for that cell: the pooled figure, named as what it actually is. */
export function aggregateNCaveat(rd: {
  member_count?: number | null
  member_n_min?: number | null
  member_n_max?: number | null
}, pooledN: number): string | null {
  const k = rd.member_count
  if (k == null || k < 1) return null
  return `Averaged over ${k} ${k === 1 ? 'item' : 'items'}. The ${pooledN} responses behind it are `
    + 'a total across those items, not a count of respondents — one person answering every item '
    + 'is counted once per item.'
}
