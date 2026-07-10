import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useCollapsibleColumn } from './useCollapsibleColumn'

// jsdom 29's Storage proxy has uneven function binding under this vitest
// config; install a clean in-memory shim per test (mirrors useBlindMode.test).
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
})

describe('useCollapsibleColumn (#39)', () => {
  it('starts expanded by default', () => {
    const { result } = renderHook(() => useCollapsibleColumn('conversation'))
    expect(result.current.collapsed).toBe(false)
  })

  it('persists collapse/expand per workbench key', () => {
    const { result } = renderHook(() => useCollapsibleColumn('conversation'))
    act(() => result.current.collapse())
    expect(result.current.collapsed).toBe(true)
    expect(localStorage.getItem('mm-right-column-collapsed-conversation')).toBe('1')

    act(() => result.current.expand())
    expect(result.current.collapsed).toBe(false)
    expect(localStorage.getItem('mm-right-column-collapsed-conversation')).toBe('0')
  })

  it('reads the persisted state on mount', () => {
    localStorage.setItem('mm-right-column-collapsed-conversation', '1')
    const { result } = renderHook(() => useCollapsibleColumn('conversation'))
    expect(result.current.collapsed).toBe(true)
  })

  it('keys are per-workbench (the doc/text ports get their own)', () => {
    const conv = renderHook(() => useCollapsibleColumn('conversation'))
    act(() => conv.result.current.collapse())
    const doc = renderHook(() => useCollapsibleColumn('document'))
    expect(doc.result.current.collapsed).toBe(false)
  })

  it('toggle flips and persists', () => {
    const { result } = renderHook(() => useCollapsibleColumn('conversation'))
    act(() => result.current.toggle())
    expect(result.current.collapsed).toBe(true)
    expect(localStorage.getItem('mm-right-column-collapsed-conversation')).toBe('1')
  })
})
