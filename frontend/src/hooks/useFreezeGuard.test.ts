/**
 * Track J · J3-1: the "Freeze Codebook" soft-lock guard. When unfrozen, actions run
 * immediately; when frozen, they defer behind a warning the user can dismiss
 * (cancel) or accept (proceed-anyway).
 */
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useFreezeGuard } from './useFreezeGuard'

function setup(frozen: boolean) {
  return renderHook(({ isFrozen }: { isFrozen: boolean }) => useFreezeGuard(isFrozen), {
    initialProps: { isFrozen: frozen },
  })
}

describe('useFreezeGuard', () => {
  it('runs the action immediately when not frozen', () => {
    const { result } = setup(false)
    const proceed = vi.fn()
    act(() => result.current.guard(proceed))
    expect(proceed).toHaveBeenCalledTimes(1)
    expect(result.current.warnOpen).toBe(false)
  })

  it('defers the action and opens the warning when frozen', () => {
    const { result } = setup(true)
    const proceed = vi.fn()
    act(() => result.current.guard(proceed))
    expect(proceed).not.toHaveBeenCalled()
    expect(result.current.warnOpen).toBe(true)
  })

  it('onProceed runs the deferred action and closes the warning', () => {
    const { result } = setup(true)
    const proceed = vi.fn()
    act(() => result.current.guard(proceed))
    act(() => result.current.onProceed())
    expect(proceed).toHaveBeenCalledTimes(1)
    expect(result.current.warnOpen).toBe(false)
  })

  it('onCancel discards the deferred action', () => {
    const { result } = setup(true)
    const proceed = vi.fn()
    act(() => result.current.guard(proceed))
    act(() => result.current.onCancel())
    expect(proceed).not.toHaveBeenCalled()
    expect(result.current.warnOpen).toBe(false)
  })

  it('respects a frozen-state change between renders', () => {
    const { result, rerender } = setup(false)
    const a = vi.fn()
    act(() => result.current.guard(a))
    expect(a).toHaveBeenCalledTimes(1) // not frozen → immediate

    rerender({ isFrozen: true })
    const b = vi.fn()
    act(() => result.current.guard(b))
    expect(b).not.toHaveBeenCalled() // now frozen → deferred
    expect(result.current.warnOpen).toBe(true)
  })
})
