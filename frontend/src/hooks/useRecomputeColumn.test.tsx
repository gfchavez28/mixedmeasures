/**
 * #1174 (R4) — recomputing a computed variable refreshes the saved statistics'
 * out-of-date markers it raises.
 *
 * ⚠️ Tested at the HOOK, the narrowest seam that runs the real code: both
 * pages that offer Recompute (the Data view, the Variables view) now call this
 * one mutation, and neither page has a render harness — mounting either for one
 * menu item would test the harness more than the wiring.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

const api = vi.hoisted(() => ({ recomputeColumn: vi.fn() }))
vi.mock('@/lib/api', () => ({
  datasetsApi: { recomputeColumn: api.recomputeColumn },
  extractApiError: (_e: unknown, fallback: string) => fallback,
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { useRecomputeColumn } from './useRecomputeColumn'

afterEach(() => {
  cleanup()
  api.recomputeColumn.mockReset()
})

function setup() {
  const client = new QueryClient()
  for (const key of [
    ['dataset-data', 3, 5, 0],
    ['dataset-columns', 3, 5],
    ['metrics', 3],
    ['statistical-tests', 3],
    ['domain-scores', 3, 5],
    ['codes', 3],                       // unrelated — must stay fresh
  ]) client.setQueryData(key, {})
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const { result } = renderHook(() => useRecomputeColumn(3, 5), { wrapper })
  return { client, result }
}

const invalidated = (client: QueryClient, key: unknown[]) => client.getQueryState(key)?.isInvalidated

describe('#1174 — the recompute refreshes what it marks', () => {
  it('🔴 invalidates the metrics list (the markers), not only the grid', async () => {
    api.recomputeColumn.mockResolvedValue({})
    const { client, result } = setup()
    act(() => { result.current.mutate(9) })
    await waitFor(() => expect(invalidated(client, ['metrics', 3])).toBe(true))
    expect(api.recomputeColumn).toHaveBeenCalledWith(3, 5, 9)
    expect(invalidated(client, ['statistical-tests', 3])).toBe(true)
    expect(invalidated(client, ['domain-scores', 3, 5])).toBe(true)
    // What the two hand-lists did cover, still covered.
    expect(invalidated(client, ['dataset-data', 3, 5, 0])).toBe(true)
    expect(invalidated(client, ['dataset-columns', 3, 5])).toBe(true)
    expect(invalidated(client, ['codes', 3])).toBe(false)
  })

  it('a failed recompute invalidates nothing', async () => {
    api.recomputeColumn.mockRejectedValue(new Error('no'))
    const { client, result } = setup()
    act(() => { result.current.mutate(9) })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(invalidated(client, ['metrics', 3])).toBe(false)
  })
})
