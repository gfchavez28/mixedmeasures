/**
 * What `aria-sort` says about one table column (#1465, D129) — beside
 * `components/ui/sortable-column-header.tsx`, which renders it. Here rather than
 * there because a component module that also exports a function loses Fast
 * Refresh (`react-refresh/only-export-components`).
 */

/** A table's own direction vocabulary. */
export type SortDir = 'asc' | 'desc'

/** What `aria-sort` says about one column. */
export type ColumnSort = 'ascending' | 'descending' | undefined

/**
 * One column's `aria-sort`: stated on the sorted column, absent on the rest —
 * the APG sortable-table pattern. `none` on every other column says nothing the
 * absence does not.
 */
export function columnSort(sorted: boolean, dir: SortDir): ColumnSort {
  if (!sorted) return undefined
  return dir === 'asc' ? 'ascending' : 'descending'
}
