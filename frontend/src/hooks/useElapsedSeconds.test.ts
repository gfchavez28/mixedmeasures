import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useElapsedSeconds } from './useElapsedSeconds'

afterEach(() => {
  vi.useRealTimers()
})

describe('useElapsedSeconds', () => {
  it('counts from the start of a run', () => {
    vi.useFakeTimers()
    const { result } = renderHook(({ active }) => useElapsedSeconds(active), {
      initialProps: { active: true },
    })
    expect(result.current).toBe(0)
    act(() => { vi.advanceTimersByTime(3000) })
    expect(result.current).toBeCloseTo(3, 0)
  })

  it('🔴 #1038 (c) — the FIRST render of a new run reads 0, never the previous run’s time', () => {
    // The start was reset in the effect, which runs after the new run's first
    // render; that render returned the last run's elapsed time, and Dataset
    // Import's announcer said "Still working — 40 seconds elapsed" as an import
    // began after a long preview.
    vi.useFakeTimers()
    const seen: number[] = []
    const { rerender } = renderHook(({ active }) => {
      const s = useElapsedSeconds(active)
      seen.push(s)
      return s
    }, { initialProps: { active: true } })
    act(() => { vi.advanceTimersByTime(40_000) })
    rerender({ active: false })
    act(() => { vi.advanceTimersByTime(5_000) })
    seen.length = 0
    rerender({ active: true })
    expect(seen[0]).toBe(0)
    expect(Math.max(...seen)).toBeLessThan(1)
  })

  it('reads 0 while inactive', () => {
    const { result } = renderHook(() => useElapsedSeconds(false))
    expect(result.current).toBe(0)
  })
})
