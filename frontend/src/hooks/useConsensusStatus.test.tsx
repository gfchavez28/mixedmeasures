/**
 * Track J · J2-5 M-2 — useConsensusStatus fetches the consensus-layer status
 * (drives the layer selector's "offer consensus only when it exists").
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

vi.mock('@/lib/api', () => ({
  codeAnalysisApi: {
    consensusStatus: vi.fn().mockResolvedValue({ enabled: true, exists: true, stale_count: 2 }),
  },
}))

import { useConsensusStatus } from './useConsensusStatus'
import { codeAnalysisApi } from '@/lib/api'

afterEach(cleanup)

const wrapper = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

describe('useConsensusStatus', () => {
  it('fetches consensus status for the project', async () => {
    const { result } = renderHook(() => useConsensusStatus(42), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(codeAnalysisApi.consensusStatus).toHaveBeenCalledWith(42)
    expect(result.current.data).toEqual({ enabled: true, exists: true, stale_count: 2 })
  })

  it('stays idle until a real projectId resolves', () => {
    const { result } = renderHook(() => useConsensusStatus(0), { wrapper: wrapper() })
    expect(result.current.fetchStatus).toBe('idle')
  })
})
