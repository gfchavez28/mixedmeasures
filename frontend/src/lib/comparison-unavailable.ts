/**
 * Why a group comparison produced nothing (#823c · #827 · the 2026-08-25 round).
 *
 * 🔴 **The client used to answer this itself, with one hardcoded sentence:**
 *
 *     "No comparison data available. The selected demographic may have fewer
 *      than 2 groups."
 *
 * It is right for exactly one of the four ways a comparison comes back empty,
 * and both cases a real research pass hit were among the other three:
 *
 * * **#823(c)** — a variable group whose scale scores had never been computed.
 *   The grouping variable had five groups and was never consulted at all; the
 *   fix was to open an unrelated page and click a chip nothing pointed at.
 * * **#827** — a grouping column in another dataset. Measured on a 3-group
 *   variable, and the message invited the researcher to go and check a variable
 *   that was fine.
 *
 * The server knows which cause applies at each of its early returns, so the
 * reason rides the payload and this module renders it — the same contract as
 * the stated-basis family and `stat-format.ts`'s undefined-statistic reasons.
 *
 * ⚠️ **`satisfies Record<…>` is load-bearing**: a reason added to
 * `services/undefined_stats.py` without a sentence here is a COMPILE error, not
 * a silent fall-through to a wrong default. That is the `ci-label.ts` lesson
 * (#690) and the `MergeDivergenceKind` lesson, both of which shipped a
 * confident wrong screen from a ternary chain's final `else`.
 *
 * ⚠️ **An unknown reason renders NOTHING rather than a guess** — correct for a
 * payload from a newer server, and the whole point of the exercise.
 */

/** The reasons `services/undefined_stats.py::UNAVAILABLE_REASONS` can send. */
export type ComparisonUnavailableReason =
  | 'no_variables'
  | 'domain_scores_missing'
  | 'domain_scores_not_computed'
  | 'no_group_values'
  | 'insufficient_groups'

export interface UnavailableCopy {
  /** The headline: what happened. */
  title: string
  /** What to do about it. Empty when there is nothing useful to say. */
  detail: string
}

const COPY = {
  no_variables: {
    title: 'No comparison data available.',
    detail: 'Select at least one variable to compare.',
  },
  domain_scores_missing: {
    title: 'This variable group has no scale score yet.',
    detail:
      'A comparison needs one score per record. Create the scale score for this ' +
      'group, then come back.',
  },
  domain_scores_not_computed: {
    title: 'This variable group’s scale score has not been computed yet.',
    detail:
      'The score exists but has never been calculated, so there is nothing to ' +
      'compare. Compute it and the comparison will appear.',
  },
  no_group_values: {
    title: 'None of these records has a value for the grouping variable.',
    detail:
      'The grouping variable usually comes from a different dataset than the ' +
      'variables being compared. Pick a grouping variable from the same dataset.',
  },
  insufficient_groups: {
    title: 'The grouping variable has fewer than two groups here.',
    detail:
      'A comparison needs at least two. Check whether groups have been excluded, ' +
      'or whether the variable’s values are declared missing.',
  },
} satisfies Record<ComparisonUnavailableReason, UnavailableCopy>

/**
 * The sentences for an empty comparison, or `null` when we do not recognise the
 * reason (or none was sent — every response from a server that predates this
 * field).
 */
export function describeUnavailable(
  reason: string | null | undefined,
): UnavailableCopy | null {
  if (!reason) return null
  return COPY[reason as ComparisonUnavailableReason] ?? null
}

/** True when the reason is one the researcher fixes by computing a score. */
export function isComputableScoreReason(reason: string | null | undefined): boolean {
  return reason === 'domain_scores_missing' || reason === 'domain_scores_not_computed'
}
