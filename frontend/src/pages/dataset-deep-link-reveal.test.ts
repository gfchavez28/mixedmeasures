/**
 * A link to a record in the Data view marks the record even when its page is
 * the one already showing (found driving #985's record links, 2026-09-27).
 *
 * The reveal effect ran off `data` alone. A link to a row on ANOTHER page moves
 * the page, `data` changes, and the reveal runs; a link to a row on the page
 * already showing changes nothing `data` holds, so the jump was dropped —
 * measured: followed from inside the Data view it marked nothing, and followed
 * from another page it worked only because the position lookup beat the page's
 * data by 1 ms. Every request now bumps `revealRequest`, which the effect reads.
 *
 * ⚠️ A SOURCE scan, because jsdom cannot render `DatasetView` (the grid needs
 * layout it does not compute); the behaviour itself was driven live. The two
 * facts pinned are the ones the fix consists of: every place that ARMS a
 * reveal also requests one, and the effect listens for the request.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '@/lib/strip-comments'
import { SRC_DIR } from '@/test-support/source-tree'

const src = stripComments(readFileSync(join(SRC_DIR, 'pages/DatasetView.tsx'), 'utf8'), 'DatasetView.tsx')

/** Every `pendingRevealRef.current = {` assignment with the text that follows it. */
function armingSites(source: string): string[] {
  const out: string[] = []
  const re = /pendingRevealRef\.current\s*=\s*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source))) out.push(source.slice(m.index, m.index + 200))
  return out
}

describe('the Data view reveals a linked record on the page already showing', () => {
  it('finds the places that arm a reveal (population self-check)', () => {
    // The search deep link and the added record — a scan that found none would
    // pass the assertion below by finding nothing.
    expect(armingSites(src).length).toBeGreaterThanOrEqual(2)
  })

  it('every place that arms a reveal also requests one', () => {
    for (const site of armingSites(src)) {
      expect(site).toMatch(/pendingRevealRef\.current = \{[^}]*\}\s*\n\s*setRevealRequest\(/)
    }
  })

  it('the reveal effect runs on a request, not only on new data', () => {
    expect(src).toMatch(/revealRecordCell\(tableRef\.current[\s\S]{0,400}?\}, \[data, revealRequest\]\)/)
  })

  it('the arming matcher would catch a site that forgets', () => {
    const planted = 'pendingRevealRef.current = { rowId: 1, columnId: null }\n    setPageOffset(0)\n'
    expect(armingSites(planted)).toHaveLength(1)
    expect(armingSites(planted)[0]).not.toMatch(/\}\s*\n\s*setRevealRequest\(/)
  })
})
