/**
 * Row 47 — a dataset with no records still shows its grid.
 *
 * 🔴 **This was the PREREQUISITE for authoring a dataset by hand, not a polish
 * item.** `DatasetView` rendered
 * `rows.length === 0 ? "No rows for this dataset." : <grid>`, with the column
 * headers, the `<colgroup>`, the `<caption>` AND the pager all inside the else.
 * So a table you had just created showed one grey sentence: you could add a
 * variable and not SEE it, and there was nowhere to type. Creating a blank
 * dataset landed on a dead end.
 *
 * ⚠️ **jsdom computes no layout and this page needs a live query client, a
 * router and a DndContext to mount**, so this is a SOURCE scan pinning the
 * structure rather than a render test — with the same self-check every scan in
 * this codebase carries (#729): a walk that resolves to nothing passes by
 * finding nothing.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { stripComments } from '@/lib/strip-comments'

const read = (rel: string) =>
  readFileSync(join(__dirname, '..', rel), 'utf-8')

describe('the Data view renders a grid for an empty dataset', () => {
  const raw = read('pages/DatasetView.tsx')
  const src = stripComments(raw)

  it('read a real file', () => {
    expect(raw.length).toBeGreaterThan(20_000)
    expect(src).toContain('DataGridBody')
  })

  it('🔴 does not hide the grid behind a row count', () => {
    // The exact expression that made a new table a dead end. Comments are
    // stripped first, so the explanatory note that quotes it does not match
    // itself (#772's phantom class, from the other side).
    expect(
      src,
      'the grid must not be gated on `rows.length === 0` — an empty dataset '
      + 'still has columns to show and a place to type',
    ).not.toMatch(/rows\.length === 0 \?/)
  })

  it('keeps a first-run panel for a table with neither columns nor records', () => {
    // There is nothing to render a grid OF, so the empty state names the two
    // next steps — the same call `PickRuleToDeriveDialog`'s empty state makes.
    expect(src).toMatch(/columns\.length === 0 && totalRows === 0/)
    expect(raw).toContain('This table is empty')
    expect(raw, 'the panel must name BOTH next steps')
      .toMatch(/Add variable[\s\S]{0,600}Add record/)
  })

  it('says what is missing INSIDE the table when only records are absent', () => {
    // With at least one variable the grid renders, headers and all, and the
    // message goes where the records will appear.
    expect(src).toMatch(/rows\.length === 0 && \(/)
    expect(raw).toContain('No records yet')
    expect(src, 'a colSpan that covers the fixed columns and the data ones')
      .toMatch(/colSpan=\{2 \+ columns\.length \+ domainScoreCols\.length\}/)
  })

  it('leaves the pager gated on its own condition', () => {
    // It already gates on `hasPaging = totalRows > pageSize`, so an empty
    // dataset shows no pager without a second guard — and re-adding one would
    // be the row-count gate creeping back in.
    expect(src).toContain('hasPaging &&')
  })
})

describe('#930 — the empty state fits the viewport a 1280×720 window has at 200% zoom', () => {
  const raw = read('pages/DatasetView.tsx')
  const src = stripComments(raw)

  it('read a real file', () => {
    expect(raw.length).toBeGreaterThan(20_000)
    expect(src).toContain('This table is empty')
  })

  it('🔴 pairs the flexible region\'s `min-h-0` with an overflow', () => {
    // #894's rule on the vertical axis: `min-h-0` GRANTS the collapse and an
    // overflow on the SAME child is what makes it safe. Without it the region
    // was 238px tall around 294px of content with `overflow-y: visible`, and the
    // ancestor clips — so the panel ran to y=387 in a 360px viewport and the
    // *Add record* button's last 7px sat behind the status bar with NOTHING
    // scrolling. Measured before and after at 640×360.
    expect(src).toMatch(/flex-1 min-h-0 p-4 flex flex-col overflow-y-auto/)
  })

  it('does not use `overflow-hidden` here, which #894 refuted', () => {
    // Hiding would take the two calls-to-action off screen entirely, and an
    // overflow metric would report that as fixed.
    expect(src).not.toMatch(/flex-1 min-h-0 p-4 flex flex-col overflow-hidden/)
  })

  it('the status hint does not name controls that are not on screen', () => {
    // "Click a column header or cell to edit" on a table that has neither.
    expect(src).toMatch(/columns\.length === 0 && totalRows === 0 \? \(\s*<span>Add a variable and a record to start/)
  })
})
