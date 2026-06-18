/**
 * Target-spec tests for useCodeChordShortcuts — #388 Phase 1.
 *
 * Unlike the full workbench integration (which only a human can verify — plan §6),
 * the hook's pure routing/state-machine logic IS exercisable in jsdom by dispatching
 * `window` keydown events against spy callbacks. These lock the Section-3 canon
 * (1500ms clear-on-timeout, layered Escape, cancel-on-non-digit, §3a category ordering,
 * F2 rename-at-0 fix) as the target behavior.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useCodeChordShortcuts, CHORD_TIMEOUT_MS, type UseCodeChordShortcutsOptions } from './useCodeChordShortcuts'
import type { ShortcutCodeInput } from '@/lib/codeShortcuts'

type Code = ShortcutCodeInput

// universal 0/1 ; category 100 (codes 11,12) ; category 200 (code 21)
const CODES: Code[] = [
  { id: 1, numeric_id: 0, is_universal: true },
  { id: 2, numeric_id: 1, is_universal: true },
  { id: 11, category_id: 100 },
  { id: 12, category_id: 100 },
  { id: 21, category_id: 200 },
]

function setup(overrides: Partial<UseCodeChordShortcutsOptions<Code>> = {}) {
  const spies = {
    onToggleCode: vi.fn(),
    onJumpUncoded: vi.fn(),
    onToggleQuote: vi.fn(),
    onCreateCode: vi.fn(),
    onCreateNote: vi.fn(),
    onEditOrRename: vi.fn(),
    onArrowNav: vi.fn(),
    onArrowHorizontal: vi.fn(() => true),
    clearSelection: vi.fn(),
    onEscapeFallback: vi.fn(),
    onUndo: vi.fn(),
    onRedo: vi.fn(),
  }
  const initialProps: UseCodeChordShortcutsOptions<Code> = {
    codes: CODES,
    selectionCount: 1,
    isEditing: false,
    arrowNavEnabled: true,
    ...spies,
    ...overrides,
  }
  const view = renderHook((props: UseCodeChordShortcutsOptions<Code>) => useCodeChordShortcuts(props), {
    initialProps,
  })
  return { view, ...spies }
}

function press(key: string, init: KeyboardEventInit = {}) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('useCodeChordShortcuts', () => {
  describe('numeric / universal', () => {
    it('applies the universal 0 and 1 codes directly', () => {
      const { onToggleCode } = setup()
      press('0')
      press('1')
      expect(onToggleCode.mock.calls.map(c => c[0].id)).toEqual([1, 2])
    })

    it('with no categories, applies any digit by numeric_id', () => {
      const { onToggleCode } = setup({ codes: [{ id: 5, numeric_id: 3 }, { id: 6, numeric_id: 4 }] })
      press('3')
      press('4')
      expect(onToggleCode.mock.calls.map(c => c[0].id)).toEqual([5, 6])
    })
  })

  describe('chord', () => {
    it('prefix digit arms the chord without applying a code, then the code digit resolves it', () => {
      const { view, onToggleCode } = setup()
      press('2')
      expect(onToggleCode).not.toHaveBeenCalled()
      expect(view.result.current.chordPrefix).toBe(2)
      expect(view.result.current.pendingCategoryId).toBe(100)
      press('1')
      expect(onToggleCode.mock.calls.map(c => c[0].id)).toEqual([11])
      expect(view.result.current.chordPrefix).toBeNull()
    })

    it('resolves second-category chords (3.1 → code 21)', () => {
      const { onToggleCode } = setup()
      press('3'); press('1')
      expect(onToggleCode.mock.calls[0][0].id).toBe(21)
    })

    it('§3a: maps prefix digits by category APPEARANCE order, not category_id or category_order', () => {
      // category 200 appears first → it is prefix digit 2; category 100 → digit 3.
      const reordered: Code[] = [
        { id: 21, category_id: 200 },
        { id: 11, category_id: 100 },
      ]
      const { onToggleCode } = setup({ codes: reordered })
      press('2'); press('1')
      expect(onToggleCode.mock.calls[0][0].id).toBe(21) // first-appearing category
    })

    it('clears on timeout WITHOUT applying a code (canon decision 1)', () => {
      vi.useFakeTimers()
      const { view, onToggleCode } = setup()
      press('2')
      expect(view.result.current.chordPrefix).toBe(2)
      act(() => { vi.advanceTimersByTime(CHORD_TIMEOUT_MS) })
      expect(view.result.current.chordPrefix).toBeNull()
      expect(onToggleCode).not.toHaveBeenCalled()
    })

    it('a non-digit key cancels a pending chord AND passes through to its action', () => {
      const { view, onToggleCode, onJumpUncoded } = setup()
      press('2')
      press('j')
      expect(view.result.current.chordPrefix).toBeNull()
      expect(onToggleCode).not.toHaveBeenCalled()
      expect(onJumpUncoded).toHaveBeenCalledOnce()
    })

    it('a modifier-only keydown does NOT cancel a pending chord', () => {
      const { view, onToggleCode } = setup()
      press('2')
      press('Shift', { shiftKey: true })
      expect(view.result.current.chordPrefix).toBe(2)
      press('1')
      expect(onToggleCode.mock.calls[0][0].id).toBe(11)
    })

    it('Ctrl+digit does not apply a code or arm a chord', () => {
      const { view, onToggleCode } = setup()
      press('2', { ctrlKey: true })
      expect(view.result.current.chordPrefix).toBeNull()
      expect(onToggleCode).not.toHaveBeenCalled()
    })
  })

  describe('layered Escape (focus-aware, one layer per press — H-D)', () => {
    it('layer 1: clears a pending chord and stops (no selection clear, no fallback)', () => {
      const { view, clearSelection, onEscapeFallback } = setup()
      press('2')
      press('Escape')
      expect(view.result.current.chordPrefix).toBeNull()
      expect(clearSelection).not.toHaveBeenCalled()
      expect(onEscapeFallback).not.toHaveBeenCalled()
    })

    it('list focused + selection, no chord: clears the selection (not fallback)', () => {
      const { clearSelection, onEscapeFallback } = setup({ selectionCount: 2, arrowNavEnabled: true })
      press('Escape')
      expect(clearSelection).toHaveBeenCalledOnce()
      expect(onEscapeFallback).not.toHaveBeenCalled()
    })

    it('side panel focused: dismisses the panel (fallback), never clears the selection', () => {
      const { clearSelection, onEscapeFallback } = setup({ selectionCount: 2, arrowNavEnabled: false })
      press('Escape')
      expect(onEscapeFallback).toHaveBeenCalledOnce()
      expect(clearSelection).not.toHaveBeenCalled()
    })

    it('list focused + no selection: does nothing', () => {
      const { clearSelection, onEscapeFallback } = setup({ selectionCount: 0, arrowNavEnabled: true })
      press('Escape')
      expect(clearSelection).not.toHaveBeenCalled()
      expect(onEscapeFallback).not.toHaveBeenCalled()
    })

    it('Escape while typing in a side-panel input still dismisses the panel (H-E carve-out)', () => {
      const { onEscapeFallback } = setup({ arrowNavEnabled: false })
      const input = document.createElement('input')
      document.body.appendChild(input)
      act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
      expect(onEscapeFallback).toHaveBeenCalledOnce()
      document.body.removeChild(input)
    })
  })

  describe('verbs and gating', () => {
    it('j and F2 work with NO selection (F2 rename-at-0 fix, G-H)', () => {
      const { onJumpUncoded, onEditOrRename } = setup({ selectionCount: 0 })
      press('j')
      press('F2')
      expect(onJumpUncoded).toHaveBeenCalledOnce()
      expect(onEditOrRename).toHaveBeenCalledOnce()
    })

    it('s/c/n and numeric apply require a selection', () => {
      const { onToggleQuote, onCreateCode, onCreateNote, onToggleCode } = setup({ selectionCount: 0 })
      press('s'); press('c'); press('n'); press('0')
      expect(onToggleQuote).not.toHaveBeenCalled()
      expect(onCreateCode).not.toHaveBeenCalled()
      expect(onCreateNote).not.toHaveBeenCalled()
      expect(onToggleCode).not.toHaveBeenCalled()
    })

    it('s/c/n fire when a selection exists', () => {
      const { onToggleQuote, onCreateCode, onCreateNote } = setup({ selectionCount: 1 })
      press('s'); press('c'); press('n')
      expect(onToggleQuote).toHaveBeenCalledOnce()
      expect(onCreateCode).toHaveBeenCalledOnce()
      expect(onCreateNote).toHaveBeenCalledOnce()
    })
  })

  describe('arrows', () => {
    it('Up/Down navigate when arrowNavEnabled; Shift = extend, Ctrl = jump', () => {
      const { onArrowNav } = setup({ arrowNavEnabled: true })
      press('ArrowDown')
      press('ArrowUp', { shiftKey: true })
      press('ArrowDown', { ctrlKey: true })
      press('ArrowUp', { ctrlKey: true, shiftKey: true })
      expect(onArrowNav.mock.calls).toEqual([
        [1, { extend: false, jump: false }],
        [-1, { extend: true, jump: false }],
        [1, { extend: false, jump: true }],
        [-1, { extend: true, jump: true }],
      ])
    })

    it('Up/Down are left alone when arrowNavEnabled is false (does not swallow, G-E)', () => {
      const { onArrowNav } = setup({ arrowNavEnabled: false })
      press('ArrowDown')
      expect(onArrowNav).not.toHaveBeenCalled()
    })

    it('Left/Right route to the horizontal handler', () => {
      const { onArrowHorizontal } = setup()
      press('ArrowLeft')
      press('ArrowRight')
      expect(onArrowHorizontal.mock.calls).toEqual([['left'], ['right']])
    })
  })

  describe('extraKeys (workbench-specific, ungated + boolean-return — H-B / P3.1)', () => {
    it('fires an extra key (handler self-gates), even with no selection or list focus', () => {
      const onBracket = vi.fn(() => true)
      setup({ arrowNavEnabled: false, selectionCount: 0, extraKeys: { '[': onBracket } })
      press('[')
      expect(onBracket).toHaveBeenCalledOnce()
    })

    it('a handler returning false does not stop the key (no preventDefault, falls through)', () => {
      const onSpace = vi.fn(() => false)
      const { onToggleCode } = setup({ selectionCount: 1, extraKeys: { ' ': onSpace } })
      press(' ')
      expect(onSpace).toHaveBeenCalledOnce()
      expect(onToggleCode).not.toHaveBeenCalled()
    })

    it('cancels a pending chord then fires the extra key (cancel + passthrough)', () => {
      const onG = vi.fn(() => true)
      const { view, onToggleCode } = setup({ arrowNavEnabled: true, extraKeys: { g: onG } })
      press('2')
      press('g')
      expect(view.result.current.chordPrefix).toBeNull()
      expect(onToggleCode).not.toHaveBeenCalled()
      expect(onG).toHaveBeenCalledOnce()
    })
  })

  describe('enabled flag (P3.1)', () => {
    it('bails entirely when enabled is false', () => {
      const { onToggleCode, onJumpUncoded } = setup({ enabled: false })
      press('0')
      press('j')
      expect(onToggleCode).not.toHaveBeenCalled()
      expect(onJumpUncoded).not.toHaveBeenCalled()
    })
  })

  describe('undo / redo', () => {
    it('Ctrl+Z undoes; Ctrl+Y and Ctrl+Shift+Z redo (incl. uppercase Z, G-I)', () => {
      const { onUndo, onRedo } = setup()
      press('z', { ctrlKey: true })
      press('y', { ctrlKey: true })
      press('Z', { ctrlKey: true, shiftKey: true })
      expect(onUndo).toHaveBeenCalledOnce()
      expect(onRedo).toHaveBeenCalledTimes(2)
    })
  })

  describe('guards', () => {
    it('ignores keystrokes originating in an INPUT', () => {
      const { onToggleCode } = setup()
      const input = document.createElement('input')
      document.body.appendChild(input)
      act(() => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true }))
      })
      expect(onToggleCode).not.toHaveBeenCalled()
      document.body.removeChild(input)
    })

    it('bails entirely while isEditing', () => {
      const { onToggleCode, onJumpUncoded } = setup({ isEditing: true })
      press('0')
      press('j')
      expect(onToggleCode).not.toHaveBeenCalled()
      expect(onJumpUncoded).not.toHaveBeenCalled()
    })
  })
})
