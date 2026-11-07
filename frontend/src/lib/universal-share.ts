/**
 * #1526 D79 (1.5.9) — why a universal code's row has counts and no share of the coded total.
 *
 * By invariant J-A a passage or answer marked ONLY with universal codes ("Unclear",
 * "Unsubstantive/Artifact") is not coded, so it is outside the coded total that the summary
 * table's *% of Coded* and *% Texts* divide by — while a universal code's own count is made of
 * exactly such units. Printed over that total it read 150–200% on the #1526 review's probe.
 * The rule the literature gives (a survey-tabulation manual, verified at the source): an element
 * left out of a base shows its COUNT, never a percentage of that base.
 *
 * Decided where the share is computed — `qual-chart-data.ts::codedSharePercent` — and said ONCE
 * under the table (`QualSummaryTable`), which the analysis view, its PNG and the Canvas embed
 * all render. Since #1528 (1.5.9) the Frequencies CSV is that table's rows, written in the
 * browser (`qual-summary-columns.ts::codeSummaryCsv`), and says THIS constant too — the server's
 * copy went with the server file, so there is one statement of it.
 *
 * ⚠️ The other shares on a universal row (% Conv., % Docs, % Obs., % Part., % Rec.) keep their
 * numbers: their bases are what the SELECTION holds (#749), which a marked unit belongs to.
 */
export const UNIVERSAL_SHARE_NOTE = 'A passage or answer marked only with universal codes (such as Unclear) is not counted as coded, so universal codes have no share of the coded total; their counts are shown.'

/** What a withheld cell says to a screen reader, after its visible "—" (IrrMatrix's shape). */
export const UNIVERSAL_SHARE_CELL = 'no share: a universal code'

/**
 * #1529 D92 (1.5.9) — what a chart drawing a share of the coded total (*Proportion · Coded only*)
 * says about the universal rows it leaves off (`qual-chart-data.ts::codedShareAxis`): it NAMES
 * them, because a row left off without a word is a row dropped (#830g), and says why in the table
 * note's words. `null` when nothing was left off.
 *
 * ⚠️ No instruction ("choose *All segments*…"): the same charts render on the Canvas and in its
 * exports, where there are no chart options, so an instruction would be false there (the
 * `ChartFigure` caption rule).
 */
export function universalChartNote(leftOut: readonly string[]): string | null {
  if (leftOut.length === 0) return null
  const names = leftOut.length === 1
    ? leftOut[0]
    : `${leftOut.slice(0, -1).join(', ')} and ${leftOut[leftOut.length - 1]}`
  return `${names} ${leftOut.length === 1 ? 'is' : 'are'} not drawn: a passage or answer marked only with universal codes is not counted as coded, so universal codes have no share of the coded total.`
}
