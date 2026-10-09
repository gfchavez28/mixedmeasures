import { describe, it, expect, vi } from 'vitest'
import type { QueryClient } from '@tanstack/react-query'
import { invalidateDerivedCounts } from './coding-cache'

function makeQc() {
  const invalidateQueries = vi.fn()
  return { qc: { invalidateQueries } as unknown as QueryClient, invalidateQueries }
}

function invalidatedKeys(invalidateQueries: ReturnType<typeof vi.fn>): string[] {
  return invalidateQueries.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey[0] as string)
}

describe('invalidateDerivedCounts (#450)', () => {
  it('invalidates the full cross-surface derived-count key set', () => {
    const { qc, invalidateQueries } = makeQc()
    invalidateDerivedCounts(qc, 7)

    const keys = invalidatedKeys(invalidateQueries)
    // Every cross-surface reader that a code change can stale (the confirmed gap matrix).
    expect(keys).toEqual([
      'search',
      'project-summary',
      'codebook-tree',
      'consensus-status',
      'code-sample-segments',
      'irr',
      'reconciliation',
      'machine-agreement', // #1030 — a coding on either side moves the model comparison
      'coder-coverage',
    ])
  })

  it('keys carry the projectId for prefix-match invalidation', () => {
    const { qc, invalidateQueries } = makeQc()
    invalidateDerivedCounts(qc, 42)
    for (const call of invalidateQueries.mock.calls) {
      expect((call[0] as { queryKey: unknown[] }).queryKey[1]).toBe(42)
    }
  })

  it('does NOT touch dataset metrics by default (conversation/document coding)', () => {
    const { qc, invalidateQueries } = makeQc()
    invalidateDerivedCounts(qc, 1)
    const keys = invalidatedKeys(invalidateQueries)
    expect(keys).not.toContain('metrics')
    expect(keys).not.toContain('canvas-chart')
  })

  it('adds metrics + canvas-chart when opts.metrics is set (text-coding / qual-analysis)', () => {
    const { qc, invalidateQueries } = makeQc()
    invalidateDerivedCounts(qc, 1, { metrics: true })
    const keys = invalidatedKeys(invalidateQueries)
    expect(keys).toContain('metrics')
    expect(keys).toContain('canvas-chart')
    expect(keys).toHaveLength(11)
  })
})

describe('invalidateAfterCodingImport (#1038 d, #1082 c)', () => {
  it('🔴 stales EVERY query in the cache — a SOURCE-keyed segment list included', async () => {
    const { QueryClient: RealClient } = await import('@tanstack/react-query')
    const { invalidateAfterCodingImport } = await import('./coding-cache')
    const qc = new RealClient()
    const keys: unknown[][] = [
      ['code-frequencies', 7, { coder: 'x' }],
      ['text-coding-texts', '7'],          // a route param reaches keys as text
      ['codes', 7],
      // #1082 (c): the conversation workbench keys its segments by CONVERSATION, so
      // "this project's queries" (`queryKey[1] === projectId`) never matched it, and
      // imported chips were missing there until the 60 s staleTime ran out.
      ['segments', 42],
      ['dataset-data', 9],                 // keyed by dataset — the same shape
      ['participant-detail', 3],           // keyed by participant
      ['coders'],                          // the roster: the page also RESETS it (#964)
    ]
    for (const key of keys) qc.setQueryData(key, 1)

    invalidateAfterCodingImport(qc, 7)

    // Population, not a list of expectations: a key shape nobody named here is covered too.
    const all = qc.getQueryCache().getAll()
    expect(all.length).toBe(keys.length)
    expect(all.filter(q => !q.state.isInvalidated).map(q => q.queryKey)).toEqual([])
  })
})
