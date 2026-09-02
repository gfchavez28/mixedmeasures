/**
 * #35 — the reading half of a reliability coefficient's STATED BASIS: what the
 * coefficient generalises over (its FACET) and how a difference between two
 * values was scored (its α METRIC).
 *
 * The TENTH member of the STATED-BASIS FAMILY (the internal design notes):
 * the server states how a number was produced and the client DISPLAYS that,
 * never inferring it from which screen it is rendering.
 *
 * ## Why an α needs a facet
 *
 * A dataset scale score's Cronbach's α and a coded corpus's Krippendorff's α are
 * the same quantity with a different facet designated as the object of
 * measurement — α is algebraically an intraclass correlation. The scale score's
 * is over ITEMS (do the questions hang together?); the coding one is over CODERS
 * (do the people agree?). Within one table there is no confusion. Across the
 * Analysis view and the Reliability tab, read in the same afternoon, a bare
 * "α = 0.82" is the same letter making two different claims — so each payload
 * says which, and this module turns that into words.
 *
 * ## Why an α needs a metric
 *
 * Krippendorff's α takes a difference function. Presence/absence coding is
 * scored NOMINALLY (two codings match or they do not). A magnitude RATING is
 * scored on the INTERVAL metric: a 3 and a 4 disagree less than a 3 and a 9,
 * using the distances the declared scale asserts. The two coefficients sit on
 * the same tab and must never be read as the same number.
 *
 * Constants are hand-mirrored with `services/reliability_basis.py` — no codegen —
 * so `tests/test_reliability_basis.py::TestCrossLanguageContract` reads THIS FILE
 * and fails on drift. TypeScript catches only the opposite direction.
 */

// ── The facet ──────────────────────────────────────────────────────────────

/** Mirrors `RELIABILITY_FACET_CODERS` / `RELIABILITY_FACET_ITEMS`. */
export const RELIABILITY_FACET_CODERS = 'coders'
export const RELIABILITY_FACET_ITEMS = 'items'

export type ReliabilityFacet =
  | typeof RELIABILITY_FACET_CODERS
  | typeof RELIABILITY_FACET_ITEMS

/**
 * ⚠️ `satisfies Record<…>` on purpose: a facet added to the union with no words
 * fails the build, while one this build does not know is reported verbatim
 * (correct for a newer server) — the two unknowns stay separate.
 */
const FACET_QUALIFIER = {
  [RELIABILITY_FACET_CODERS]: 'over coders',
  [RELIABILITY_FACET_ITEMS]: 'across items',
} satisfies Record<ReliabilityFacet, string>

const FACET_SENTENCE = {
  [RELIABILITY_FACET_CODERS]:
    'Reliability here is agreement between the people who coded: the same material, judged by different coders.',
  [RELIABILITY_FACET_ITEMS]:
    'Reliability here is consistency among the items of the scale: whether the questions measure one thing. It says nothing about agreement between people.',
} satisfies Record<ReliabilityFacet, string>

/**
 * The short qualifier for a label, e.g. `"over coders"`, or `null` for an absent
 * facet — an older payload predating the field must not be relabelled, because
 * inventing a basis for a number we cannot identify is the failure this module
 * exists to prevent. An unknown-but-present value is named rather than dropped.
 */
export function reliabilityFacetQualifier(facet?: string | null): string | null {
  if (!facet) return null
  return (FACET_QUALIFIER as Record<string, string>)[facet] ?? `over ${facet}`
}

/** The one-sentence explanation for a visible explainer; `null` when absent. */
export function describeReliabilityFacet(facet?: string | null): string | null {
  if (!facet) return null
  return (FACET_SENTENCE as Record<string, string>)[facet] ?? `Reliability facet: ${facet}.`
}

// ── The α metric ───────────────────────────────────────────────────────────

/** Mirrors `ALPHA_METRIC_*`. The strings R's `irr::kripp.alpha(method=)` takes. */
export type AlphaMetric = 'nominal' | 'ordinal' | 'interval' | 'ratio'

const METRIC_SENTENCE = {
  nominal:
    'Scored nominally: two codings either match or they do not — applied, or not applied.',
  ordinal:
    'Scored on ranks: how many scale points apart two ratings fall, ignoring the declared distances between them.',
  interval:
    'Scored on the interval metric: a 3 and a 4 disagree less than a 3 and a 9, using the distances the declared scale asserts.',
  ratio:
    'Scored on the ratio metric: differences are taken relative to the size of the values, which needs a scale with a true zero.',
} satisfies Record<AlphaMetric, string>

/**
 * The metric as a label word, e.g. `"interval"`; `null` when absent. An unknown
 * value is returned verbatim — a newer server's vocabulary is still a fact.
 */
export function alphaMetricLabel(metric?: string | null): string | null {
  if (!metric) return null
  return metric
}

/** The explanatory sentence, or `null` for an absent metric. */
export function describeAlphaMetric(metric?: string | null): string | null {
  if (!metric) return null
  return (METRIC_SENTENCE as Record<string, string>)[metric] ?? `Scored on the ${metric} metric.`
}
