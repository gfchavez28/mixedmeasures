/**
 * #1615 — quick compute (every Descriptives chart on the Quantitative page) carries the blind
 * scope it is given: the viewer alone while withholding, nothing (every coder) otherwise.
 * The page passes `useAnalysisScope().coderIds`; this pins that the hook forwards it.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const quickCompute = vi.hoisted(() => vi.fn())
vi.mock('../lib/api', () => ({ metricsApi: { quickCompute } }))

import { useQuickCompute } from './useQuickCompute'

beforeEach(() => {
  vi.useFakeTimers()
  quickCompute.mockResolvedValue({ metrics: [], computed_count: 0, reused_count: 0 })
})
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

async function send(coderIds: number[] | null | undefined) {
  const { result } = renderHook(() => useQuickCompute(1))
  act(() => { result.current.compute({ columnIds: [10], domainIds: [], metricType: 'mean', coderIds }) })
  await act(async () => { await vi.advanceTimersByTimeAsync(400) })
  expect(quickCompute).toHaveBeenCalledTimes(1)
  return quickCompute.mock.calls[0][1] as Record<string, unknown>
}

describe('quick compute carries the blind scope (#1615)', () => {
  it('the viewer alone while withholding', async () => {
    expect((await send([7])).coder_ids).toEqual([7])
  })
  it('positive control: every coder — no coder_ids in the body at all', async () => {
    const body = await send(null)
    expect('coder_ids' in body ? body.coder_ids : undefined).toBeUndefined()
  })
})
