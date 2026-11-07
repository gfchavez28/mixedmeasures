/**
 * #1323 — the reading half of the code-by-group comparison's STATED BASIS: what was
 * counted (the UNIT), how it was tested, and how the p-values were corrected.
 *
 * The THIRTEENTH member of the stated-basis family (the internal design notes
 * §2): the server states it on every response (`basis`), and this module turns it
 * into words. It never infers the unit from which screen it is on.
 *
 * Constants are hand-mirrored with `services/comparison_basis.py` and
 * `services/multiplicity.py` — no codegen — so
 * `tests/test_comparison_unit_1323.py::TestCrossLanguageContract` reads THIS FILE.
 * The `satisfies Record<…>` maps make a variant added here without words a COMPILE
 * error; a variant a newer server sends that this build does not know is named
 * verbatim rather than relabelled.
 */
import type { ComparisonInterval, DemographicComparisonResponse } from '@/lib/api'
import { ciCaveat, ciLabel, ciLevelPercent, ciQualifier } from '@/lib/ci-label'

export const COMPARISON_UNIT_PARTICIPANT = 'participant'
export const COMPARISON_UNIT_PASSAGE = 'passage'
export type ComparisonUnit = typeof COMPARISON_UNIT_PARTICIPANT | typeof COMPARISON_UNIT_PASSAGE

export const CORRECTION_HOLM = 'holm'
export const CORRECTION_BH = 'bh'
export const CORRECTION_NONE = 'none'
export const CORRECTION_DISCRETE_HOLM = 'discrete_holm'
export type ComparisonCorrection =
  | typeof CORRECTION_HOLM
  | typeof CORRECTION_BH
  | typeof CORRECTION_NONE
  | typeof CORRECTION_DISCRETE_HOLM

export const TEST_FISHER_EXACT = 'fisher_exact'
export const TEST_FREEMAN_HALTON = 'freeman_halton'
export const TEST_FREEMAN_HALTON_MC = 'freeman_halton_monte_carlo'
export type ComparisonTestMethod =
  | typeof TEST_FISHER_EXACT
  | typeof TEST_FREEMAN_HALTON
  | typeof TEST_FREEMAN_HALTON_MC

export type ComparisonTestOmitted = 'passage_unit' | 'insufficient_groups' | 'universal_code' | 'no_variance'

/** The unit's noun, singular and plural — "3 participants", "1 passage". */
const UNIT_NOUN = {
  [COMPARISON_UNIT_PARTICIPANT]: ['participant', 'participants'],
  [COMPARISON_UNIT_PASSAGE]: ['passage', 'passages'],
} satisfies Record<ComparisonUnit, [string, string]>

/** What a count means, said once under the table and the bar. */
const UNIT_SENTENCE = {
  [COMPARISON_UNIT_PARTICIPANT]:
    'Each participant counts once: a participant used a code when at least one of their passages in the material compared carries it. The share is of the participants in the group who have material here.',
  [COMPARISON_UNIT_PASSAGE]:
    'Counts passages. Passages from one participant are not independent, so no test is shown.',
} satisfies Record<ComparisonUnit, string>

/** The correction's NAME — a table heading, an export column. */
const CORRECTION_NAME = {
  [CORRECTION_HOLM]: 'Holm',
  [CORRECTION_BH]: 'Benjamini–Hochberg',
  [CORRECTION_NONE]: 'no correction',
  [CORRECTION_DISCRETE_HOLM]: 'discrete Holm',
} satisfies Record<ComparisonCorrection, string>

/** The correction as the method note says it — the name, and for discrete Holm what it does. */
const CORRECTION_WORDS = {
  [CORRECTION_HOLM]: 'Holm',
  [CORRECTION_BH]: 'Benjamini–Hochberg',
  [CORRECTION_NONE]: 'no correction',
  [CORRECTION_DISCRETE_HOLM]: 'discrete Holm, which leaves out codes these group sizes cannot test',
} satisfies Record<ComparisonCorrection, string>

