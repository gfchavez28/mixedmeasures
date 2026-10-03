/**
 * #1073 (c) — the Data view does not start a second participant-table refresh
 * while one runs.
 *
 * The header's Refresh button is disabled while its request runs, but the
 * per-column *Refresh scores* item (the column menu and the column editor, both
 * through `handleRecompute`) was not — and two refreshes at once raced into the
 * database: one died on a unique index and marked the other's fresh scores out of
 * date. The server now refuses the second (409); the page spares the request and
 * says why instead of showing that refusal as an error.
 *
 * ⚠️ A SOURCE scan, because jsdom cannot render `DatasetView`
 * (`dataset-deep-link-reveal.test.ts`'s reason). The server half is behavioural:
 * `test_participant_refresh_concurrency.py::TestOneRefreshAtATime`.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '@/lib/strip-comments'
import { SRC_DIR } from '@/test-support/source-tree'

const src = stripComments(readFileSync(join(SRC_DIR, 'pages/DatasetView.tsx'), 'utf8'), 'DatasetView.tsx')

/** The body of `handleRecompute`'s callback. */
function recomputeHandler(source: string): string | null {
  const m = source.match(/const handleRecompute = useCallback\(\(q: DatasetColumn\) => \{([\s\S]*?)\n {2}\}, \[/)
  return m ? m[1] : null
}

describe('#1073 (c) — the per-column refresh does not start a second one', () => {
  it('finds the handler (a scan that finds nothing would pass)', () => {
    expect(recomputeHandler(src)).not.toBeNull()
  })

  it('asks whether a refresh is already running BEFORE starting one', () => {
    const body = recomputeHandler(src)!
    const guard = body.indexOf('refreshParticipantsMut.isPending')
    const start = body.indexOf('refreshParticipantsMut.mutate()')
    expect(guard).toBeGreaterThanOrEqual(0)
    expect(start).toBeGreaterThan(guard)
    expect(body.slice(guard, start)).toMatch(/return/)
  })

  it('the matcher would catch a handler that forgets', () => {
    const planted = `const handleRecompute = useCallback((q: DatasetColumn) => {
    if (isManagedColumn(q)) refreshParticipantsMut.mutate()
    else recomputeMut.mutate(q.id)
  }, [`
    expect(recomputeHandler(planted)).not.toContain('isPending')
  })
})
