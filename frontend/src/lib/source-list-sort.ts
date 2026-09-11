/**
 * The order a source list is RENDERED in (#932).
 *
 * The Conversations and Documents lists each offer the same three orderings —
 * name, date, coding progress — and each hand-rolled the same comparator. Two of
 * the three tie constantly: **every uncoded source has progress 0**, and a batch
 * import gives every file ONE `created_at`, because the column defaults to
 * SQLite's `CURRENT_TIMESTAMP`, which has second precision. Measured 2026-09-11:
 * 14 of 14 documents on the `pd_audit` corpus share a single `created_at`; 4 on
 * `dev.db`.
 *
 * 🔴 **A tied comparator is not "unordered" — `Array.sort` is stable, so it
 * renders whatever order the SERVER happened to return.** For documents that is
 * `Document.updated_at.desc()`, so touching ANY field of a document moves its
 * card to the top of a list the researcher is working down. That is #932's real
 * mechanism, and it is not the one the entry filed ("the write moves the sort
 * key"): the client's key is `created_at`, which a subject change cannot move.
 * The client's key never moved; the SERVER's did, and the tie let it through.
 *
 * ⚠️ **Conversations and datasets are served `created_at.desc()`, so they do not
 * reshuffle today.** The tie-break is applied there too because the missing
 * property is the same one — a rendered order must not depend on an incidental
 * server ordering — and one list having it is how the two drift.
 *
 * The tie-break is `id`, i.e. the order things were added, which is the only
 * stable key these rows carry. It rides the direction flip with everything else,
 * so a descending list shows the most recently added of a tied batch first.
 */

export type SourceSortKey = 'name' | 'date' | 'progress'
export type SortDirection = 'asc' | 'desc'

/** The fields both lists' items share. */
export interface SortableSource {
  id: number
  name: string
  segment_count: number
  coded_segment_count: number
}

/** Coding progress as a fraction, 0 when there is nothing to code. */
export function sourceProgress(item: SortableSource): number {
  return item.segment_count > 0 ? item.coded_segment_count / item.segment_count : 0
}

/**
 * Compare two sources for display.
 *
 * `dateOf` is the caller's because the two lists disagree about what "date"
 * means: a conversation prefers the researcher-entered `conversation_date` and
 * falls back to `created_at`; a document has only `created_at`.
 */
export function compareSources<T extends SortableSource>(
  a: T,
  b: T,
  sortBy: SourceSortKey,
  sortDir: SortDirection,
  dateOf: (item: T) => string,
): number {
  let cmp: number
  if (sortBy === 'name') {
    cmp = a.name.localeCompare(b.name)
  } else if (sortBy === 'date') {
    cmp = new Date(dateOf(a)).getTime() - new Date(dateOf(b)).getTime()
  } else {
    cmp = sourceProgress(a) - sourceProgress(b)
  }
  // ⚠️ **This is a READABILITY choice, not a correctness one, and the first
  // version of this comment claimed otherwise.** `cmp || (a.id - b.id)` behaves
  // identically for every value the branches above can produce — `0`, `-0` and
  // the `NaN` an unparseable date gives are all falsy, so both forms fall
  // through to the tie-break in both directions. Mutation-proved: swapping them
  // leaves every case in `source-list-sort.test.ts` green. Stated because a
  // reader looking for the reason should not invent a sharper one than exists.
  if (!Number.isFinite(cmp) || cmp === 0) cmp = a.id - b.id
  return sortDir === 'asc' ? cmp : -cmp
}

/** The whole list, in display order. Does not mutate its input. */
export function sortSources<T extends SortableSource>(
  items: readonly T[],
  sortBy: SourceSortKey,
  sortDir: SortDirection,
  dateOf: (item: T) => string,
): T[] {
  return [...items].sort((a, b) => compareSources(a, b, sortBy, sortDir, dateOf))
}
