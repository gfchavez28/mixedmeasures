/**
 * #1608 — what a blind coder is told where the participant table's rating columns were
 * left out. A participant score is one shared snapshot of every coder's ratings, so it
 * cannot follow a viewer: while blind the server leaves those columns out of the Data
 * view and the Participants page's profile (and out of the files — the server says it
 * there, `participant_scores.RATING_COLUMNS_WITHHELD_NOTE`).
 */
export function withheldRatingColumnsNotice(count: number): string | null {
  if (!count) return null
  const what = count === 1 ? '1 rating column is' : `${count} rating columns are`
  return `${what} hidden while blind. ${WITHHELD_RATING_COLUMNS_REASON}`
}

const WITHHELD_RATING_COLUMNS_REASON =
  "A participant score combines every coder's ratings, so it would show your colleagues' judgements."

/**
 * #1701 (D381) — the same notice where the count is not one number: Text Coding's By Text
 * table reads each record's context apart, and texts from more than one dataset can withhold
 * different counts. Agreeing contexts are counted; disagreeing ones are said without a number.
 * `counts` are the LOADED contexts' `withheld_rating_columns` — an empty list says nothing.
 */
export function withheldRatingColumnsNoticeAcross(counts: readonly number[]): string | null {
  const withheld = counts.filter(n => n > 0)
  if (withheld.length === 0) return null
  if (withheld.length === counts.length && withheld.every(n => n === withheld[0])) {
    return withheldRatingColumnsNotice(withheld[0])
  }
  return `Rating columns are hidden while blind. ${WITHHELD_RATING_COLUMNS_REASON}`
}

/**
 * #1691 (D377) — the *Variables N* badge counts every variable in the dataset, on both views.
 * The Variables view lists them all (a score among them, its values withheld); the Data view's
 * `/data` leaves a blind viewer's rating columns out and counts them, so it adds them back —
 * the server's `withheld` set is drawn from this dataset's own columns
 * (`participant_scores.withheld_rating_column_ids`), pinned against the columns list by
 * `test_variables_tab_count_1691.py`. The Data view's notice says the rest (R6).
 */
export function variablesInDataset(shown: number, withheld: number | undefined): number {
  return shown + (withheld ?? 0)
}

/**
 * #1675 D358 — the Data view's variable-group score columns while blind: a group holding a
 * participant score is left out (its scale score averages every coder's ratings), counted by
 * the server (`withheld_rating_variables`).
 */
export function withheldGroupScoresNotice(count: number): string | null {
  if (!count) return null
  const what = count === 1 ? "1 variable group's score is" : `${count} variable groups' scores are`
  return `${what} hidden while blind. A group holding a participant score combines every coder's ratings, so it would show your colleagues' judgements.`
}

/** #1615 — the Variables view's *Observed values* for a score (or a variable built from one). */
export const WITHHELD_VALUES_NOTICE =
  "Observed values are hidden while blind. A participant score combines every coder's ratings, so its values would show your colleagues' judgements."

/** #1615 — the computed-variable dialog's preview over a score. */
export const WITHHELD_PREVIEW_NOTICE =
  "The preview is hidden while blind: this expression reads a participant score, which combines every coder's ratings."

/**
 * #1615 — what the Quantitative page says when its SELECTION names a rating score the viewer
 * cannot see (a link, back/forward, a Material saved before blind mode was on). The server
 * leaves the score out of every chart, test and table on the page; this says so once, above
 * them, in the same words.
 */
export function withheldSelectionNotice(count: number): string | null {
  if (!count) return null
  const what = count === 1 ? '1 selected variable is a rating score' : `${count} selected variables are rating scores`
  return `${what}, left out while blind. A participant score combines every coder's ratings, so it would show your colleagues' judgements.`
}

/**
 * #1615 D286 — a joint display whose quotes are attributed with a column worked out from
 * participant scores, read while blind: each quote keeps who said it and where, and the column's
 * value is left out (`column_withheld`, the server's). Said in the Compact view's notes and in the
 * report's note (`buildJointDisplayReport`), so the Report view and every export carry it.
 */
export function withheldAttributionNote(columnName: string): string {
  return `${columnName} is left out of the quotes' attribution while blind: it comes from participant scores, which combine every coder's ratings.`
}

/** D286 — the column's name to say, read from the pins' answer; null when nothing was left out. */
export function withheldAttributionColumn(
  answer: { column_withheld?: boolean; column_name?: string | null } | null | undefined,
): string | null {
  if (!answer?.column_withheld) return null
  // The server names it whenever it withholds; the fallback only keeps the note from vanishing.
  return answer.column_name || 'The variable shown beside each quote'
}

/**
 * #1615 D295 — a door's OWN count (`withheld_rating_variables`, the server's) said in the
 * selection line's words when it is MORE than that line already said. The list's marks can miss
 * what a door left out (a metric's sibling grouping column in another dataset, D272's exact read
 * set), so the page says the server's number rather than one it re-derived; a door that left
 * out no more than the selection line counted says nothing (the line above already did).
 */
export function withheldDoorNotice(doorCount: number | null | undefined, selectionCount: number): string | null {
  if (!doorCount || doorCount <= selectionCount) return null
  return withheldSelectionNotice(doorCount)
}
