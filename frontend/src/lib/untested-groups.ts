/**
 * The groups a comparison row SHOWS and its tests leave out (#1329, 1.5.9, D51).
 *
 * A group holding values, but fewer than its row's test needs (one value, for
 * a t-test or an ANOVA, which estimate each group's variance), is listed in the
 * table — its n, mean and median — and left out of every test of the row: the
 * F, Tukey's post hoc, the Welch t and Levene's check. The server decides which
 * (`services/testable_groups.py::split_testable`) and sends them as
 * `untested_groups`; the client says so and never re-derives it from the
 * sizes, so the sentence and the test cannot disagree about who was tested.
 */

function list(groups: string[]): string {
  if (groups.length <= 1) return groups.join('')
  return `${groups.slice(0, -1).join(', ')} and ${groups[groups.length - 1]}`
}

/**
 * The sentence for one row, or `null` when it leaves nobody out (or the
 * payload predates the field). `variable` prefixes it when a table holds
 * several rows, so the reader knows which row it is about.
 */
export function untestedGroupsNote(
  groups: string[] | null | undefined,
  variable?: string,
): string | null {
  if (!groups || groups.length === 0) return null
  const one = groups.length === 1
  const sentence = `${list(groups)} ${one ? 'has' : 'have'} only one value${one ? '' : ' each'}, `
    + `so ${one ? 'it is' : 'they are'} shown without an SD and left out of the tests.`
  return variable ? `${variable}: ${sentence}` : sentence
}

/**
 * #1549 (b) — the Q–Q plot's own sentence for the groups of one it left out
 * (`QQSummary.singleton_groups`). The plot follows the PARAMETRIC tests' groups,
 * because normality is their model's assumption, so it names them even when the
 * row runs the rank test, which uses them and whose note then names nobody.
 */
export function qqLeftOutNote(groups: string[] | null | undefined): string | null {
  if (!groups || groups.length === 0) return null
  const one = groups.length === 1
  return `${list(groups)} ${one ? 'has' : 'have'} only one value${one ? '' : ' each'}, `
    + `so ${one ? 'it is' : 'they are'} left out of this plot: a single value's residual is 0 by construction.`
}

/** The SD cell's title when a group has no SD because it holds one value. */
export const SINGLE_VALUE_SD_NOTE = 'No SD — a single value has no spread'
