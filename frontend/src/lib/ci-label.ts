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
 * Every `ci_method` the backend can send. Mirrors the `CI_METHOD_*` constants in
 * `services/metrics.py`.
 *
 * ⚠️ **This union is the point.** The previous shape was a ternary on
 * `isItemLevelCi`, so any method it did not know fell silently through to a bare
 * `"95% CI"` — and "silently renders as the ordinary case" is precisely the
 * failure the module exists to prevent. Adding a value here without a row in
 * `CI_DESCRIPTORS` is a TypeScript error, which is the enumeration-debt remedy
 * this codebase already applies elsewhere: make the next variant a compile
 * error rather than trusting a future reader to notice a fall-through.
 */
export type CiMethod =
  | 't_interval'
  | 'wilson'
  | 'item_level_t'
  | 'wilson_per_category'
  | 'kappa_analytic_se'
  | 'alpha_bootstrap_units'

interface CiDescriptor {
  /** Qualifier appended after the level, e.g. "across items". Empty for the
   *  ordinary respondent-level case. */
  qualifier: string
  /** One-sentence explanation for a tooltip; `undefined` when none is needed. */
  caveat?: string
}

const CI_DESCRIPTORS = {
  t_interval: { qualifier: '' },
  wilson: { qualifier: '' },
  item_level_t: {
    qualifier: 'across items',
    caveat:
      'Computed across the items in this scale, not across respondents — it reflects how much the items disagree, so it responds to the number of items rather than the sample size.',
  },
  wilson_per_category: {
    qualifier: 'per category',
    caveat:
      'Each interval covers ONE response category against all the others. They are separate binomial intervals, not a simultaneous set — so they do not jointly cover at this level, and a category whose interval excludes another’s is not thereby significantly different from it.',
  },
  kappa_analytic_se: {
    qualifier: '',
    caveat:
      'A large-sample interval, so it is approximate when few units were double-coded — with a small number of units, or a code that is very rare or near-universal, read it as a rough guide rather than an exact range.',
  },
  alpha_bootstrap_units: {
    qualifier: 'over units',
    caveat:
      'Resampled from the coded UNITS, not from the coders — it answers "how much would α move if we had coded a different sample of this material?", not "…if different people had coded it". Adding coders will not narrow it.',
  },
} satisfies Record<CiMethod, CiDescriptor>

/**
 * Why a coefficient carries NO interval (#43).
 *
 * u-α and time-binned κ sit on the same screen as coefficients that DO have
 * intervals, so a silent blank reads as an oversight rather than as the
 * deliberate refusal it is. Each of these is a statement about the METHOD, not
 * about this project's data — which is why the sentence is fixed rather than
 * computed, and why the server sends the reason instead of the client guessing
 * from which table it is rendering.
 *
 * Mirrors `reliability_intervals.CI_UNAVAILABLE_*`; pinned by
 * `test_ci_method_contract.py`.
 */
export type CiUnavailableReason =
  | 'single_continuum'
  | 'autocorrelated_bins'
  | 'insufficient_units'
  | 'no_variance_in_resamples'

const CI_UNAVAILABLE_NOTES = {
  single_continuum:
    'No confidence interval: this measures one continuous recording, and the marked stretches a resample would draw are the very things whose boundaries are being scored — so there is no defined way to resample it.',
  autocorrelated_bins:
    'No confidence interval: neighbouring time bins are not independent (one mark fills several bins in a row), so the usual resampling would report an interval that is too narrow.',
  insufficient_units:
    'No confidence interval: too few units were coded by two or more people for the range to settle.',
  no_variance_in_resamples:
    'No confidence interval: this code is rare enough here that most resamples contain no instance of it, leaving nothing to agree or disagree about. Coding more of the same material will not fix it — the interval needs more instances of this code, not more units.',
} satisfies Record<CiUnavailableReason, string>

/**
 * The sentence explaining an absent interval, or `undefined` for an unknown
 * reason. Same fall-through discipline as `ciLabel`: saying nothing is correct
 * for a payload this client does not understand, and inventing a reason is not.
 */
export function ciUnavailableNote(reason?: string | null): string | undefined {
  if (!reason) return undefined
  return (CI_UNAVAILABLE_NOTES as Record<string, string>)[reason]
}

/**
 * The confidence level a payload states, as a percentage string.
 *
 * The level has been hard-wired at 95% in six places (four backend computation
 * sites and two client strings, this one included), while `ci_level` has ridden
 * every payload saying `0.95` the whole time. Reading it here costs nothing now
 * and is one of the two ends that must move together when the level becomes
 * configurable — the R export being the other. Absent or malformed falls back to
 * 95, which is what every stored row actually holds.
 */
function levelPercent(level?: number | null): string {
  if (typeof level !== 'number' || !Number.isFinite(level) || level <= 0 || level >= 1) {
    return '95'
  }
  return String(Number((level * 100).toFixed(2)))
}

function descriptorFor(method?: string | null): CiDescriptor | undefined {
  if (!method) return undefined
  return (CI_DESCRIPTORS as Record<string, CiDescriptor>)[method]
}

/**
 * The label for an interval, e.g. `"95% CI"`, `"95% CI across items"`.
 *
 * An unknown or absent method gets the plain label: older `ComputedResult` rows
 * predate `ci_method`, and a missing value must not silently claim the interval is
 * item-level. Under-qualifying an ordinary interval is harmless; over-qualifying a
 * respondent-level one would be a new false statement.
 */
export function ciLabel(method?: string | null, level?: number | null): string {
  const base = `${levelPercent(level)}% CI`
  const qualifier = descriptorFor(method)?.qualifier
  return qualifier ? `${base} ${qualifier}` : base
}

/**
 * The one-sentence explanation, for a tooltip or a title attribute. `undefined` when
 * the interval is the ordinary respondent-level kind and needs no caveat.
 */
export function ciCaveat(method?: string | null): string | undefined {
  return descriptorFor(method)?.caveat
}

/**
 * Just the qualifier, with a leading space, for tooltips that print a bare range
 * (`[2.1, 4.8] across items`) rather than a labelled one. Empty string when the
 * interval is the ordinary kind.
 *
 * Exists so those tooltips stop hand-rolling `isItemLevelCi(m) && ' across items'`
 * — two of them did, which is a third copy of the qualifier vocabulary and one
 * that silently renders any newer method as the ordinary case.
 */
export function ciQualifier(method?: string | null): string {
  const qualifier = descriptorFor(method)?.qualifier
  return qualifier ? ` ${qualifier}` : ''
}