const TEST_WORDS = {
  [TEST_FISHER_EXACT]: 'Fisher’s exact test',
  [TEST_FREEMAN_HALTON]: 'Freeman–Halton exact test',
  [TEST_FREEMAN_HALTON_MC]: 'Freeman–Halton test (seeded Monte Carlo estimate)',
} satisfies Record<ComparisonTestMethod, string>

const OMITTED_WORDS = {
  passage_unit: 'Passages are counted for description only, so no test is run.',
  insufficient_groups: 'Fewer than two groups have participants with material here, so no test is run.',
  universal_code: 'Not tested: a universal code marks the transcript, not a finding.',
  no_variance: 'Not tested: nobody, or everybody, in the groups compared used it.',
} satisfies Record<ComparisonTestOmitted, string>

/**
 * D13 (the 1.5.9 review): the literature's main point is restraint — numbers from a
 * qualitative study describe the people studied, and a small study's silence is not
 * a finding. Said whenever a test ran.
 */
export const COMPARISON_RESTRAINT_SENTENCE =
  'These tests are exploratory and describe the participants studied; a code without a star is not evidence that the groups do not differ.'

/** "3 participants" / "1 passage"; an unknown unit is named verbatim. */
export function unitCount(unit: string | undefined, n: number): string {
  const nouns = (UNIT_NOUN as Record<string, [string, string]>)[unit ?? '']
  if (!nouns) return `${n} ${unit ?? ''}`.trim()
  return `${n} ${n === 1 ? nouns[0] : nouns[1]}`
}

/** The correction's name for a heading — an unknown one is named verbatim. */
export function correctionName(correction: string): string {
  return (CORRECTION_NAME as Record<string, string>)[correction] ?? correction
}

export function describeOmittedTest(reason: string | null | undefined): string | null {
  if (!reason) return null
  return (OMITTED_WORDS as Record<string, string>)[reason] ?? `No test: ${reason}.`
}

/**
 * The method note under the comparison — the unit, the test and the correction,
 * all read from the payload. `null` for a payload that predates the basis (an old
 * server must not be relabelled as participants).
 */
export function comparisonMethodNote(data: DemographicComparisonResponse): string | null {
  const basis = data.basis
  if (!basis) return null
  const parts: string[] = []
  parts.push((UNIT_SENTENCE as Record<string, string>)[basis.unit] ?? `Unit: ${basis.unit}.`)
  if (basis.test_omitted_reason) {
    const why = describeOmittedTest(basis.test_omitted_reason)
    if (why && basis.test_omitted_reason !== 'passage_unit') parts.push(why)
    return parts.join(' ')
  }
  const methods = new Set(data.codes.map(c => c.test?.method).filter((m): m is string => !!m))
  const testWords = [...methods].map(m => (TEST_WORDS as Record<string, string>)[m] ?? m).join(' / ')
  if (testWords) parts.push(`Test: ${testWords}${basis.tested_groups.length < data.groups.length ? `, over ${basis.tested_groups.join(', ')}` : ''}.`)
  // D3: said whenever a Δ carries an interval — the one number on the row that is NOT adjusted.
  const ci = data.codes.find(c => c.delta_ci)?.delta_ci
  if (ci) {
    parts.push(
      `Δ is the difference between the two groups’ shares, with its ${ciLevelPercent(ci.level)}% interval in brackets (Newcombe); the interval is not adjusted for the number of codes.`,
    )
  }
  const corr = (CORRECTION_WORDS as Record<string, string>)[basis.correction] ?? basis.correction
  if (basis.family_size > 0) {
    parts.push(
      basis.correction === CORRECTION_NONE
        ? `p is not corrected for the ${basis.family_size} codes tested.`
        : `p is adjusted across the ${basis.family_size} code${basis.family_size === 1 ? '' : 's'} tested (${corr}); the stars read the adjusted p.`,
    )
    // #1323 rider: said whenever SOME code cannot reach significance at these sizes —
    // at 6 v 6 with plain Holm over 40 codes, that is every code.
    const unreachable = basis.family_size - basis.family_reachable
    if (unreachable > 0) {
      parts.push(
        basis.family_reachable === 0
          ? 'With these group sizes no code can reach p < .05 after the adjustment, whatever the data.'
          : `${unreachable} of the ${basis.family_size} codes cannot reach p < .05 after the adjustment with these group sizes; they are marked.`,
      )
    }
    parts.push(COMPARISON_RESTRAINT_SENTENCE)
  }
  return parts.join(' ')
}

