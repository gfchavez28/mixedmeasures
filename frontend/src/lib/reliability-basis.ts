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
import type { UndefinedReason } from './stat-format'

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

// ── The unit — what "Units" counts (#1333 / #1334) ──────────────────────────

/**
 * Mirrors `services/reliability_basis.py::UNIT_BASIS_*` — the FOURTEENTH
 * stated-basis member. The same coders on the same coding give a different α
 * depending on what one unit is, so the payload states it and this module says
 * it beside "Units". Both values count a group of turns ONCE; they differ on
 * whether a facilitator's (interviewer's) turn is a unit.
 */
export const UNIT_BASIS_PARTICIPANT_PASSAGES = 'participant_passages'
export const UNIT_BASIS_ALL_PASSAGES = 'all_passages'

export type ReliabilityUnitBasis =
  | typeof UNIT_BASIS_PARTICIPANT_PASSAGES
  | typeof UNIT_BASIS_ALL_PASSAGES

const UNIT_BASIS_SENTENCE = {
  [UNIT_BASIS_PARTICIPANT_PASSAGES]:
    "Units are passages from participants: an interviewer's or facilitator's turns are left out, and a group of turns counts once.",
  [UNIT_BASIS_ALL_PASSAGES]:
    "Units are every passage, an interviewer's or facilitator's turns included; a group of turns counts once.",
} satisfies Record<ReliabilityUnitBasis, string>

/**
 * The sentence for the Units column, or `null` for an absent basis — a payload
 * from before 1.5.9 counted every turn (a group's members included) and must not
 * be relabelled with a rule it was not computed under. An unknown-but-present
 * value is named rather than dropped.
 */
export function describeUnitBasis(basis?: string | null): string | null {
  if (!basis) return null
  return (UNIT_BASIS_SENTENCE as Record<string, string>)[basis] ?? `Units: ${basis}.`
}

/**
 * #1333 / #1334, D16 — the Reconciliation grid adjudicates the consensus layer,
 * which covers facilitator turns (a coded prompt may need adjudicating), so the
 * grid lists an interviewer's turns where the Reliability tab's "Units" leaves
 * them out. A segment GROUP is one row on both since 1.5.9's unit 3 (D35), so
 * interviewer turns are now the ONLY thing separating the two counts. The grid
 * says so rather than leaving two numbers on neighbouring tabs to disagree in
 * silence. Mirrors the comment at `services/reconciliation.py::build_reconciliation`'s
 * gather call.
 */
export const RECONCILIATION_UNITS_NOTE =
  "This grid lists an interviewer's turns too (a group of turns is one row, as in reliability), so its count is not the Reliability tab's Units."

/** How many speaker names the exclusion sentence prints before "and N more". */
export const FACILITATOR_SPEAKERS_SHOWN = 4

/**
 * How many codes the exclusion sentence names — the ones with the MOST coded
 * facilitator turns — before "and N more codes". Measured on the Track J stress
 * corpus at 640×360: seven codes made the sentence five lines and pushed the
 * table below the fold. Every code's own count is in its row
 * (`facilitatorRowNote`), so the bound loses nothing.
 */
export const FACILITATOR_CODES_SHOWN = 3

/**
 * One row's share of the exclusion: `"2 facilitator turns carrying it are left
 * out"`, or `null` when none are (or the payload predates the field). The IRR
 * table puts it in the row's accessible name and the Units cell's hover text.
 */
export function facilitatorRowNote(coded?: number | null): string | null {
  if (coded == null || coded <= 0) return null
  return `${coded} facilitator ${coded === 1 ? 'turn carrying it is' : 'turns carrying it are'} left out`
}

/**
 * #1333 / D18 — what the facilitator exclusion LEFT OUT, said rather than
 * dropped: how many turns, WHOSE (the exclusion keys on a speaker flag the
 * import sets only for an "Interviewer"/"Facilitator" label, so a "Moderator"
 * left as a participant is visible only by its absence from this list), and the
 * codes a coder applied to one anyway — coding the figure does not include.
 *
 * `null` when nothing was left out, or the payload predates the fields. Every
 * number and name comes from the server; nothing here is derived.
 */
export function describeFacilitatorExclusion(input: {
  excluded?: number | null
  speakers?: readonly string[] | null
  perCode: readonly { code_name: string; facilitator_turns_coded?: number | null }[]
}): string | null {
  const n = input.excluded ?? null
  if (n == null || n <= 0) return null
  const names = input.speakers ?? []
  const shown = names.slice(0, FACILITATOR_SPEAKERS_SHOWN)
  const rest = names.length - shown.length
  const who = shown.length === 0
    ? ''
    : ` (${shown.join(', ')}${rest > 0 ? ` and ${rest} more` : ''})`
  const head = `${n} facilitator ${n === 1 ? 'turn' : 'turns'}${who} ${n === 1 ? 'is' : 'are'} left out here`
  const coded = input.perCode
    .filter(c => (c.facilitator_turns_coded ?? 0) > 0)
    .sort((a, b) => (b.facilitator_turns_coded ?? 0) - (a.facilitator_turns_coded ?? 0)
      || a.code_name.localeCompare(b.code_name))
  if (coded.length === 0) return `${head}, and no coder coded one.`
  const named = coded.slice(0, FACILITATOR_CODES_SHOWN)
  const more = coded.length - named.length
  return `${head}; coded anyway: ${named
    .map(c => `${c.code_name} on ${c.facilitator_turns_coded}`)
    .join(', ')}${more > 0 ? ` and ${more} more ${more === 1 ? 'code' : 'codes'}` : ''}.`
}

