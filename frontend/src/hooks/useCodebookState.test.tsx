import { describe, it, expect, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { useCodebookState } from './useCodebookState'

/**
 * #1147 — the Codebook's URL state is composable (`url-state.md`).
 *
 * The hide toast's *Undo* is a setter captured by the render that made the toast
 * (`CodebookView`'s hide handler hands that render's `cb.removeHiddenCodeIds` to it).
 * With React Router's own setter it started from THAT render's URL, so it undid
 * everything since — a search typed after the hide, and a second hide. Both cases
 * failed on the shipped hook (the 2026-10-08 audit's probe, re-run by the auditor).
 */

afterEach(cleanup)

const wrapper = (initial: string) => ({ children }: { children: ReactNode }) => (
  <MemoryRouter initialEntries={[initial]}>{children}</MemoryRouter>
)

describe('useCodebookState — a hide toast’s Undo undoes only its own hide', () => {
  it('keeps a search typed after the hide', () => {
    const { result } = renderHook(() => useCodebookState(), { wrapper: wrapper('/?mode=tree') })
    let undo: ((ids: number[]) => void) | null = null
    act(() => {
      const cb = result.current
      cb.setHiddenCodeIds(new Set([5]))
      undo = cb.removeHiddenCodeIds
    })
    expect([...result.current.hiddenCodeIds]).toEqual([5])

    act(() => result.current.setSearch('pacing'))
    expect(result.current.search).toBe('pacing')

    act(() => undo!([5]))
    expect([...result.current.hiddenCodeIds]).toEqual([])
    expect(result.current.search).toBe('pacing')
  })

  it('keeps a SECOND hide when the first is undone', () => {
    const { result } = renderHook(() => useCodebookState(), { wrapper: wrapper('/') })
    let undoFirst: ((ids: number[]) => void) | null = null
    act(() => {
      const cb = result.current
      cb.setHiddenCodeIds(new Set([5]))
      undoFirst = cb.removeHiddenCodeIds
    })
    act(() => {
      const cb = result.current
      cb.setHiddenCodeIds(new Set([...cb.hiddenCodeIds, 6]))
    })
    expect([...result.current.hiddenCodeIds].sort()).toEqual([5, 6])

    act(() => undoFirst!([5]))
    expect([...result.current.hiddenCodeIds]).toEqual([6])
  })

  it('two setters called in one tick both land', () => {
    // The mechanism under *Reset filter* (`CodebookToolbar.reset.test.tsx` drives
    // the real button).
    const { result } = renderHook(() => useCodebookState(), { wrapper: wrapper('/?minSeg=3&maxSeg=8') })
    act(() => {
      result.current.setMinSeg(0)
      result.current.setMaxSeg(null)
    })
    expect(result.current.minSeg).toBe(0)
    expect(result.current.maxSeg).toBeNull()
  })
})
