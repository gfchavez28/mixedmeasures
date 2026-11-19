/**
 * #1679 D369 — the joint display's three reads do not refetch on window focus. With React
 * Query's default, every display on an open canvas re-ran its compute (and its pins' facts and
 * its misfit counts) when the window regained focus after a minute: four or more heavy gathers
 * at once, the case the server's lock (D368) serialises but cannot make cheap. A SOURCE scan,
 * stated as such — jsdom has no window focus to give back.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { stripComments } from '@/lib/strip-comments'

const src = (rel: string) => stripComments(readFileSync(`${__dirname}/../../../${rel}`, 'utf8'))

/** The options object of the query whose key starts with `key`, up to the next query key or
 *  the end of the file — an inner `})` (a request body) is not its end. */
function queryOptions(file: string, key: string): string {
  const at = file.indexOf(`queryKey: ['${key}'`)
  expect(at, `no query keyed '${key}'`).toBeGreaterThan(-1)
  const next = file.indexOf('queryKey:', at + 1)
  return file.slice(at, next < 0 ? undefined : next)
}

describe('#1679 D369 — no refetch on focus', () => {
  const view = src('components/canvas/extensions/JointDisplayView.tsx')
  it.each(['joint-display', 'joint-display-pin-facts'])('the view’s %s read', key => {
    expect(queryOptions(view, key)).toMatch(/refetchOnWindowFocus: false/)
  })
  it('the misfit counts (`useMisfitReads`)', () => {
    expect(queryOptions(src('components/canvas/joint-display/useMisfitReads.ts'), 'joint-display-cases'))
      .toMatch(/refetchOnWindowFocus: false/)
  })
  it('falsifier: a query without the option is caught', () => {
    expect("queryKey: ['x', 1],\n  staleTime: 60_000,\n})").not.toMatch(/refetchOnWindowFocus: false/)
  })
})
