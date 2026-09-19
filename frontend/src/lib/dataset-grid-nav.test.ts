/**
 * `lib/dataset-grid-nav.ts` — the Data grid's keyboard cursor (#946).
 *
 * The arithmetic half of the fix, tested without a DOM. The page half (the
 * handler's scoping, the roving tab stop reaching the cells, focus returning
 * from a closed editor) is pinned in `pages/dataset-grid-keyboard.test.ts`.
 *
 * ⚠️ **The row and column id lists are deliberately NOT `[1,2,3]`.** Ids and
 * indices are different spaces here, and a fixture where they coincide cannot
 * tell an implementation that returns `rowIds[i]` from one that returns `i` —
 * the degenerate-fixture rule on the axis this module actually turns on.
 */
import { describe, it, expect } from 'vitest'
import {
  GRID_NAV_KEYS, nextGridCoord, rovingStop, sameCell,
} from './dataset-grid-nav'

// Non-contiguous, not 0- or 1-based, and rows/columns share no values — so a
// row id can never be mistaken for a column id or for an index.
const ROWS = [70, 71, 72, 73]
const COLS = [905, 906, 907]

const at = (rowId: number, columnId: number) => ({ rowId, columnId })
const move = (from: ReturnType<typeof at> | null, key: string, mods = {}) =>
  nextGridCoord(from, ROWS, COLS, { key, ...mods })

describe('nextGridCoord — the arrows', () => {
  it('moves one cell in each direction', () => {
    expect(move(at(71, 906), 'ArrowDown')).toEqual(at(72, 906))
    expect(move(at(71, 906), 'ArrowUp')).toEqual(at(70, 906))
    expect(move(at(71, 906), 'ArrowRight')).toEqual(at(71, 907))
    expect(move(at(71, 906), 'ArrowLeft')).toEqual(at(71, 905))
  })

  it('clamps at every edge rather than wrapping', () => {
    expect(move(at(70, 905), 'ArrowUp')).toEqual(at(70, 905))
    expect(move(at(70, 905), 'ArrowLeft')).toEqual(at(70, 905))
    expect(move(at(73, 907), 'ArrowDown')).toEqual(at(73, 907))
    expect(move(at(73, 907), 'ArrowRight')).toEqual(at(73, 907))
  })

  it('🔴 a clamped move is still OURS — it returns a coord, not null', () => {
    // The caller `preventDefault`s on a non-null result. Returning null at the
    // edge would let ArrowDown fall through and scroll the container instead,
    // so the grid would appear to jump away from the cell the user is on.
    expect(move(at(73, 905), 'ArrowDown')).not.toBeNull()
  })
})

describe('nextGridCoord — arriving with no cursor', () => {
  it('🔴 the first arrow lands ON the first cell, not one step past it', () => {
    // Nothing is selected when the page loads, so this IS the entry path: tab
    // in, press Down, be somewhere. A naive `index + 1` from a default of 0
    // silently skips the first row, which reads as the grid ignoring the press.
    expect(move(null, 'ArrowDown')).toEqual(at(70, 905))
    expect(move(null, 'ArrowRight')).toEqual(at(70, 905))
    expect(move(null, 'ArrowUp')).toEqual(at(70, 905))
    expect(move(null, 'ArrowLeft')).toEqual(at(70, 905))
  })

  it('Home and End still mean what they mean', () => {
    expect(move(null, 'End')).toEqual(at(70, 907))
    expect(move(null, 'End', { ctrlKey: true })).toEqual(at(73, 907))
  })
})

describe('nextGridCoord — Home and End', () => {
  it('are ROW-scoped bare and GRID-scoped with Ctrl (the APG split)', () => {
    expect(move(at(72, 906), 'Home')).toEqual(at(72, 905))
    expect(move(at(72, 906), 'End')).toEqual(at(72, 907))
    expect(move(at(72, 906), 'Home', { ctrlKey: true })).toEqual(at(70, 905))
    expect(move(at(72, 906), 'End', { ctrlKey: true })).toEqual(at(73, 907))
  })

  it('accept Meta as well as Ctrl, so the gesture works on a Mac', () => {
    expect(move(at(72, 906), 'Home', { metaKey: true })).toEqual(at(70, 905))
  })
})

