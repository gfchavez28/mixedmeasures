import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from './strip-comments'

/**
 * #772 — the dataset grid's headers must say which way they head.
 *
 * The grid is a real `<table>` with a real `<caption>` and real `<th>`s, and it
 * was still unnavigable by cell: not one header carried `scope`, and every body
 * cell was a `<td>` — including the record id. So moving across row 47 of a
 * 120×11 grid announced "Post_Score, 14" with nothing to say WHOSE 14 it was.
 * The sibling analysis table (`DetailedFrequencyTable`) had carried
 * `scope="col"`/`scope="row"` all along, which is what the target shape is.
 *
 * ⚠️ This is a SOURCE SCAN, not a render test, and that is deliberate. The risk
 * is not that today's headers regress — it is that the FIFTH header site is
 * added without `scope`, in a grid whose four existing sites are split across
 * two files. A render test over today's columns cannot see that; a scan fails
 * the moment a bare `<th` appears.
 *
 * ⚠️ Deliberately NOT asserted here: `aria-rowcount` / `aria-rowindex`. Measured
 * 2026-08-17 — this grid renders all 120 rows, it is not virtualised, so the DOM
 * holds the whole set and a screen reader counts it correctly unaided. Those
 * attributes belong where the DOM does NOT hold the set (#751's virtualised
 * listbox). Adding them here would be cargo-culting the shape of that fix.
 */

const SRC = join(__dirname, '..')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

/** Every file that renders a cell of the dataset grid. */
const GRID_SOURCES = [
  'pages/DatasetView.tsx',
  'components/DatasetGridComponents.tsx',
] as const

/**
 * ⚠️ Comments come off FIRST, and that is not fussiness — the first run of this
 * scan reported two failures, both of them its OWN doing. The tag regex stopped
 * at a `>` sitting inside a JSX comment, mis-reading a properly-scoped header as
 * bare; then it matched the literal `<th>` written in that comment's prose. A
 * scan that reads prose as markup reports PHANTOMS, which is worse than one that
 * finds nothing, because the phantom looks like a real defect in real code
 * (#728's parser lesson, one guard over).
 *
 * The stripping itself is `@/lib/strip-comments` — the regex this file used to
 * carry blanked real code on 24 files of the tree, its own included.
 */

/**
 * Opening `<th` tags, with the attribute text up to the closing `>` of the tag.
 * JSX attribute values in these files never contain a bare `>` once comments are
 * gone, so this is sufficient.
 */
function headerTags(source: string): string[] {
  return [...stripComments(source).matchAll(/<th(\s[^>]*)?>/g)].map(m => m[0])
}

describe('#772: dataset-grid header cells declare their scope', () => {
  it('finds the header sites it is meant to be guarding', () => {
    // The population self-check. A scan whose expected result is empty passes
    // by finding nothing — including when the selector has rotted (#730).
    const total = GRID_SOURCES.reduce((n, f) => n + headerTags(read(f)).length, 0)
    expect(total).toBeGreaterThanOrEqual(4)
  })

  it('every <th> in the dataset grid carries a scope', () => {
    const bare: string[] = []
    for (const file of GRID_SOURCES) {
      for (const tag of headerTags(read(file))) {
        if (!/\bscope=/.test(tag)) bare.push(`${file}: ${tag.slice(0, 80)}`)
      }
    }
    expect(bare).toEqual([])
  })

  it('the record identifier is a ROW header, not a data cell', () => {
    // The half that is easy to lose: `scope="col"` on the headers alone still
    // leaves every row anonymous. `recordLabel` is the row's identity, so the
    // cell that renders it is the row's header.
    const src = read('components/DatasetGridComponents.tsx')
    const recordCell = src.match(/<th[^>]*scope="row"[^>]*>\s*\{recordLabel\}/)
    expect(recordCell).not.toBeNull()
  })

  it('the record header keeps an explicit text alignment', () => {
    // `<th>` centres by UA default where `<td>` does not, so the td→th change
    // silently re-aligns the sticky identity column unless `text-left` rides
    // along. Pinned because it is invisible in review and in jsdom alike.
    const src = read('components/DatasetGridComponents.tsx')
    const tag = src.match(/<th[^>]*scope="row"[^>]*>/)![0]
    expect(tag).toMatch(/text-left/)
  })
})

/**
 * #776 — a column header must not claim a sort the grid does not have.
 *
 * dnd-kit's default `roleDescription` is the literal string "sortable", meaning
 * *drag-reorderable*. On a table column header that word already means sort by
 * value, and this grid has no sort at all — no `aria-sort`, no handler. So every
 * header announced a capability that does not exist, once per column across a
 * row, to the only users who hear it. Heard on 2026-08-18, not reasoned.
 *
 * ⚠️ A SCAN rather than a render test for the same reason as the header scan
 * above: the risk is the SECOND sortable added to this grid inheriting the
 * default, which a test over today's markup cannot see.
 */
describe('#776 — drag affordances in the grid do not borrow the word "sortable"', () => {
  for (const rel of GRID_SOURCES) {
    it(`${rel}: every useSortable states its own roleDescription`, () => {
      // ⚠️ Comments off first — the same trap the header scan above records.
      // The first run of THIS scan failed on the explanatory comment beside the
      // fix, which names `aria-sort` in prose. A scan that reads its own
      // documentation is measuring the wrong file.
      const src = stripComments(read(rel))
      const sortables = src.match(/useSortable\(/g)?.length ?? 0
      const overrides = src.match(/roleDescription:/g)?.length ?? 0
      expect(overrides).toBe(sortables)
      if (sortables > 0) {
        expect(src).not.toMatch(/roleDescription:\s*'sortable'/)
      }
    })
  }

  it('the grid really has no sort, so the claim would be false either way', () => {
    for (const rel of GRID_SOURCES) {
      expect(stripComments(read(rel))).not.toMatch(/aria-sort/)
    }
  })
})

/**
 * The `<caption>` must be the table's FIRST child (HTML requires it). This one
 * sat after `<colgroup>` — the only caption site in the app that did. Browsers
 * recover and NVDA read it correctly, so nothing was visibly broken; the scan
 * exists because the next person to add a `<colgroup>` has no reason to know.
 */
describe('caption placement', () => {
  it('DatasetView puts <caption> before <colgroup>', () => {
    const src = stripComments(read('pages/DatasetView.tsx'))
    const caption = src.indexOf('<caption')
    const colgroup = src.indexOf('<colgroup')
    expect(caption).toBeGreaterThan(-1)
    expect(colgroup).toBeGreaterThan(-1)
    expect(caption).toBeLessThan(colgroup)
  })
})
