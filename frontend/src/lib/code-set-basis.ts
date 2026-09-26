/**
 * Row 48 — the reading half of a code set's STATED BASIS: what the UNIT SET was
 * when the set's α was computed.
 *
 * The TWELFTH member of the STATED-BASIS FAMILY (the internal design notes):
 * the server states how a number was produced and the client DISPLAYS that,
 * never inferring it from which screen it is rendering.
 *
 * ## Why a set α needs a unit-set basis
 *
 * A code set asks *which one of these values does this unit take?* — and the
 * answer for a unit where the coder chose nothing depends on a decision the
 * researcher made about the SET, not about the data:
 *
 * - **inclusive** — the blank IS a value, "none of these". It enters the
 *   coincidence matrix as its own category, and two coders who both left a unit
 *   blank AGREE about it.
 * - **exhaustive** — the blank is MISSING DATA. The unit contributes only the
 *   coders who chose, and a coder who chose nothing is not a voter for it.
 *
 * The same coders on the same corpus produce DIFFERENT numbers under the two,
 * and nothing in the figure says which. So the payload says, and this module
 * turns that into words.
 *
 * Constants are hand-mirrored with `services/code_sets.py` — no codegen — so
 * `tests/test_code_set_basis.py::TestCrossLanguageContract` reads THIS FILE and
 * fails on drift. TypeScript catches only the opposite direction.
 */

/** Mirrors `SET_BASIS_EXHAUSTIVE_WITH_MISSING` / `SET_BASIS_INCLUSIVE_WITH_NONE`. */
export const SET_BASIS_EXHAUSTIVE_WITH_MISSING = 'exhaustive_with_missing'
export const SET_BASIS_INCLUSIVE_WITH_NONE = 'inclusive_with_none'

export type SetBasis =
  | typeof SET_BASIS_EXHAUSTIVE_WITH_MISSING
  | typeof SET_BASIS_INCLUSIVE_WITH_NONE

/**
 * 🔴 Mirrors `code_sets.SET_NONE`. A cell holding this is the value "none of
 * these", never a code id — `codes.id` is a positive autoincrement, so the
 * negative sentinel can never name a real member.
 */
export const SET_NONE = -1

/**
 * ⚠️ `satisfies Record<…>` on purpose: a basis added to the union with no words
 * fails the build, while one this build does not know is reported verbatim
 * (correct for a newer server) — the two unknowns stay separate.
 */
const BASIS_QUALIFIER = {
  [SET_BASIS_EXHAUSTIVE_WITH_MISSING]: 'blanks treated as missing',
  [SET_BASIS_INCLUSIVE_WITH_NONE]: 'blanks counted as “none of these”',
} satisfies Record<SetBasis, string>

const BASIS_SENTENCE = {
  [SET_BASIS_EXHAUSTIVE_WITH_MISSING]:
    'This set is exhaustive, so a unit where a coder chose no value is treated as missing data: it contributes only the coders who did choose, and nobody is counted as having said “none of these”.',
  [SET_BASIS_INCLUSIVE_WITH_NONE]:
    'This set is not exhaustive, so a unit where a coder chose no value counts as the real answer “none of these” — two coders who both left it blank agree about it.',
} satisfies Record<SetBasis, string>

/**
 * The short qualifier for a label, or `null` for an absent basis — an older
 * payload predating the field must not be relabelled, because inventing a basis
 * for a number we cannot identify is the failure this module exists to prevent.
 * An unknown-but-present value is named rather than dropped.
 */
export function setBasisQualifier(basis?: string | null): string | null {
  if (!basis) return null
  return (BASIS_QUALIFIER as Record<string, string>)[basis] ?? basis
}

/** The one-sentence explanation for a visible explainer; `null` when absent. */
export function describeSetBasis(basis?: string | null): string | null {
  if (!basis) return null
  return (BASIS_SENTENCE as Record<string, string>)[basis] ?? `Unit-set basis: ${basis}.`
}

/**
 * The words for one axis value of a set's confusion matrix.
 *
 * ⚠️ Takes the server's `value_names` map rather than deriving "None of these"
 * here: the sentinel's label is a DISPLAY string the payload already carries,
 * and a second spelling is how a rendered table and its own export start
 * disagreeing (`MISSING_GROUP_LABEL`'s rule, one surface over).
 */
export function setValueLabel(
  value: number,
  valueNames: Record<string, string> | undefined,
): string {
  return valueNames?.[String(value)] ?? String(value)
}
