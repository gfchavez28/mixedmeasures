/**
 * #707(b) — the reading half of Little's MCAR test's stated basis.
 *
 * The NINTH member of the STATED-BASIS FAMILY (see the internal design notes):
 * the server states how a number was produced and the client DISPLAYS that, never
 * inferring it from the metric type.
 *
 * ## Why this test needs one
 *
 * Little's MCAR test is DEFINED over maximum-likelihood (EM) estimates of μ and Σ.
 * This implementation uses `np.nanmean` plus a pooled pairwise available-case
 * covariance — an approximation that biases the statistic under substantial
 * missingness, which is exactly the regime a researcher reaches for it in. The
 * p-value therefore reads as more authoritative than it is, and nothing on screen
 * said so.
 *
 * ## Why a basis and not a warning
 *
 * ⚠️ The panel already renders `eligibility.warning`, and the pseudo-inverse and
 * clamped-statistic notes ride that channel. Those are CONDITIONAL — they fire on
 * degeneracy — so a reader learns to treat them as "something unusual happened
 * here". The estimator is a property of the METHOD, true on every run. Putting a
 * standing fact in the exceptional channel teaches people to dismiss it.
 *
 * ## Why it is not a hardcoded string
 *
 * 🔴 An EM loop is the expensive half of #707(b) and is explicitly deferred. On the
 * day it lands, a client that hardcodes "available-case" keeps describing EM
 * numbers as available-case — each half individually correct, the pair wrong. That
 * is the "two halves of one fact" class. Adding a value to `McarEstimator` without
 * writing a phrase for it is a COMPILE error here.
 *
 * Constants are hand-mirrored with `services/data_quality.py` — no codegen — so
 * `tests/test_mcar_basis.py::TestCrossLanguageContract` reads THIS FILE and fails
 * on drift. TypeScript catches only the opposite direction.
 */

/** Mirrors `MCAR_ESTIMATOR_AVAILABLE_CASE` in `services/data_quality.py`. */
export const MCAR_ESTIMATOR_AVAILABLE_CASE = 'available_case'

/**
 * Every estimator this client can DESCRIBE. When the backend gains one — `'em'`
 * is the planned second — add it here and the map below stops compiling until it
 * has words.
 */
export type McarEstimator = typeof MCAR_ESTIMATOR_AVAILABLE_CASE

/**
 * ⚠️ `satisfies Record<…>` on purpose, and read through a string-keyed cast so the
 * two unknowns stay separate: an estimator this build does not know is reported
 * VERBATIM (correct for a newer server), while one added to the union with no
 * phrase fails the build (correct for us).
 */
const ESTIMATOR_PHRASE = {
  [MCAR_ESTIMATOR_AVAILABLE_CASE]:
    'Estimated from available cases (pairwise), not the EM estimates Little’s test '
    + 'is defined over — the statistic is approximate under heavy missingness.',
} satisfies Record<McarEstimator, string>

/**
 * The basis in words, or `null` when there is nothing to say.
 *
 * Returns `null` for an absent basis — an older payload predating the field —
 * because inventing a description of a computation we cannot identify is the
 * failure this module exists to prevent. An unknown-but-present value is named
 * rather than silently dropped.
 */
export function describeMcarEstimator(estimator?: string | null): string | null {
  if (!estimator) return null
  return (ESTIMATOR_PHRASE as Record<string, string>)[estimator]
    ?? `Estimator: ${estimator}.`
}