describe('nextGridCoord — keys that are NOT ours', () => {
  it('🔴 Ctrl+Arrow belongs to the browser and the OS', () => {
    // Cmd+ArrowLeft is Back on macOS. Claiming it would take a navigation
    // gesture away and give nothing back — the grid already has Ctrl+Home/End.
    expect(move(at(71, 906), 'ArrowLeft', { ctrlKey: true })).toBeNull()
    expect(move(at(71, 906), 'ArrowRight', { metaKey: true })).toBeNull()
  })

  it('Shift is RESERVED, not repurposed — a range selection is the obvious claim', () => {
    expect(move(at(71, 906), 'ArrowDown', { shiftKey: true })).toBeNull()
  })

  it('Alt belongs to the browser', () => {
    expect(move(at(71, 906), 'ArrowDown', { altKey: true })).toBeNull()
  })

  it('every other key falls through', () => {
    for (const key of ['Enter', 'F2', 'Escape', 'Tab', ' ', 'a', 'PageDown']) {
      expect(move(at(71, 906), key), key).toBeNull()
    }
  })

  it('the exported key set and the implementation agree', () => {
    // A key added to one and not the other is a control that announces itself
    // and does nothing, or a guard that measures a set nobody handles.
    for (const key of GRID_NAV_KEYS) expect(move(at(71, 906), key), key).not.toBeNull()
  })
})

describe('nextGridCoord — a grid that has changed underneath', () => {
  it('🔴 a coordinate whose row is GONE resolves to the first row, never null', () => {
    // Rows and columns come and go here (a page change, a deleted variable). A
    // stale coordinate that refused to move would strand the cursor with no way
    // out — the closed loop #701(a) records: nothing focusable, so no keydown,
    // so nothing ever becomes focusable.
    expect(move(at(999, 906), 'ArrowDown')).toEqual(at(71, 906))
  })

  it('a coordinate whose COLUMN is gone resolves to the first column', () => {
    expect(move(at(72, 999), 'ArrowDown')).toEqual(at(73, 905))
  })

  it('an empty grid answers nothing at all', () => {
    expect(nextGridCoord(null, [], COLS, { key: 'ArrowDown' })).toBeNull()
    expect(nextGridCoord(null, ROWS, [], { key: 'ArrowDown' })).toBeNull()
  })
})

describe('rovingStop — the grid must always have exactly one tab stop', () => {
  it('🔴 falls back to the FIRST cell when nothing is selected', () => {
    // Deriving the tab stop from the selection alone leaves a freshly loaded
    // grid with no tabbable cell — unreachable by keyboard, permanently, since
    // the only thing that could select a cell is a key it can never receive.
    expect(rovingStop(null, ROWS, COLS)).toEqual(at(70, 905))
  })

  it('is the selection when there is one', () => {
    expect(rovingStop(at(72, 907), ROWS, COLS)).toEqual(at(72, 907))
  })

  it('falls back when the selection names a row or column that has gone', () => {
    // A page change keeps `selectedCell` pointing at a row that is no longer
    // rendered; without this the page would render zero tab stops.
    expect(rovingStop(at(999, 907), ROWS, COLS)).toEqual(at(70, 905))
    expect(rovingStop(at(72, 999), ROWS, COLS)).toEqual(at(70, 905))
  })

  it('an empty grid has no stop, which is the one honest answer', () => {
    expect(rovingStop(at(70, 905), [], COLS)).toBeNull()
    expect(rovingStop(at(70, 905), ROWS, [])).toBeNull()
  })
})

describe('sameCell', () => {
  it('compares both axes', () => {
    expect(sameCell(at(70, 905), at(70, 905))).toBe(true)
    expect(sameCell(at(70, 905), at(70, 906))).toBe(false)
    expect(sameCell(at(70, 905), at(71, 905))).toBe(false)
  })

  it('two absences are not the same cell', () => {
    // `null` means "no cursor"; treating two of them as equal would make an
    // idle grid look like it were sitting on a cell.
    expect(sameCell(null, null)).toBe(false)
    expect(sameCell(at(70, 905), null)).toBe(false)
  })
})
