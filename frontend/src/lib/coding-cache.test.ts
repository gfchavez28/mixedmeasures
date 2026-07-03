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
    expect(keys).toHaveLength(10)
  })
})
