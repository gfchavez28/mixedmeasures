/**
 * What the app SAYS about a saved result that may not be this build's answer (#958 §6).
 *
 * An `.mmproject` no longer carries per-record scores. They are DERIVED —
 * `compute_metric` rebuilds every one of them from the dataset values and metric
 * definitions the same archive already holds — and carrying them let a number computed by
 * some other build, from data that may since have changed, arrive reading as current. So
 * the import marks the project's saved results stale instead.
 *
 * 🔴 **THIS HELD A SECOND SENTENCE FOR HALF A DAY AND IT IS GONE — do not restore it
 * (removed 2026-09-21).** `staleResultsSentence` fed an amber notice on the quantitative
 * chart. That surface reads its metrics from the QUICK-COMPUTE response, and
 * `quick_compute` recomputes any stale metric before answering, so the flag was always
 * false by the time the notice could read it. **Measured: two stale GSS scale scores each
 * flipped to fresh on the page load that selected them, and the notice never appeared
 * across 24 samples over 12 seconds.** A control that cannot fire is worse than no control
 * (#941), so it was removed rather than kept as belt-and-braces.
 *
 * ⚠️ **`stale` is a POSITIVE signal.** Silence from this helper means "nothing has told us
 * these are out of date", never "these are fresh" — the same bargain `managed_stale` makes
 * for participant scores, and the reason it has no "up to date" return value to offer.
 */

/**
 * The import / duplicate toast line, or `null` when there is nothing to say.
 *
 * 🔴 **Returning `null` is the point.** The count is `0` far more often than not — a merge
 * imports no metrics, and most projects save none — so a caller that gated on the field's
 * PRESENCE rather than its VALUE would announce "0 saved results were marked out of date"
 * on nearly every import.
 *
 * ⚠️ Deliberately does NOT name a menu path. The act lives on a route the researcher has
 * to be ON to perform, and the notice that meets them there is the durable half.
 */
export function staleResultsNote(metrics: number, tests = 0): string | null {
  const m = Number.isFinite(metrics) && metrics > 0 ? metrics : 0
  const t = Number.isFinite(tests) && tests > 0 ? tests : 0
  if (m === 0 && t === 0) return null
  if (t === 0) {
    const subject = m === 1 ? '1 saved result was' : `${m} saved results were`
    return (
      `${subject} marked out of date: computed results travel with a project file, `
      + 'but the per-record scores behind them are rebuilt here. Recompute them in '
      + 'Analysis to get this version’s numbers.'
    )
  }
  // #1039 (a) — saved TESTS are marked too: a test's result is a number the copy that
  // saved it computed, and nothing here can vouch for it until it runs again.
  const tested = t === 1 ? '1 saved test' : `${t} saved tests`
  const subject = m === 0
    ? `${tested} ${t === 1 ? 'was' : 'were'}`
    : `${m === 1 ? '1 saved result' : `${m} saved results`} and ${tested} were`
  return (
    `${subject} marked out of date: they travel with a project file as the copy that `
    + 'saved them computed them, and this version works them out again from the data. '
    + 'Recompute them in Analysis to get this version’s numbers.'
  )
}
