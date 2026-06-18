/**
 * Tests for useMutedDatasetDots — per-project muted-dot state hook.
 *
 * Two layers: per-dataset Set + global allMuted boolean. `isMuted` returns
 * true when EITHER condition holds (allMuted is the master switch).
 *
 * Persistence is per-project via localStorage with keys:
 *   `mm-crosswalk-muted-dots-${projectId}` (JSON array of dataset IDs)
 *   `mm-crosswalk-all-dots-muted-${projectId}` ("0" or "1")
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useMutedDatasetDots } from './useMutedDatasetDots'

// Stub localStorage with an in-memory object — jsdom 29's Storage proxy
// implementation has uneven function-binding behavior that breaks direct
// `getItem`/`setItem`/`clear` calls from test assertions in this vitest
// configuration. Install a clean in-memory shim per-test so the hook's
// localStorage access works deterministically.
let store: Record<string, string> = {}
beforeEach(() => {
  store = {}
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => {
        store[k] = String(v)
      },
      removeItem: (k: string) => {
        delete store[k]
      },
      clear: () => {
        store = {}
      },
      key: (i: number) => Object.keys(store)[i] ?? null,
      get length() {
        return Object.keys(store).length
      },
    },
  })
})
afterEach(() => {
  store = {}
})

describe('useMutedDatasetDots', () => {
  it('starts with empty state — no muted datasets, allMuted false', () => {
    const { result } = renderHook(() => useMutedDatasetDots(1))
    expect(result.current.mutedSet.size).toBe(0)
    expect(result.current.allMuted).toBe(false)
    expect(result.current.isMuted(10)).toBe(false)
  })

  it('toggleMuted toggles a dataset id in the set', () => {
    const { result } = renderHook(() => useMutedDatasetDots(1))
    act(() => result.current.toggleMuted(10))
    expect(result.current.isMuted(10)).toBe(true)
    expect(result.current.isMuted(20)).toBe(false)
    act(() => result.current.toggleMuted(10))
    expect(result.current.isMuted(10)).toBe(false)
  })

  it('persists per-dataset state to localStorage scoped to projectId', () => {
    const { result } = renderHook(() => useMutedDatasetDots(42))
    act(() => result.current.toggleMuted(10))
    act(() => result.current.toggleMuted(20))
    const raw = window.localStorage.getItem('mm-crosswalk-muted-dots-42')
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!)
    expect(new Set(parsed)).toEqual(new Set([10, 20]))
  })

  it('rehydrates state from localStorage on mount', () => {
    window.localStorage.setItem(
      'mm-crosswalk-muted-dots-7',
      JSON.stringify([100, 200]),
    )
    const { result } = renderHook(() => useMutedDatasetDots(7))
    expect(result.current.isMuted(100)).toBe(true)
    expect(result.current.isMuted(200)).toBe(true)
    expect(result.current.isMuted(300)).toBe(false)
  })

  it('toggleAllMuted flips the master switch and persists', () => {
    const { result } = renderHook(() => useMutedDatasetDots(7))
    act(() => result.current.toggleAllMuted())
    expect(result.current.allMuted).toBe(true)
    expect(window.localStorage.getItem('mm-crosswalk-all-dots-muted-7')).toBe('1')
    act(() => result.current.toggleAllMuted())
    expect(result.current.allMuted).toBe(false)
    expect(window.localStorage.getItem('mm-crosswalk-all-dots-muted-7')).toBe('0')
  })

  it('isMuted returns true for ALL datasets when allMuted is true', () => {
    const { result } = renderHook(() => useMutedDatasetDots(7))
    act(() => result.current.toggleAllMuted())
    expect(result.current.isMuted(10)).toBe(true)
    expect(result.current.isMuted(99999)).toBe(true)
    // And per-dataset state is preserved (toggling allMuted off restores)
    expect(result.current.mutedSet.size).toBe(0)
  })

  it('per-dataset state survives toggling allMuted on then off', () => {
    const { result } = renderHook(() => useMutedDatasetDots(7))
    act(() => result.current.toggleMuted(10))
    expect(result.current.isMuted(10)).toBe(true)
    act(() => result.current.toggleAllMuted()) // global on
    expect(result.current.isMuted(10)).toBe(true)
    expect(result.current.isMuted(20)).toBe(true) // global also hides 20
    act(() => result.current.toggleAllMuted()) // global off
    expect(result.current.isMuted(10)).toBe(true) // per-dataset state preserved
    expect(result.current.isMuted(20)).toBe(false) // 20 was never per-dataset muted
  })

  it('different project IDs maintain independent state', () => {
    const { result: r1 } = renderHook(() => useMutedDatasetDots(1))
    const { result: r2 } = renderHook(() => useMutedDatasetDots(2))
    act(() => r1.current.toggleMuted(10))
    expect(r1.current.isMuted(10)).toBe(true)
    expect(r2.current.isMuted(10)).toBe(false)
  })
})
