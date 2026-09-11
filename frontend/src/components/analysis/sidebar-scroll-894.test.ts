import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '@/lib/strip-comments'

/**
 * #894 — the analysis sidebar scrolls as a column; no section is elastic.
 *
 * **What went wrong.** One section carried `flex-1 min-h-0` while every other
 * was `shrink-0`, so the single flexible child absorbed the whole vertical
 * deficit alone. On the R&C tab the options accordion is ~505px by itself, which
 * squeezed that child to **zero** — and it held ~143px of `shrink-0` chrome (its
 * header, the Variables/Groups tabs, the search box) that cannot shrink and does
 * not clip, so it painted over the sections below it. Measured at 1280×900, an
 * ordinary window: the section was 1px tall holding 143px of content.
 *
 * 🔴 **The two obvious fixes were tested live and BOTH refuted**, which is why
 * this shape and not a smaller one:
 * - `overflow-hidden` on the flexible child removes the overlap by clipping a
 *   1px box — i.e. by **deleting the entire section from view**. Trading a
 *   visibly broken control for a silently missing one is worse, and only a
 *   screenshot shows it: an overflow metric reports it fixed.
 * - Adding a `min-height` floor puts 966px of content in a 727px column, so the
 *   sections below spill instead. The problem moves.
 *
 * **The column has to scroll either way** — on the R&C tab the fixed content is
 * ~786px against 727px of space even with the variable list at zero. So: the
 * column scrolls, every section takes its natural height, and the lists that can
 * grow are capped and scroll internally — the shape the Materials section has
 * always used (`max-h-[200px]` + an inner `max-h-[140px] overflow-y-auto`).
 *
 * ⚠️ **jsdom computes no layout, so this pins TECHNIQUE only.** The geometry was
 * verified in a browser at 1280×900, 1280×620 and 640×360, on both the R&C and
 * Descriptives tabs. Re-drive after touching this column.
 *
 * ⚠️ **Comment-stripped, and that is load-bearing here of all places:** the fix
 * carries comments that quote `flex-1 min-h-0` verbatim while explaining why it
 * is gone. Scanning raw source would fail on the explanation.
 */

const SRC = join(__dirname, '..', '..')
const read = (rel: string) => stripComments(readFileSync(join(SRC, rel), 'utf8'), rel)

const SIDEBAR = 'components/analysis/AnalysisSidebar.tsx'
const PICKER = 'components/ColumnPicker.tsx'

describe('#894 — the sidebar column scrolls', () => {
  it('the column itself is the scroller', () => {
    const src = read(SIDEBAR)
    expect(src, 'the sidebar root must own the vertical scroll')
      .toContain('h-full bg-mm-surface border-r flex flex-col overflow-y-auto')
  })

  it('no section wrapper is elastic (the defect was exactly one elastic child)', () => {
    const src = read(SIDEBAR)
    // A section that can absorb the column's whole deficit is what collapses to
    // zero. Population assertion: the string must not come back anywhere in the
    // sidebar, not merely at the two sites that had it.
    expect(src.includes('flex-1 min-h-0'),
      `${SIDEBAR} reintroduced an elastic section — see #894, it collapses to zero and paints over its siblings`)
      .toBe(false)
  })

  it('the scan can still see the file it is asserting about', () => {
    // #823f: a scan whose stripper goes blind reports clean. Prove the stripped
    // source still holds markup only this file can supply, and prove stripping
    // happened (the explanation quotes the banned string).
    const src = read(SIDEBAR)
    // Anchors must be CODE, not comments — the stripper removes comments, so a
    // comment anchor tests the stripper rather than the file (caught by writing
    // it the wrong way first).
    expect(src).toContain('<ChartOptionsPanel')
    expect(src).toContain("activeTab === 'descriptives'")
    // ...and prove stripping actually ran: the fix's own prose quotes the
    // banned string, so an unstripped read would fail the elastic-section test.
    expect(src).not.toContain('THE COLUMN SCROLLS')
  })
})

describe('#894 — a list that can grow is bounded and scrolls itself', () => {
  /** Every region that scrolls must carry its own cap, never borrow one. */
  const BOUNDED = [
    { file: SIDEBAR, what: 'the chart-options panel' },
    { file: PICKER, what: 'the columns list and the groups list' },
  ] as const

  it.each(BOUNDED)('$file bounds $what', ({ file }) => {
    const src = read(file)
    const scrollers = src.match(/className=[{"`][^"`}]*overflow-y-auto[^"`}]*/g) ?? []
    expect(scrollers.length, `${file} declares no vertical scroller — re-anchor this scan`)
      .toBeGreaterThan(0)
    for (const s of scrollers) {
      // A scroller must carry its OWN bound. Two are legitimate: `max-h-…` for a
      // list inside the column, and `h-full` for the column itself (bounded by
      // the resizable Panel around it). What is banned is a scroller with
      // neither, because its only remaining bound would be a flexible ancestor —
      // exactly the dependency #894 removed.
      expect(s, `${file} has an overflow-y-auto region bounded by neither max-h- nor h-full, so only a flexible ancestor could size it (#894)`)
        .toMatch(/max-h-|h-full/)
    }
  })

  it('ColumnPicker no longer depends on a flexible ancestor for its height', () => {
    const src = read(PICKER)
    const scrollers = src.match(/className=[{"`][^"`}]*overflow-y-auto[^"`}]*/g) ?? []
    expect(scrollers.length).toBeGreaterThanOrEqual(2) // columns list + groups list
    for (const s of scrollers) expect(s).not.toMatch(/\bflex-1\b/)
  })
})
