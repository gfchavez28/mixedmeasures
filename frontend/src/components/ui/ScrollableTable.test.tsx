import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { ScrollableTable } from './ScrollableTable'

/**
 * #1156 — the box must CONTAIN what it scrolls. jsdom computes no layout, so this
 * pins the technique: the box is positioned (`relative`), which makes it the
 * containing block of every `sr-only` (absolutely positioned) descendant, so its
 * `overflow-auto` clips them. Without it, a tall table's screen-reader-only words
 * stretched the PAGE past the box (measured live: ~1,050 px of blank scroll on the
 * Participants page at both viewports).
 */
describe('ScrollableTable', () => {
  it('is the containing block of what it scrolls', () => {
    const { container } = render(<ScrollableTable><table><tbody><tr><td>x</td></tr></tbody></table></ScrollableTable>)
    const box = container.querySelector('[data-scrollable-table]') as HTMLElement
    expect(box).not.toBeNull()
    expect(box.className.split(/\s+/)).toEqual(expect.arrayContaining(['relative', 'overflow-auto']))
  })

  it('keeps both when a caller adds classes of its own', () => {
    const { container } = render(<ScrollableTable className="rounded-md border" maxHeight="50vh" />)
    const box = container.querySelector('[data-scrollable-table]') as HTMLElement
    expect(box.className.split(/\s+/)).toEqual(expect.arrayContaining(['relative', 'overflow-auto', 'rounded-md']))
    expect(box.style.maxHeight).toBe('50vh')
  })
})
