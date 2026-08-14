import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { optionPositionAria, optionOrdinals } from './listbox-aria'

const SRC = join(__dirname, '..')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

describe('optionPositionAria', () => {
  it('emits 1-based ARIA position attributes', () => {
    expect(optionPositionAria(1, 13)).toEqual({ 'aria-posinset': 1, 'aria-setsize': 13 })
  })

  it('does not renumber or clamp — it reports what it is given', () => {
    // The caller owns the "which set?" decision; encoding a guess here is how
    // the two halves drift apart.
    expect(optionPositionAria(7, 7)).toEqual({ 'aria-posinset': 7, 'aria-setsize': 7 })
  })
})

describe('optionOrdinals', () => {
  it('numbers options from 1 in array order', () => {
    const items = [{ id: 40 }, { id: 7 }, { id: 91 }]
    const map = optionOrdinals(items, i => i.id)
    expect([...map.entries()]).toEqual([[40, 1], [7, 2], [91, 3]])
  })

  it('counts ONLY what it is handed — the image-interleave trap (#751)', () => {
    // DocumentCodingWorkbench's Virtuoso data interleaves presentation-role
    // image rows. Ordinals must come from the SEGMENT array, so a set of 3
    // segments is "of 3" no matter how many images sit between them.
    const segments = [{ id: 1 }, { id: 2 }, { id: 3 }]
    const map = optionOrdinals(segments, s => s.id)
    expect(map.size).toBe(3)
    expect(map.get(3)).toBe(3)
  })
})

/**
 * #751 — fail-closed: every virtualised listbox must state its real length.
 *
 * ⚠️ The expected set is deliberately NON-EMPTY (#730): `expect(found).toEqual(
 * ALL)` fails loudly if the scan goes blind — a path typo, a renamed file — where
 * an `expect(missing).toEqual([])` would pass silently on a scan that found
 * nothing at all.
 */
describe('#751 — the virtualised listbox surfaces all declare their set size', () => {
  const VIRTUALISED_OPTION_SURFACES = [
    'pages/ObservationWorkbench.tsx',
    'pages/DocumentCodingWorkbench.tsx',
    'components/SegmentRow.tsx',
  ]

  it('each one routes through the lib/listbox-aria helper', () => {
    const wired = VIRTUALISED_OPTION_SURFACES.filter(f => {
      const src = read(f)
      return src.includes('optionPositionAria') && src.includes("from '@/lib/listbox-aria'")
    })
    expect(wired).toEqual(VIRTUALISED_OPTION_SURFACES)
  })

  it('none of them hand-rolls the attributes instead', () => {
    // A literal aria-setsize/aria-posinset here means a second implementation of
    // the "which set?" rule, which is the drift this helper exists to stop.
    for (const f of VIRTUALISED_OPTION_SURFACES) {
      const src = read(f)
      expect(src, `${f} inlines aria-setsize`).not.toMatch(/aria-setsize=/)
      expect(src, `${f} inlines aria-posinset`).not.toMatch(/aria-posinset=/)
    }
  })

  it('DocumentCodingWorkbench counts segments, never listItems', () => {
    // The specific wrong fix: `listItems` holds presentation-role image rows.
    const src = read('pages/DocumentCodingWorkbench.tsx')
    expect(src).toMatch(/optionOrdinals\(\s*filteredSegments/)
    expect(src).toMatch(/setSize=\{filteredSegments\.length\}/)
    expect(src, 'set size must not be the interleaved list').not.toMatch(/setSize=\{listItems\.length\}/)
  })
})

/**
 * #752 — the counter-marker that stops a faux-disabled container from disabling
 * live controls. Chrome propagates `aria-disabled` from the code ROW into the
 * accessibility tree, so both nested controls were exposed as disabled while
 * remaining operable. Verified in Chrome against a same-row control; jsdom
 * computes no such propagation, so this pins the TECHNIQUE, not the behaviour —
 * the same honesty as the #750 ordering guard.
 */
describe('#752 — CodePanel keeps its live controls out of the row\'s disabled state', () => {
  it('both nested controls carry an explicit aria-disabled={false}', () => {
    const src = read('components/CodePanel.tsx')
    const rowMarker = /aria-disabled=\{disabled \|\| !code\.is_active\}/
    expect(src, 'the #434 row marker should still be there').toMatch(rowMarker)

    const counterMarkers = src.match(/aria-disabled=\{false\}/g) ?? []
    expect(
      counterMarkers.length,
      'the colour swatch and the options menu each need one — deleting either as ' +
      'redundant re-exposes it as disabled to every screen reader',
    ).toBe(2)
  })
})
