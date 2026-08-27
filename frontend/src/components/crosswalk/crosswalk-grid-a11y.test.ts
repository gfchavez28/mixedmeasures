/**
 * #701(b) + #756 — the crosswalk grid's role chain and its keyboard pattern.
 *
 * ## Why this is a SOURCE scan
 *
 * Both defects are properties of the rendered ARIA tree, and jsdom computes no
 * accessibility tree at all: it cannot tell you that a `role="grid"` owns a
 * non-row child, and it happily reports a `tabindex` that no reader would ever
 * reach. A mounted test here would assert nothing while looking like coverage —
 * the #751/#752 lesson, one component over. The behaviour was proved by driving
 * a real 2-bracket / 7-row crosswalk in Chrome; this scan is what stops it
 * regressing between drives.
 *
 * ## What was measured live, before and after
 *
 * | | before | after |
 * |---|---|---|
 * | rows with no grid/rowgroup parent | 1 | **0** |
 * | grids owning a non-row child | 2 | **0** |
 * | cells that are tab stops | 13 of 18 | **2** (one per grid) |
 * | tab stops on the page | 30 | **19** |
 *
 * And the keyboard trace, which is the half the filed issue got wrong:
 * ArrowRight → next dataset · ArrowDown → next row · End → last column ·
 * Ctrl+Home → first cell · ArrowUp at row 0 → stays. Before the change,
 * **ArrowRight and ArrowDown moved focus nowhere**.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { stripComments } from '@/lib/strip-comments'
import { join } from 'node:path'

const DIR = join(__dirname)

/**
 * Read a source file with its COMMENTS REMOVED.
 *
 * ⚠️ Not optional, and the first draft of this file proved it: four assertions
 * failed against correct code because the explanatory comments beside each fix
 * quote the very strings being scanned for (`role="row"`, `role="gridcell"`,
 * `role="grid"`). A source scan that reads commentary is measuring the wrong
 * artifact — it can report a violation that does not exist, and equally miss one
 * that does, the moment someone writes about it nearby. (The substrate has since
 * landed: `@/lib/strip-comments`, which is now the codebase's one answer to
 * comment-stripping — this file used to carry a sixth.)
 *
 * ⚠️ That module BLANKS comments rather than deleting their lines, so offsets
 * survive; the `indexOf` ordering assertions below are unaffected, and the
 * fixed-width window at the end of this file was re-measured against it.
 */
const read = (f: string) => {
  const abs = join(DIR, f)
  return stripComments(readFileSync(abs, 'utf8'), abs)
}

const BRACKET = read('Bracket.tsx')
const CELL = read('Cell.tsx')
const ROW = read('EquivalenceRow.tsx')
const HEADERS = read('CrosswalkColumnHeaders.tsx')

describe('#701(b) — the grid owns rows, and only rows', () => {
  /**
   * The population assertion: if this file ever stops finding the roles it
   * reasons about, every test below would pass vacuously. A scan whose
   * expected result is empty cannot tell "clean" from "blind" (#729/#730).
   */
  it('finds the roles it is scanning for', () => {
    expect(BRACKET).toContain('role="grid"')
    expect(ROW).toContain('role="row"')
    expect(CELL.match(/role="gridcell"/g)?.length).toBe(2) // data + empty
  })

  it('does not put the grid role on EITHER <section>, whose children are chrome', () => {
    // The section is a flex row of [210px label gutter, frame]. Neither is a
    // row, so `grid` there is an `aria-required-children` violation by
    // construction — measured as 2 offending grids on a 2-bracket page.
    //
    // ⚠️ BOTH openings, and this is not pedantry: the first draft sliced from
    // `indexOf('<section')` to `indexOf('</section>')`, which is the COLLAPSED
    // branch only. Restoring `role="grid"` on the EXPANDED section — the actual
    // defect — sailed past it, and was caught incidentally by two other
    // assertions. A guard that checks one member of a pair is the #515 → #676
    // shape in miniature.
    // ⚠️ To the tag's real `>`, not a fixed 400-char window. The window was a
    // proxy for "the opening tag", and it worked only while the stripper
    // DELETED comment lines: once comments are blanked in place (2026-08-26,
    // `@/lib/strip-comments`), the JSDoc inside these tags stays as whitespace
    // and both openings run past 400 chars — so the scan silently matched
    // NOTHING. The bound is gone rather than raised; a proxy that has already
    // failed once should not be re-tuned.
    const openings = [...BRACKET.matchAll(/<section/g)]
      .map(m => BRACKET.slice(m.index, BRACKET.indexOf('>', m.index) + 1))
    expect(openings.length, 'expected the collapsed and expanded branches').toBe(2)
    for (const tag of openings) {
      expect(tag).not.toMatch(/role="grid"/)
    }
  })

  it('declares the grid on the element that maps the rows', () => {
    // `role="grid"` must sit immediately around `bracket.rows.map`, with no
    // wrapper in between — a bare wrapper div was the second violation, found
    // only by re-measuring after the first fix looked correct in the diff.
    const gridIdx = BRACKET.indexOf('role="grid"')
    const mapIdx = BRACKET.indexOf('bracket.rows.map')
    expect(gridIdx).toBeGreaterThan(-1)
    expect(mapIdx).toBeGreaterThan(gridIdx)
    const between = BRACKET.slice(gridIdx, mapIdx)
    expect(between, 'a wrapper element sits between the grid and its rows')
      .not.toMatch(/<div(?![^>]*role=)/)
  })

  it('keeps the empty-state message outside the grid', () => {
    // Prose is not a row. An empty grid beside a message is also the more
    // honest structure than a grid containing an apology.
    const emptyIdx = BRACKET.indexOf('No columns yet.')
    const gridIdx = BRACKET.indexOf('role="grid"')
    expect(emptyIdx).toBeGreaterThan(-1)
    expect(emptyIdx).toBeLessThan(gridIdx)
  })

  it('does not give the shared header strip a row role it cannot parent', () => {
    // One sticky strip serves every bracket, so no single grid can own it.
    // Each gridcell names its own dataset, so nothing is lost by dropping it.
    expect(HEADERS).not.toContain('role="row"')
    expect(HEADERS).toContain('role="presentation"')
  })
})

