/**
 * Track J · J2-5 blind mode (DEC-G) — useBlindMode: default-on for multi-coder,
 * all-but-self hidden set, persisted reveal + log, recenter on coder switch.
 */
import { StrictMode } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'

vi.mock('@/lib/auth-context', () => ({ useAuth: vi.fn() }))
vi.mock('@/hooks/useCoders', () => ({ useCoders: vi.fn() }))
vi.mock('@/lib/api', () => ({
  codeAnalysisApi: { revealBlindMode: vi.fn().mockResolvedValue({ logged: true }) },
}))

import { useBlindMode, readRevealed } from './useBlindMode'
import { useAuth } from '@/lib/auth-context'
import { useCoders } from '@/hooks/useCoders'
import { codeAnalysisApi } from '@/lib/api'
import { isCoderVisible } from '@/lib/coder-color'

const setRoster = (multiCoder: boolean, selfId: number | null = 1) => {
  (useAuth as unknown as Mock).mockReturnValue({ user: selfId == null ? null : { id: selfId } })
  ;(useCoders as unknown as Mock).mockReturnValue({
    coders: [{ id: 1, username: 'Me' }, { id: 2, username: 'Alice' }, { id: 3, username: 'Bob' }],
    coderMap: new Map(),
    multiCoder,
  })
}

// jsdom 29's Storage proxy has uneven function binding under this vitest config;
// install a clean in-memory shim per test (mirrors useMutedDatasetDots.test).
let store: Record<string, string> = {}
beforeEach(() => {
  store = {}
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => { store[k] = String(v) },
      removeItem: (k: string) => { delete store[k] },
      clear: () => { store = {} },
    },
  })
  vi.clearAllMocks()
})
afterEach(() => { store = {}; cleanup() })

describe('useBlindMode', () => {
  it('defaults ON for a multi-coder project with no persisted reveal', () => {
    setRoster(true, 1)
    const { result } = renderHook(() => useBlindMode(99))
    expect(result.current.blind).toBe(true)
    expect([...result.current.blindHiddenSet].sort()).toEqual([2, 3]) // all-but-self
  })

  it('the all-but-self set hides colleagues but never self or unattributed (the no-leak lens)', () => {
    setRoster(true, 1)
    const { result } = renderHook(() => useBlindMode(99))
    const hidden = result.current.blindHiddenSet
    expect(isCoderVisible(2, hidden)).toBe(false) // Alice hidden
    expect(isCoderVisible(3, hidden)).toBe(false) // Bob hidden
    expect(isCoderVisible(1, hidden)).toBe(true)  // self always shown
    expect(isCoderVisible(null, hidden)).toBe(true) // unattributed always shown
  })

  it('is never blind for a single-coder project', () => {
    setRoster(false, 1)
    const { result } = renderHook(() => useBlindMode(99))
    expect(result.current.blind).toBe(false)
    expect(result.current.blindHiddenSet.size).toBe(0)
  })

  it('toggleReveal un-blinds, persists the override, and logs the reveal', () => {
    setRoster(true, 1)
    const { result } = renderHook(() => useBlindMode(99))
    act(() => result.current.toggleReveal('workbench'))
    expect(result.current.blind).toBe(false)
    expect(localStorage.getItem('mm-blind-revealed-99-1')).toBe('1')
    expect(codeAnalysisApi.revealBlindMode).toHaveBeenCalledWith(99, { surface: 'workbench' })
  })

  it('re-hiding clears the override and does NOT log again', () => {
    setRoster(true, 1)
    const { result } = renderHook(() => useBlindMode(99))
    act(() => result.current.toggleReveal('workbench')) // reveal (1 log)
    act(() => result.current.toggleReveal())             // re-hide (no log)
    expect(result.current.blind).toBe(true)
    expect(localStorage.getItem('mm-blind-revealed-99-1')).toBeNull()
    expect(codeAnalysisApi.revealBlindMode).toHaveBeenCalledTimes(1)
  })

  it('starts revealed when the persisted flag is set for this (project, coder)', () => {
    localStorage.setItem('mm-blind-revealed-99-1', '1')
    setRoster(true, 1)
    const { result } = renderHook(() => useBlindMode(99))
    expect(result.current.blind).toBe(false)
  })

  it('recenters the hidden set + re-blinds when the active coder switches', () => {
    setRoster(true, 1)
    const { result, rerender } = renderHook(() => useBlindMode(99))
    expect([...result.current.blindHiddenSet].sort()).toEqual([2, 3])
    setRoster(true, 2) // coder switched to id 2 (no reveal flag for coder 2)
    rerender()
    expect(result.current.blind).toBe(true)
    expect([...result.current.blindHiddenSet].sort()).toEqual([1, 3]) // all-but-self=2
  })

  it('logs the reveal exactly ONCE under StrictMode (side effects are outside the setState updater)', () => {
    // Regression: a reveal-log fired from inside the setRevealed updater double-fires
    // under StrictMode's updater double-invoke → two audit rows per reveal. Caught live.
    setRoster(true, 1)
    const { result } = renderHook(() => useBlindMode(99), {
      wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
    })
    act(() => result.current.toggleReveal('workbench'))
    expect(codeAnalysisApi.revealBlindMode).toHaveBeenCalledTimes(1)
  })
})

describe('readRevealed (fresh-read primitive for the TopRail switcher, #3)', () => {
  // Regression: the Switch-Coder menu's coverage gate first used a second
  // useBlindMode INSTANCE, whose local state went stale — coverage stayed visible
  // (colleague-presence leak) after the workbench toggled blind. The fix reads the
  // flag fresh each render via this exported helper. These lock its contract.
  it('reflects the CURRENT flag value, not a cached one', () => {
    expect(readRevealed(1, 1)).toBe(false)        // unset
    localStorage.setItem('mm-blind-revealed-1-1', '1')
    expect(readRevealed(1, 1)).toBe(true)         // a cached instance would still read false here
    localStorage.removeItem('mm-blind-revealed-1-1')
    expect(readRevealed(1, 1)).toBe(false)        // and back, on the next read
  })

  it('is keyed per (project, coder) — one reveal does not leak to another', () => {
    localStorage.setItem('mm-blind-revealed-99-1', '1')
    expect(readRevealed(99, 1)).toBe(true)
    expect(readRevealed(99, 2)).toBe(false)       // different coder
    expect(readRevealed(100, 1)).toBe(false)      // different project
  })

  it('uses an "anon" key when there is no active coder', () => {
    localStorage.setItem('mm-blind-revealed-99-anon', '1')
    expect(readRevealed(99, null)).toBe(true)
  })
})
