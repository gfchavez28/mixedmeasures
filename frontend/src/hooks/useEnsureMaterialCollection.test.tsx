/**
 * #469b — useEnsureMaterialCollection: returns the existing default collection id,
 * or lazily creates the "Materials" collection (and invalidates) when there is none,
 * so "Add to Materials" is never a dead-end on a collection-less project.
 */
import type { ReactNode } from 'react'
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('@/lib/api', () => ({
  materialsApi: { createCollection: vi.fn() },
}))

import { useEnsureMaterialCollection } from './useEnsureMaterialCollection'
import { materialsApi } from '@/lib/api'

const createCollection = materialsApi.createCollection as unknown as Mock

function wrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

beforeEach(() => {
  createCollection.mockReset()
})

describe('useEnsureMaterialCollection', () => {
  it('returns the existing collection id without creating one', async () => {
    const qc = new QueryClient()
    const { result } = renderHook(() => useEnsureMaterialCollection(7, 42), { wrapper: wrapper(qc) })

    let resolved: number | undefined
    await act(async () => { resolved = await result.current() })

    expect(resolved).toBe(42)
    expect(createCollection).not.toHaveBeenCalled()
  })

  it('lazily creates the default collection when there is none, then invalidates', async () => {
    const qc = new QueryClient()
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')
    createCollection.mockResolvedValue({ id: 99, project_id: 7, name: 'Materials' })

    const { result } = renderHook(() => useEnsureMaterialCollection(7, null), { wrapper: wrapper(qc) })

    let resolved: number | undefined
    await act(async () => { resolved = await result.current() })

    expect(resolved).toBe(99)
    expect(createCollection).toHaveBeenCalledWith(7)
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['material-collections', 7] })
  })
})
