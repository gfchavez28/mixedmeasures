/**
 * Row 47 — adding a record, and the two things a copy of this would get wrong.
 *
 * The mutation itself is one POST; what earns a test is (a) the invalidation
 * SET, which `deleteRow` had wrong until this hook was extracted, and (b) that
 * each surface's landing is its own decision rather than the hook's.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

const createRow = vi.fn()
vi.mock('@/lib/api', () => ({
  datasetsApi: { createRow: (...a: unknown[]) => createRow(...a) },
  extractApiError: (_e: unknown, fallback: string) => fallback,
  DATASET_PAGE_SIZE: 200,
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { useAddRecord } from './useAddRecord'
import { toast } from 'sonner'

const CREATED = {
  row_id: 51, row_identifier: 'R0051', index: 250, offset: 200,
  limit: 200, total_rows: 251,
}

function wrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

describe('useAddRecord', () => {
  let qc: QueryClient
  let invalidated: unknown[][]

  beforeEach(() => {
    vi.clearAllMocks()
    createRow.mockResolvedValue(CREATED)
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    invalidated = []
    vi.spyOn(qc, 'invalidateQueries').mockImplementation((filters) => {
      invalidated.push((filters as { queryKey: unknown[] }).queryKey)
      return Promise.resolve()
    })
  })

  it('asks for the page size the grid will then request', async () => {
    const { result } = renderHook(() => useAddRecord(1, 2), { wrapper: wrapper(qc) })
    act(() => { result.current.addRecord() })
    await waitFor(() => expect(createRow).toHaveBeenCalled())
    // ⚠️ A mismatched `limit` returns an offset addressing a page boundary the
    // grid does not use (#800's contract, shared with `rowPosition`).
    expect(createRow).toHaveBeenCalledWith(1, 2, 200)
  })

  it('🔴 invalidates the ROW-COUNT readers, not just the grid', async () => {
    // This is the defect `deleteRow` carried: `['dataset-data']` alone, so the
    // list page's Records count and the Text Coding `N/M responded` rate — a
    // ROW count since #830(d) — stayed stale for the 60s staleTime.
    const { result } = renderHook(() => useAddRecord(1, 2), { wrapper: wrapper(qc) })
    act(() => { result.current.addRecord() })
    await waitFor(() => expect(invalidated.length).toBeGreaterThan(0))

    const heads = invalidated.map(k => k[0])
    for (const key of ['dataset-data', 'datasets', 'text-columns', 'dq-summary']) {
      expect(heads, `a row-set change must invalidate ${key}`).toContain(key)
    }
  })

  it('hands the created record to the caller, position included', async () => {
    const onAdded = vi.fn()
    const { result } = renderHook(() => useAddRecord(1, 2, onAdded), { wrapper: wrapper(qc) })
    act(() => { result.current.addRecord() })
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(CREATED))
    // The offset is the point: a new record sorts LAST, so it is not on the
    // page the researcher is looking at.
    expect(onAdded.mock.calls[0][0].offset).toBe(200)
  })

  it('names the record it made', async () => {
    const { result } = renderHook(() => useAddRecord(1, 2), { wrapper: wrapper(qc) })
    act(() => { result.current.addRecord() })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Record R0051 added'))
  })

  it('reports a refusal instead of failing silently', async () => {
    createRow.mockRejectedValue(new Error('nope'))
    const onAdded = vi.fn()
    const { result } = renderHook(() => useAddRecord(1, 2, onAdded), { wrapper: wrapper(qc) })
    act(() => { result.current.addRecord() })
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(onAdded, 'no landing on a failed create').not.toHaveBeenCalled()
  })
})
