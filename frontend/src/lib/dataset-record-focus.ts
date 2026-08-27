/**
 * Finding one record's cell in the Data grid, for the search deep link (#834).
 *
 * ## Why this is a module and not three lines in an effect
 *
 * The lookup crosses a DOM contract that nothing type-checks: `DataRow` writes
 * `data-row-id` on its `<tr>`, and `DatasetView` writes `data-col-id` on each
 * `<col>` in the table's `<colgroup>`. A deep link has a row PK and a column id
 * and needs the `<td>` where they meet. Keeping that in one tested place means
 * the attribute contract has exactly one reader.
 *
 * ## Why the column comes from the colgroup and not from the cell
 *
 * `EditableCell` returns ten different `<td>` branches (one per column type,
 * times editing/not), so a `data-col-id` per cell would be ten places to keep in
 * step and nine chances to forget. The `<colgroup>` already carries the column
 * identity once, in render order — and a row's `cells` are in that same order by
 * definition of a table. So the column's INDEX is the bridge.
 */

/** The cell a deep link is pointing at, or null when this page does not hold it. */
export function findRecordCell(
  table: HTMLTableElement,
  rowId: number,
  columnId: number | null,
): { row: HTMLTableRowElement; cell: HTMLTableCellElement | null } | null {
  const row = table.querySelector<HTMLTableRowElement>(`tr[data-row-id="${rowId}"]`)
  if (!row) return null
  if (columnId == null) return { row, cell: null }

  const cols = Array.from(table.querySelectorAll('colgroup > col'))
  const index = cols.findIndex(c => c.getAttribute('data-col-id') === String(columnId))
  // A column the user has since deleted, or one whose `<col>` carries no id
  // (the two leading fixed columns): the ROW is still the useful answer.
  if (index < 0) return { row, cell: null }

  // `cells` is a live HTMLCollection in colgroup order — `index` addresses it
  // directly. Guard the bound: a row is not obliged to render every column.
  const cell = index < row.cells.length ? (row.cells[index] as HTMLTableCellElement) : null
  return { row, cell }
}

/**
 * Scroll a deep-linked record into view and mark it briefly.
 *
 * Returns a cleanup that removes the marker, so a caller unmounting mid-flash
 * does not leave a permanently highlighted cell behind.
 *
 * ⚠️ Scrolls the CELL when there is one, because the grid scrolls in BOTH axes:
 * landing on the right row while the matched column sits off to the right of a
 * 48-column table shows the researcher the correct record and none of the
 * reason it matched. `block: 'center'` for the same reason — a row flush
 * against the top edge reads as "the page just happens to start here".
 */
export const FOUND_FLASH_CLASS = 'dataset-found-flash'
export const FOUND_FLASH_MS = 1800

export function revealRecordCell(
  table: HTMLTableElement,
  rowId: number,
  columnId: number | null,
): (() => void) | null {
  const hit = findRecordCell(table, rowId, columnId)
  if (!hit) return null

  const target = hit.cell ?? hit.row
  target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' })
  target.classList.add(FOUND_FLASH_CLASS)

  const timer = setTimeout(() => target.classList.remove(FOUND_FLASH_CLASS), FOUND_FLASH_MS)
  return () => {
    clearTimeout(timer)
    target.classList.remove(FOUND_FLASH_CLASS)
  }
}

/**
 * The page offset holding a 1-based record number, for the pager's jump box.
 *
 * ⚠️ Deliberately pure client arithmetic with NO server round trip — unlike the
 * search deep link, which knows a row PRIMARY KEY and must ask. A record NUMBER
 * is an ordinal, and an ordinal's page is division. `total_rows` is already on
 * the payload, so nothing else is needed.
 *
 * Returns null when the input is not a usable record number, so the caller can
 * refuse rather than navigate somewhere arbitrary. Out-of-range values CLAMP
 * into the dataset instead of returning null: typing 99999 in a 75,699-row
 * dataset plainly means "the end", and refusing that is pedantry.
 */
export function offsetForRecordNumber(
  recordNumber: number,
  pageSize: number,
  totalRows: number,
): number | null {
  if (!Number.isFinite(recordNumber) || !Number.isInteger(recordNumber)) return null
  if (recordNumber < 1 || totalRows <= 0 || pageSize <= 0) return null
  const clamped = Math.min(recordNumber, totalRows)
  return Math.floor((clamped - 1) / pageSize) * pageSize
}
