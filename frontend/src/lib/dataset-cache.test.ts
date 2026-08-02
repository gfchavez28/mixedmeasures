import { describe, it, expect, vi } from 'vitest'
import type { QueryClient } from '@tanstack/react-query'
import { invalidateColumnDictionary } from './dataset-cache'

function makeQc() {
  const invalidateQueries = vi.fn()
  return { qc: { invalidateQueries } as unknown as QueryClient, invalidateQueries }
}

describe('invalidateColumnDictionary (#608)', () => {
  it('invalidates the full column-dictionary reader set', () => {
    const { qc, invalidateQueries } = makeQc()
    invalidateColumnDictionary(qc, 7, 3)

    const keys = invalidateQueries.mock.calls.map(
      (c) => (c[0] as { queryKey: unknown[] }).queryKey[0] as string,
    )
    // Every reader of value labels / declared missing / scale metadata / the
    // primary recode (the confirmed #608 gap matrix + the six families the
    // scope added). `data-quality` must NOT reappear — it matches nothing;
    // the real DQ keys are dq-summary / dq-patterns.
    expect(keys).toEqual([
      'dataset-data',
      'dataset-columns',
      'column-frequencies',
      'recode-definitions',
      'project-columns',
      'analysis-columns',
      'metrics',
      'domain-scores',
      'group-comparison',
      'analysis-cross-tab',
      'correlation-matrix',
      'scatter-matrix',
      'statistical-tests',
      'dq-summary',
      'dq-patterns',
    ])
    expect(keys).not.toContain('data-quality')
  })

  it('dataset-scoped keys carry (projectId, datasetId); project keys carry projectId', () => {
    const { qc, invalidateQueries } = makeQc()
    invalidateColumnDictionary(qc, 42, 9)
    const byRoot = new Map<string, unknown[]>(
      invalidateQueries.mock.calls.map((c) => {
        const k = (c[0] as { queryKey: unknown[] }).queryKey
        return [k[0] as string, k]
      }),
    )
    expect(byRoot.get('dataset-data')).toEqual(['dataset-data', 42, 9])
    expect(byRoot.get('column-frequencies')).toEqual(['column-frequencies', 42, 9])
    expect(byRoot.get('dq-summary')).toEqual(['dq-summary', 42])
    for (const k of byRoot.values()) expect(k[1]).toBe(42)
  })
})
