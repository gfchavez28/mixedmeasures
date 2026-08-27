/**
 * #525b — the reading half of the QQ plot's stated basis.
 *
 * The EIGHTH member of the STATED-BASIS FAMILY (see the internal design notes): the server
 * states how a figure was produced and the client DISPLAYS that, never
 * inferring it from the chart type.
 *
 * ## Why a QQ plot needs one at all
 *
 * 🔴 MEASURED against R 4.3.3, not recalled: `ppoints()` switches convention at
 * **n > 10** — `(i − 3/8)/(n + 1/4)` at or below it, `(i − 1/2)/n` above. So
 * "which plotting position" is not one choice, it is two selected by sample
 * size, in the reference implementation a researcher will reach for. A figure
 * that does not say which drew it is not reproducible.
 *
 * Constants are hand-mirrored with `services/qq_plot.py` — no codegen — so
 * `tests/test_qq_plot.py::TestCrossLanguageContract` reads THIS FILE and fails
 * on drift. TypeScript catches only the opposite direction.
 */

export const PLOTTING_POSITION_PPOINTS = 'r_ppoints_blom_hazen'
export const REFERENCE_LINE_QUARTILE = 'qqline_quartiles_type7'

export type PlottingPosition = typeof PLOTTING_POSITION_PPOINTS
export type ReferenceLine = typeof REFERENCE_LINE_QUARTILE

/**
 * ⚠️ `satisfies Record<…>` on purpose: a convention added to the backend without
 * a phrase here becomes a COMPILE error rather than falling through to silence.
 * That is the #42 `ci-label.ts` lesson — it was a ternary, so any method it did
 * not know rendered a bare, wrong label in the one module meant to prevent that.
 */
const POSITION_PHRASE = {
  [PLOTTING_POSITION_PPOINTS]:
    "Plotting positions follow R's ppoints() — (i − 3/8)/(n + ¼) for n ≤ 10, "
    + '(i − ½)/n above',
} satisfies Record<PlottingPosition, string>

const LINE_PHRASE = {
  [REFERENCE_LINE_QUARTILE]:
    "reference line through the first and third quartile pairs (R's qqline, type 7)",
} satisfies Record<ReferenceLine, string>

/**
 * The basis in words. An UNKNOWN convention is reported verbatim rather than
 * relabelled as a known one — a newer server must never have its positions
 * quietly described as ppoints().
 */
export function describeQQBasis(
  b: { plotting_position: string; reference_line: string } | null,
): string {
  if (!b) return ''
  const p = (POSITION_PHRASE as Record<string, string>)[b.plotting_position]
    ?? `Plotting positions: ${b.plotting_position}`
  const l = (LINE_PHRASE as Record<string, string>)[b.reference_line]
    ?? `reference line: ${b.reference_line}`
  return `${p}; ${l}.`
}

/**
 * How straight the line is, in words — the accessible reading of the picture.
 *
 * ⚠️ Deliberately NOT a verdict. The bands describe the FIGURE ("close to the
 * line"), never the decision ("your data is normal, use Mann–Whitney"): #525(c)
 * refused a recommendation engine, and the one place this project auto-picks a
 * test (#506) is where a real bug came from. Report; the researcher decides.
 */
export function describeStraightness(ppcc: number | null): string | null {
  if (ppcc == null || !Number.isFinite(ppcc)) return null
  if (ppcc >= 0.99) return 'points lie close to the line'
  if (ppcc >= 0.97) return 'points follow the line with visible departures'
  return 'points depart from the line'
}

/**
 * What the PICTURE shows, for a reader who cannot see it.
 *
 * A box plot's `sr-only` table works because its content IS five numbers; a Q–Q
 * plot's content is the shape of a cloud, and a 500-row table is an obstacle
 * rather than an equivalent. So this describes the shape.
 *
 * ⚠️ **It deliberately does NOT restate the figcaption.** A `<figcaption>` is
 * ordinary accessible text — it is read too — so the correlation value, the
 * basis, the thinning note and the singleton note all reach a screen reader
 * through it already. Heard live, an earlier draft announced `0.9935` and the
 * thinning count TWICE in consecutive sentences. Each channel says its own part
 * once: the caption carries the numbers, this carries what they look like.
 */
export function qqAccessibleSummary(q: {
  n: number
  ppcc: number | null
}): string {
  const straight = q.ppcc == null ? null : describeStraightness(q.ppcc)
  return `Normal Q–Q plot of ${q.n} model residual${q.n === 1 ? '' : 's'}`
    + `${straight ? `; ${straight}` : ''}.`
}