describe('#756 — one tab stop per grid, arrows inside', () => {
  it('gives cells a roving tabindex rather than a fixed 0', () => {
    // Every cell was `tabIndex={0}`: a 3-dataset × 30-row crosswalk cost 90 tab
    // stops. Both cell kinds must rove — the empty cell had NO tabindex at all
    // and was unreachable, which the filed issue does not mention.
    expect(CELL).not.toMatch(/role="gridcell"[\s\S]{0,200}?tabIndex=\{0\}/)
    expect(CELL.match(/tabIndex=\{isActiveCell \? 0 : -1\}/g)?.length).toBe(2)
  })

  it('places the roving tabindex AFTER the dnd-kit attribute spread', () => {
    // `useDraggable().attributes` carries its own `tabIndex`; later JSX props
    // win, so the order is what makes ours authoritative. Reversing it silently
    // restores every cell to a tab stop.
    const spread = CELL.indexOf('{...draggable.attributes}')
    const roving = CELL.indexOf('tabIndex={isActiveCell ? 0 : -1}', spread)
    expect(spread).toBeGreaterThan(-1)
    expect(roving).toBeGreaterThan(spread)
  })

  /**
   * The load-bearing one. Roving tabindex without arrow handling does not make
   * the grid tidier — it makes the cells UNREACHABLE. #756 reported that arrows
   * "work once inside"; measured, they moved focus nowhere (that was the screen
   * reader's own browse-mode table navigation, which any `role="grid"` gets for
   * free). The two halves ship together or not at all.
   */
  it('implements the arrow keys the roving tabindex depends on', () => {
    for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End']) {
      expect(BRACKET, `the grid handles no ${key}`).toContain(`'${key}'`)
    }
    expect(BRACKET).toContain('onKeyDown={handleGridKeyDown}')
  })

  it('leaves the Ctrl+Shift+Arrow row-reorder shortcut alone', () => {
    // The row's own handler owns that combination and fires first as the event
    // bubbles. Swallowing shifted arrows here would silently kill reordering.
    const handler = BRACKET.slice(BRACKET.indexOf('const handleGridKeyDown'))
    expect(handler.slice(0, 400)).toMatch(/e\.altKey \|\| e\.shiftKey\) return/)
  })

  it('clamps the active cell at render, so the grid always has a tab stop', () => {
    // Rows and datasets disappear under this component. A stale coordinate
    // would leave no cell at tabIndex 0 — nothing focusable, therefore no
    // keydown, therefore nothing ever becomes focusable: the #701(a) loop.
    expect(BRACKET).toMatch(/const activeRow = rowCount > 0 \? Math\.min/)
    expect(BRACKET).toMatch(/const activeCol = colCount > 0 \? Math\.min/)
  })

  it('passes the active cell down as primitives, not a ref', () => {
    // `Cell` is a memoized leaf; a ref prop would churn its identity every
    // parent render and undo the #332 drag-performance work.
    expect(ROW).toContain('activeCol === idx')
    expect(CELL).toContain('data-cell-pos={gridPos}')
    expect(BRACKET).toContain('data-cell-pos="${r}-${c}"')
  })
})
