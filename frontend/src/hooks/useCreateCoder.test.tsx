/**
 * Unit tests for `useCreateCoder` — the #530 shared create-coder chokepoint.
 * Every "Add coder" surface (TopRail menu, Settings identity section, Dashboard
 * switcher) routes through this hook, so its contract is what keeps the three
 * surfaces in agreement: create → invalidate the `['coders']` roster → hand the
 * created coder to the caller (who then switches via requestSwitch skipConfirm).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useCreateCoder } from './useCreateCoder'
import { authApi } from '@/lib/api'
import { toast } from 'sonner'

vi.mock('@/lib/api', () => ({
  authApi: { createCoder: vi.fn() },
}))
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  }
}

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
}

describe('useCreateCoder', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates, invalidates the coders roster, and hands the coder to onCreated', async () => {
    const qc = makeClient()
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')
    vi.mocked(authApi.createCoder).mockResolvedValue({
      id: 7,
      username: 'Blake',
      display_color: null,
      archived: false,
    } as Awaited<ReturnType<typeof authApi.createCoder>>)
    const onCreated = vi.fn()

    const { result } = renderHook(() => useCreateCoder({ onCreated }), {
      wrapper: makeWrapper(qc),
    })
    result.current.mutate('Blake')

    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith(
        expect.objectContaining({ id: 7, username: 'Blake' }),
      ),
    )
    expect(authApi.createCoder).toHaveBeenCalledWith('Blake')
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['coders'] })
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('surfaces the backend detail on failure and never calls onCreated', async () => {
    const qc = makeClient()
    vi.mocked(authApi.createCoder).mockRejectedValue(
      Object.assign(new Error('conflict'), {
        response: { data: { detail: 'A coder with this name already exists' } },
      }),
    )
    const onCreated = vi.fn()

    const { result } = renderHook(() => useCreateCoder({ onCreated }), {
      wrapper: makeWrapper(qc),
    })
    result.current.mutate('Dup')

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('A coder with this name already exists'),
    )
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('falls back to a generic error message when the failure carries no detail', async () => {
    const qc = makeClient()
    vi.mocked(authApi.createCoder).mockRejectedValue(new Error('network down'))

    const { result } = renderHook(() => useCreateCoder(), {
      wrapper: makeWrapper(qc),
    })
    result.current.mutate('Blake')

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Could not create coder'),
    )
  })
})