// ── One comparable unit — no coefficient at all (#1505, D42) ───────────────

/**
 * Why a coefficient over ONE comparable unit is not computed, said once below the
 * Reliability tab's tables. The cell's own sentence is the app-wide
 * `insufficient_n` one (`lib/stat-format.ts`: "…after missing data was
 * excluded"), which is about a different shortage: here nothing was excluded —
 * over a single unit α is 0 whenever the coders differ, an identity rather than a
 * measurement (`services/reliability_basis.py::MIN_COMPARABLE_UNITS`).
 */
export const ONE_UNIT_NOTE =
  'No coefficient over a single unit: where only one passage was coded by two or more coders, α is 0 whenever they differ (and κ with it) and cannot be computed when they agree, which is arithmetic, not a measure of agreement.'

const INSUFFICIENT_N: UndefinedReason = 'insufficient_n'

/**
 * A row the note above is about: undefined for too few units, over exactly ONE.
 * A rating or set row over NO unit keeps the app-wide sentence, which is true of it.
 */
export function isOneUnitRow(row: { undefined_reason?: string | null; n_units: number }): boolean {
  return row.undefined_reason === INSUFFICIENT_N && row.n_units === 1
}

// ── The verdict — whether a coefficient may carry a band word (#1505) ──────

/**
 * Mirrors `services/reliability_basis.py::VERDICT_WITHHELD_*` (#1505, D43, 1.5.9).
 * Below the payload's `verdict_min_units` the server keeps a coefficient's value,
 * its *n* and its interval and WITHHOLDS the band word ("reliable", "moderate"),
 * stating why on the row. Krippendorff: α itself needs no minimum; reading it as
 * good or poor agreement is a decision about the data, and that decision does.
 *
 * ⚠️ The floor is NEVER restated here — it rides the payload (`verdict_min_units`)
 * and every sentence below takes it as an argument, so the server's constant is
 * the only one.
 */
export const VERDICT_WITHHELD_TOO_FEW_UNITS = 'too_few_units'

export type VerdictWithheldReason = typeof VERDICT_WITHHELD_TOO_FEW_UNITS

/** The words that stand where the band word would. A reason added to the union
 * without words is a compile error (the family's property (b)). */
const VERDICT_WITHHELD_WORD = {
  [VERDICT_WITHHELD_TOO_FEW_UNITS]: 'too few to judge',
} satisfies Record<VerdictWithheldReason, string>

/**
 * The word for a withheld verdict, or `null` when the row carries one (or the
 * payload predates the field). A reason this build does not know says only what
 * is on the screen — a number with no verdict — never a guessed cause.
 */
export function verdictWithheldWord(reason?: string | null): string | null {
  if (!reason) return null
  return (VERDICT_WITHHELD_WORD as Record<string, string>)[reason] ?? 'no verdict'
}

/**
 * One row's own count against the floor, for its accessible name and hover text:
 * `"7 of the 18 units a verdict needs"`. `null` unless the floor withheld it and
 * the payload states the floor.
 */
export function verdictShortfall(
  reason: string | null | undefined,
  nUnits: number | null | undefined,
  floor: number | null | undefined,
): string | null {
  if (reason !== VERDICT_WITHHELD_TOO_FEW_UNITS || nUnits == null || floor == null) return null
  return `${nUnits} of the ${floor} units a verdict needs`
}

/**
 * The explanation, said ONCE below a table rather than on every row it applies
 * to (the `ciUnavailableNote` idiom). Worded for the Reliability tab AND the
 * Model comparison: "coders" there includes the model, and it says "agreement",
 * never "reliability", which the Model comparison denies it reports. `null` for
 * an unknown reason or a payload without the floor — nothing is invented.
 */
export function verdictWithheldNote(
  reason: string | null | undefined,
  floor: number | null | undefined,
): string | null {
  if (reason !== VERDICT_WITHHELD_TOO_FEW_UNITS || floor == null) return null
  return `Too few to judge: a coefficient over fewer than ${floor} units judged by two or more coders is shown without a verdict. It can be computed from any number of units, but reading it as good or poor agreement is a decision about the data, and that needs more of it (the floor is taken from Krippendorff's minimum sample sizes, at the most lenient standard).`
}

/** The headline's own sentence, beside the largest number on the tab. */
export function overallVerdictWithheldNote(
  reason: string | null | undefined,
  floor: number | null | undefined,
): string | null {
  if (reason !== VERDICT_WITHHELD_TOO_FEW_UNITS || floor == null) return null
  return `Too few to judge: the overall α rests on fewer than ${floor} units judged by two or more coders, so it is shown without a verdict.`
}
