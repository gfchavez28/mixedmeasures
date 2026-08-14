/**
 * #751 — how a VIRTUALISED listbox tells a screen reader how long it is.
 *
 * **The defect this exists to prevent.** A `role="listbox"` whose options are
 * rendered by react-virtuoso holds only the visible window in the DOM, so a
 * screen reader counting the listbox's children reports the WINDOW size as the
 * list length. Measured with NVDA on a 13-clip observation: it announced
 * `1 of 7`, and at a later probe the DOM held 2 options — so the number was not
 * merely wrong, it changed as the user scrolled. `aria-setsize` / `aria-posinset`
 * are the only way to state the real figures.
 *
 * **The rule that is easy to get wrong, and did get filed wrong.** `setSize` is
 * NOT "the total number of things that exist". It is the size of the set the user
 * can actually arrow through:
 *
 * - It is the **filtered** set when a search box is narrowing the list. Saying
 *   "of 13" while only 3 rows are reachable replaces one wrong number with
 *   another.
 * - It counts **options only**. `DocumentCodingWorkbench` interleaves
 *   `type: 'image'` rows into the same Virtuoso `data` array and renders them
 *   `role="presentation"` (deliberately outside the option set, #436) — so its
 *   set size is the SEGMENT count and its positions are ordinals among segments,
 *   never indices into `listItems`.
 *
 * **So derive both from the same array that drives the virtualiser, narrowed to
 * the options.** A separately-maintained "total" is two halves of one fact and
 * will drift (see `feedback_two_halves_of_one_fact` — three defects of that shape
 * shipped on 2026-08-10 alone).
 *
 * ⚠️ `position` is **1-based**, because ARIA is. Passing a 0-based index makes
 * every row off by one and the first row announce as "0 of n", which no reader
 * treats as an error.
 *
 * ⚠️ This is orthogonal to #701(c) — the dangling `aria-activedescendant` when the
 * active row scrolls out of the window. Adding set size neither fixes nor worsens
 * that; do not treat #751 as closing it.
 */
export interface OptionPositionAria {
  'aria-posinset': number
  'aria-setsize': number
}

/**
 * ARIA position attributes for one option in a virtualised listbox.
 *
 * @param position 1-BASED position within the navigable option set.
 * @param setSize  Size of that same set (filtered, options only).
 */
export function optionPositionAria(position: number, setSize: number): OptionPositionAria {
  return { 'aria-posinset': position, 'aria-setsize': setSize }
}

/**
 * Ordinals for an option set that is a SUBSET of the virtualiser's data array.
 *
 * Returns a `Map` from the option's own key to its 1-based ordinal among options,
 * so a row can look its position up in O(1) instead of an O(n) `findIndex` per
 * render (a 2000-clip recording renders ~20 rows per frame, which is 40k
 * comparisons a frame the naive way).
 *
 * Build it from the array that drives the list, in the same order.
 */
export function optionOrdinals<T>(options: readonly T[], keyOf: (item: T) => number): Map<number, number> {
  const map = new Map<number, number>()
  options.forEach((item, i) => map.set(keyOf(item), i + 1))
  return map
}
