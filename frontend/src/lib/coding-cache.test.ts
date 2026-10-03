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

describe('invalidateAfterCodingImport (#1038 d)', () => {
  it('🔴 stales EVERY query of the project — a number or a string id — and no other project', async () => {
    const { QueryClient: RealClient } = await import('@tanstack/react-query')
    const { invalidateAfterCodingImport } = await import('./coding-cache')
    const qc = new RealClient()
    qc.setQueryData(['code-frequencies', 7, { coder: 'x' }], 1)
    qc.setQueryData(['text-coding-texts', '7'], 1)     // a route param reaches keys as text
    qc.setQueryData(['codes', 7], 1)
    qc.setQueryData(['codes', 8], 1)                   // another project
    qc.setQueryData(['coders'], 1)                     // the roster: reset by the page itself

    invalidateAfterCodingImport(qc, 7)

    const stale = (key: unknown[]) => qc.getQueryState(key)?.isInvalidated
    expect(stale(['code-frequencies', 7, { coder: 'x' }])).toBe(true)
    expect(stale(['text-coding-texts', '7'])).toBe(true)
    expect(stale(['codes', 7])).toBe(true)
    expect(stale(['codes', 8])).toBe(false)
    expect(stale(['coders'])).toBe(false)
  })
})
