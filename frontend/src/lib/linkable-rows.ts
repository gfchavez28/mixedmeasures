// The participant panel's record picker: what a record's row says, and what the
// picker says about the list (#418, #1053).
//
// 🔴 #1053 — the SEARCH lives on the server now. The picker used to load every
// record of the dataset with a lowercased copy of every value and filter them
// here (`filterLinkableRows`): 70 s and 72 MB on a 75,699-record survey, which
// never loaded at all under the client's 30 s limit. `GET …/linkable-rows?q=`
// answers ONE ranked page and the total, so nothing here matches anything.
import type { LinkableRow } from './api/participants'

/** One page. The server's `LINKABLE_PAGE_SIZE` — mirrored, and pinned by
 *  `backend/tests/test_linkable_rows_search.py`. */
export const RECORD_PAGE_SIZE = 50
/** The server refuses a longer term (`MAX_SEARCH_TERM_LENGTH`, 422); the box
 *  stops there instead. Mirrored and pinned the same way. */
export const RECORD_SEARCH_MAX_LENGTH = 200
/** Typing pauses this long before the search is asked — a term is one request,
 *  not one per keystroke. */
export const RECORD_SEARCH_DEBOUNCE_MS = 300

/** Names what the search reaches: the record id, a name, and EVERY answer (#418). */
export const RECORD_SEARCH_PLACEHOLDER = 'Search by record ID, name or any answer…'

/** Secondary label text shown after the record id. */
export function linkableRowDetail(row: LinkableRow): string {
  return row.display_values.join(' · ')
}

/** Which value matched, when the label does not show it: `Marital status: …never married…`. */
export function linkableRowMatch(row: LinkableRow): string | null {
  return row.matched ? `${row.matched.column_label}: ${row.matched.excerpt}` : null
}

const records = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'record' : 'records'}`

/**
 * The picker's count line — its one `role="status"`, and the search box's
 * description. Two empty answers are two different facts (#963 Tier 2): a
 * search that matched nothing, and a dataset with no records. A bounded page
 * says it is bounded and what reaches the rest (`pickerLimitNote`'s rule).
 */
export function recordPickerCount(
  shown: number,
  total: number,
  term: string,
  datasetName: string,
): string {
  const searching = term.trim() !== ''
  if (total === 0) {
    return searching
      ? `No records in ${datasetName} match “${term.trim()}”.`
      : 'This dataset has no records.'
  }
  if (shown >= total) {
    return searching ? `${records(total)} ${total === 1 ? 'matches' : 'match'}.` : `${records(total)}.`
  }
  return searching
    ? `Showing ${shown.toLocaleString()} of ${records(total)} that match. Keep typing to narrow the list.`
    : `Showing ${shown.toLocaleString()} of ${records(total)}. Search to find the others.`
}

/** While the rows on screen are the PREVIOUS search's (#1038 i's treatment). */
export const RECORD_PICKER_SEARCHING = 'Searching…'

/** A next page that failed keeps the pages in hand, so the list reads `ready`
 *  and only this sentence says it (`list-load-state.md` §1). */
export const RECORD_PICKER_MORE_FAILED =
  'The next records could not be loaded. Press Show more to try again.'

/** How many the next press of *Show more* adds. */
export function showMoreCount(shown: number, total: number): number {
  return Math.max(0, Math.min(RECORD_PAGE_SIZE, total - shown))
}
