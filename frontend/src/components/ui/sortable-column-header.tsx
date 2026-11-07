/**
 * A table column a reader can sort — the ONE shape, used by every table that
 * sorts by its header (#1465, D128).
 *
 * 🔴 **The control is a real `<button>` inside the `<th>`, never an `onClick` on
 * the `<th>`.** A clickable cell is mouse-only: nothing to Tab to, and Enter or
 * Space does nothing, so a keyboard or screen-reader user cannot re-sort the
 * table at all (WCAG 2.1.1). Three tables shipped that way — the qualitative
 * comparison, Data Quality's missing-values table and the post-hoc table — while
 * the code summary table beside them had the button; the shape lives here now so
 * the next table cannot copy the wrong neighbour. `sortable-column-header.test.tsx`
 * scans `src/` for a header cell carrying an `onClick`.
 *
 * **What a reader is told (D129):** the button's NAME is the label alone ("p",
 * never "p↑" — the arrow is `aria-hidden`), and the column's STATE is `aria-sort`
 * on the `<th>`, set on the sorted column only (the APG sortable-table pattern;
 * `none` on every other column says nothing the absence does not). One arrow pair,
 * ↑ and ↓, everywhere.
 */
import type { CSSProperties } from 'react'
import type { ColumnSort } from '@/lib/column-sort'

/**
 * The button's classes. Inline-flex, so the `<th>`'s own `text-left` /
 * `text-right` still places it.
 */
const SORT_BUTTON =
  'inline-flex items-center gap-1 rounded px-1 -mx-1 hover:bg-mm-surface-hover '
  + 'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

/**
 * The sort control alone, for a header that holds something beside it — the
 * code summary table's info trigger sits OUTSIDE the button, because nesting it
 * would make reading the explanation also re-sort the table. That header sets
 * `aria-sort={columnSort(…)}` on its own `<th>`; every other header uses
 * `SortableColumnHeader`.
 */
export function SortButton({ label, sort, onSort }: {
  label: string
  sort: ColumnSort
  onSort: () => void
}) {
  return (
    <button type="button" className={SORT_BUTTON} onClick={onSort}>
      {label}
      {sort && (
        <span aria-hidden="true" className="text-mm-text-faint">
          {sort === 'ascending' ? '↑' : '↓'}
        </span>
      )}
    </button>
  )
}

/** A whole sortable column header: the `<th>`, its `aria-sort`, its button. */
export function SortableColumnHeader({ label, sort, onSort, className, style, title }: {
  label: string
  sort: ColumnSort
  onSort: () => void
  className?: string
  style?: CSSProperties
  /** Hover words for the eye (a unit caveat); the column keeps its short name. */
  title?: string
}) {
  return (
    <th scope="col" className={className} style={style} aria-sort={sort} title={title}>
      <SortButton label={label} sort={sort} onSort={onSort} />
    </th>
  )
}
