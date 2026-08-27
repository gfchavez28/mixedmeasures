/**
 * #522b — the reading half of the box plot's stated basis.
 *
 * A member of the STATED-BASIS FAMILY (see the internal design notes): the server states how a
 * number was produced and the client DISPLAYS that, never inferring it. A box
 * plot is uninterpretable without knowing which quartile definition drew it —
 * several exist and they disagree on small samples — and a reader meeting the
 * figure in a paper has no other way to find out.
 *
 * The constants are hand-mirrored with `services/comparisons.py`; there is no
 * codegen, so `tests/test_box_summary.py::TestCrossLanguageContract` reads THIS
 * FILE and fails on drift. TypeScript catches only the opposite direction.
 */

export const QUARTILE_METHOD_TYPE7 = 'type7_linear'
export const WHISKER_RULE_TUKEY = 'tukey_1_5_iqr'

export type QuartileMethod = typeof QUARTILE_METHOD_TYPE7
export type WhiskerRule = typeof WHISKER_RULE_TUKEY

/**
 * ⚠️ `satisfies Record<…>` on purpose: a method added to the backend without a
 * phrase here becomes a COMPILE error rather than falling through to silence.
 * That is the #42 `ci-label.ts` lesson — it was a ternary, so any method it did
 * not know rendered a bare, wrong label in the one module meant to prevent that.
 */
const QUARTILE_PHRASE = {
  [QUARTILE_METHOD_TYPE7]:
    'Quartiles by linear interpolation (type 7 — R, numpy and pandas default)',
} satisfies Record<QuartileMethod, string>

const WHISKER_PHRASE = {
  [WHISKER_RULE_TUKEY]:
    'whiskers to the furthest point within 1.5 × IQR; points beyond are drawn individually',
} satisfies Record<WhiskerRule, string>

/**
 * The basis in words. An UNKNOWN convention is reported verbatim rather than
 * relabelled as a known one — a newer server must never have its method quietly
 * described as type 7.
 */
export function describeBoxBasis(
  b: { quartile_method: string; whisker_rule: string } | null,
): string {
  if (!b) return ''
  const q = (QUARTILE_PHRASE as Record<string, string>)[b.quartile_method]
    ?? `Quartiles: ${b.quartile_method}`
  const w = (WHISKER_PHRASE as Record<string, string>)[b.whisker_rule]
    ?? `whiskers: ${b.whisker_rule}`
  return `${q}; ${w}.`
}
