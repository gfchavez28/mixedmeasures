/**
 * What a displayed confidence interval is an interval OVER (#690 / #715).
 *
 * ## Why this exists
 *
 * The backend computes three kinds of interval and says which one it produced, in
 * `result_data.ci_method`:
 *
 * - `t_interval`  — a t-interval over RESPONDENTS. The ordinary case.
 * - `wilson`      — a Wilson score interval for a proportion. Also over respondents.
 * - `item_level_t` — a t-interval over **ITEMS**, and this one is different in kind.
 *
 * A domain aggregate ("scale score") averages *k* column-level scalars and treats
 * those *k* numbers as its sample. So its interval is driven by how much the ITEMS
 * in the scale disagree with each other — it widens and narrows with the number of
 * questions, not the number of people who answered. Displayed as a bare "95% CI"
 * next to a scale score, it reads as a sampling interval for that score. It is not
 * one, and the difference is the kind a researcher could carry into a paper.
 *
 * #690 fixed the backend so the honest label survives the computation (it used to be
 * overwritten one line later, so it only appeared when k < 3 — i.e. only when there
 * was no interval to label). Nothing read it. This module is the reading half.
 *
 * ## The rule
 *
 * **The method rides the wire; the client DISPLAYS it and never derives it.** It
 * would be easy to key the qualifier on `metricType === 'domain_aggregate'` — the
 * summary table already has that prop. Don't. The same reasoning as the reverse-recode
 * offset (#578/#600): the server owns the computation, so a client-side mirror of
 * "which computation was that?" drifts from storage the moment a second metric type
 * produces an item-level interval. Thread `ciMethod` alongside `ciLower`/`ciUpper`.
 *
 * Every surface that renders an interval from a metric's `result_data` must label it
 * through `ciLabel` — a hand-written "95% CI" string is the defect this closes.
 */

/** The one method whose interval is over items rather than respondents. */
export const ITEM_LEVEL_CI_METHOD = 'item_level_t'

export function isItemLevelCi(method?: string | null): boolean {
  return method === ITEM_LEVEL_CI_METHOD
}

/**
 * The label for an interval, e.g. `"95% CI"` or `"95% CI across items"`.
 *
 * An unknown or absent method gets the plain label: older `ComputedResult` rows
 * predate `ci_method`, and a missing value must not silently claim the interval is
 * item-level. Under-qualifying an ordinary interval is harmless; over-qualifying a
 * respondent-level one would be a new false statement.
 */
export function ciLabel(method?: string | null): string {
  return isItemLevelCi(method) ? '95% CI across items' : '95% CI'
}

/**
 * The one-sentence explanation, for a tooltip or a title attribute. `undefined` when
 * the interval is the ordinary respondent-level kind and needs no caveat.
 */
export function ciCaveat(method?: string | null): string | undefined {
  return isItemLevelCi(method)
    ? 'Computed across the items in this scale, not across respondents — it reflects how much the items disagree, so it responds to the number of items rather than the sample size.'
    : undefined
}
