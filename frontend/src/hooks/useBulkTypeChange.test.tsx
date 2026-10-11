/**
 * #1145 / #1174 — the bulk type change refreshes what it re-derives and marks.
 * Tested at the hook for the reason `useRecomputeColumn.test.tsx` gives: the
 * Variables view has no render harness.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

const api = vi.hoisted(() => ({ bulkTypeUpdate: vi.fn() }))
vi.mock('@/lib/api', () => ({
  recodeApi: { bulkTypeUpdate: api.bulkTypeUpdate },
  extractApiError: (_e: unknown, fallback: string) => fallback,
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { useBulkTypeChange } from './useBulkTypeChange'

afterEach(() => {
  cleanup()
  api.bulkTypeUpdate.mockReset()
})

function setup() {
  const client = new QueryClient()
  for (const key of [['dataset-columns', 3, 5], ['metrics', 3], ['codes', 3]]) client.setQueryData(key, {})
  const onDone = vi.fn()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const { result } = renderHook(() => useBulkTypeChange(3, 5, onDone), { wrapper })
  return { client, result, onDone }
}

const invalidated = (client: QueryClient, key: unknown[]) => client.getQueryState(key)?.isInvalidated

describe('the bulk type change', () => {
  it('🔴 refreshes the metrics list (the out-of-date markers), not only the columns', async () => {
    api.bulkTypeUpdate.mockResolvedValue({ status: 'ok', updated: 2 })
    const { client, result, onDone } = setup()
    act(() => { result.current.mutate({ columnIds: [7, 8], columnType: 'numeric' }) })
    await waitFor(() => expect(invalidated(client, ['metrics', 3])).toBe(true))
    expect(api.bulkTypeUpdate).toHaveBeenCalledWith(3, 5, [7, 8], 'numeric')
    expect(invalidated(client, ['dataset-columns', 3, 5])).toBe(true)
    expect(invalidated(client, ['codes', 3])).toBe(false)
    expect(onDone).toHaveBeenCalledOnce()
  })

  it('a refused change refreshes nothing and keeps the selection', async () => {
    api.bulkTypeUpdate.mockRejectedValue(new Error('409'))
    const { client, result, onDone } = setup()
    act(() => { result.current.mutate({ columnIds: [7], columnType: 'numeric' }) })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(invalidated(client, ['metrics', 3])).toBe(false)
    expect(onDone).not.toHaveBeenCalled()
  })
})
