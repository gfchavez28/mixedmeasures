/**
 * Moving the cursor around the Data grid with the keyboard (#946).
 *
 * `#927` gave the grid `F2`/`Enter` to open the editor on the SELECTED cell, and
 * once editing, `Tab` and `Enter` already walk cell to cell. But `selectedCell`
 * was only ever set by a CLICK — the cells carried no tab stop and there was no
 * arrow handler — so the whole editing capability had no keyboard entry point.
 * This module is the arithmetic half of the fix: given where the cursor is and
 * what the grid holds, where does a key put it?
 *
 * ## Why a pure module rather than a handler in the page
 *
 * The grid's coordinates are `(rowId, columnId)` PAIRS, not indices — the page
 * paginates, columns are reordered and deleted, and every other consumer
 * (`selectedCell`, `editingCell`, the `?row=&column=` deep link) already speaks
 * that pair. Index arithmetic is the part that is easy to get wrong and easy to
 * test, so it lives here with no DOM and no React.
 *
 * ## 🔴 It CLAMPS at the page edge, and that is a decision
 *
 * `ArrowDown` on the last row of a page stays put rather than fetching the next
 * page. Two reasons, and the second is the real one: the existing `Tab`/`Enter`
 * edit navigation already clamps to the current page's rows, so paging here
 * would make two navigation models disagree about what the last row is; and a
 * key that silently triggers a fetch, a re-render and a scroll jump is a
 * different act from moving one cell. The pager is the affordance for paging.
 *
 * ⚠️ **`Alt` and `Shift` are not ours.** Shift is reserved rather than
 * repurposed (a future range selection is the obvious claim on it), and Alt
 * belongs to the browser. Returning `null` for them lets the event through
 * instead of swallowing it — the same posture `lib/listbox-keys.ts` takes.
 */

export interface GridCoord {
  rowId: number
  columnId: number
}

/** The keys this module answers for. Exported so a guard can assert the set. */
export const GRID_NAV_KEYS: readonly string[] = [
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End',
]

export interface GridNavEvent {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
}

/**
 * Where this keystroke puts the cursor, or `null` when the key is not ours.
 *
 * ⚠️ **A `null` `current` is the ENTRY PATH, not an error.** Nothing is selected
 * when the page loads, so the first arrow must land somewhere — it lands on the
 * first cell. Without that, a keyboard user who tabs into the grid and presses
 * Down gets nothing, which is the state this whole issue is about.
 *
 * ⚠️ **A coordinate naming a row or column that is no longer here resolves to
 * index 0 of that axis** rather than returning null. Rows and columns come and
 * go under this grid (a page change, a deleted variable), and a stale
 * coordinate that refuses to move would leave the cursor stuck with no way out
 * — the closed loop the crosswalk grid records (#701a): nothing focusable means
 * no keydown means nothing ever becomes focusable.
 */
export function nextGridCoord(
  current: GridCoord | null,
  rowIds: readonly number[],
  columnIds: readonly number[],
  e: GridNavEvent,
): GridCoord | null {
  if (!GRID_NAV_KEYS.includes(e.key)) return null
  if (e.altKey || e.shiftKey) return null
  if (rowIds.length === 0 || columnIds.length === 0) return null

  const jump = Boolean(e.ctrlKey || e.metaKey)
  // ⚠️ Ctrl/Cmd modifies Home and End only. On an ARROW it belongs to the
  // browser and to the OS (Cmd+ArrowLeft is Back on macOS), so claiming it
  // would take a navigation gesture away and give nothing back.
  if (jump && e.key.startsWith('Arrow')) return null

  const foundRow = current ? rowIds.indexOf(current.rowId) : -1
  const foundCol = current ? columnIds.indexOf(current.columnId) : -1
  let r = foundRow >= 0 ? foundRow : 0
  let c = foundCol >= 0 ? foundCol : 0

  // With no cursor at all, an arrow lands ON the first cell rather than one
  // step past it — arriving and pressing Down should select the first row, not
  // the second.
  const arriving = current === null

  switch (e.key) {
    case 'ArrowDown': if (!arriving) r = Math.min(r + 1, rowIds.length - 1); break
    case 'ArrowUp': if (!arriving) r = Math.max(r - 1, 0); break
    case 'ArrowRight': if (!arriving) c = Math.min(c + 1, columnIds.length - 1); break
    case 'ArrowLeft': if (!arriving) c = Math.max(c - 1, 0); break
    // Home/End are ROW-scoped; Ctrl/Cmd spans the grid. The APG grid pattern,
    // and the same split the crosswalk grid uses.
    case 'Home': c = 0; if (jump) r = 0; break
    case 'End': c = columnIds.length - 1; if (jump) r = rowIds.length - 1; break
    default: return null
  }

  const next = { rowId: rowIds[r], columnId: columnIds[c] }
  // A move that changes nothing still counts as ours: the key was a grid key
  // and the cursor is where it asked to be, so the event is consumed rather
  // than falling through to scroll the container.
  return next
}

/**
 * The cell the grid offers as its single tab stop.
 *
 * 🔴 **A grid with no tab stop is unreachable, and that is the failure this
 * function exists to prevent.** Roving tabindex gives exactly one cell
 * `tabIndex=0`; if that cell is derived from the SELECTION and nothing is
 * selected — which is how every page load starts — then no cell is tabbable, no
 * keydown ever reaches the grid, and nothing can ever become selected. So the
 * stop falls back to the first cell, and the selection RING is a separate
 * question: on arrival there is a tab stop and no selection, which is correct.
 */
export function rovingStop(
  selected: GridCoord | null,
  rowIds: readonly number[],
  columnIds: readonly number[],
): GridCoord | null {
  if (rowIds.length === 0 || columnIds.length === 0) return null
  if (
    selected
    && rowIds.includes(selected.rowId)
    && columnIds.includes(selected.columnId)
  ) return selected
  return { rowId: rowIds[0], columnId: columnIds[0] }
}

/** Do two coordinates name the same cell? `null` never equals `null` here. */
export function sameCell(a: GridCoord | null, b: GridCoord | null): boolean {
  return a != null && b != null && a.rowId === b.rowId && a.columnId === b.columnId
}