/** A share difference in percentage points, one decimal — formatted EXACTLY as the Δ
 *  beside it is (`toFixed`, an ASCII minus), so one cell never shows two minus signs
 *  or rounds a half two ways (DRIVEN 2026-10-31b: a true minus and `Math.round` put
 *  `-33.3pp` over `[−79.2, …]`, and ±0.7935 as −79.3 and 79.4). `-0.0` prints `0.0`. */
function percentagePoints(value: number): string {
  const text = (value * 100).toFixed(1)
  return text === '-0.0' ? '0.0' : text
}

/**
 * D3 — Δ's interval for the EYE, `[-5.2, 41.0]` in percentage points. Render it
 * `aria-hidden`: a reader says "left bracket … comma", and the spoken form is
 * `deltaIntervalSpoken` (#43's rule in `reliability-interval.ts`).
 */
export function deltaIntervalVisual(ci: ComparisonInterval | null | undefined): string | null {
  if (!ci) return null
  return `[${percentagePoints(ci.lower)}, ${percentagePoints(ci.upper)}]`
}

/** D3 — what a reader hears: "95% confidence interval -5.2 to 41.0 percentage points (unadjusted)". */
export function deltaIntervalSpoken(ci: ComparisonInterval | null | undefined): string | null {
  if (!ci) return null
  return `${ciLevelPercent(ci.level)}% confidence interval ${percentagePoints(ci.lower)} to ${percentagePoints(ci.upper)} percentage points${ciQualifier(ci.method)}`
}

/** D3 — the Δ cell's title: the interval's label and its caveat, from `ci-label.ts`. */
export function deltaIntervalTitle(ci: ComparisonInterval | null | undefined): string | null {
  if (!ci) return null
  const caveat = ciCaveat(ci.method)
  return `${ciLabel(ci.method, ci.level)}: ${percentagePoints(ci.lower)} to ${percentagePoints(ci.upper)} percentage points.${caveat ? ` ${caveat}` : ''}`
}

/** The per-code marker: `true` only when the server says the code CANNOT reach significance. */
export function cannotReachSignificance(test: { can_reach_significance?: boolean | null } | null): boolean {
  return test?.can_reach_significance === false
}

/** The sentence that says what was counted and what was left out (#1297/#1298). */
export function comparisonScopeSentence(data: DemographicComparisonResponse): string | null {
  const s = data.scope
  if (!s) return null
  const counted: string[] = []
  if (s.conversations) counted.push(`${s.conversations} conversation${s.conversations === 1 ? '' : 's'}`)
  if (s.documents) counted.push(`${s.documents} document${s.documents === 1 ? '' : 's'}`)
  if (s.text_columns) counted.push(`${s.text_columns} open-text question${s.text_columns === 1 ? '' : 's'}`)
  const out: string[] = [counted.length ? `Counts ${counted.join(', ')}.` : 'No material with a participant link is selected.']
  if (s.observations_left_out) out.push(`${s.observations_left_out} observation${s.observations_left_out === 1 ? ' is' : 's are'} left out: recordings have no participant link.`)
  if (s.unassigned_passages) out.push(`${s.unassigned_passages} passage${s.unassigned_passages === 1 ? ' has' : 's have'} no linked participant and ${s.unassigned_passages === 1 ? 'is' : 'are'} not counted.`)
  if (s.participants_without_group) out.push(`${s.participants_without_group} participant${s.participants_without_group === 1 ? ' has' : 's have'} material but no value for this variable.`)
  return out.join(' ')
}
