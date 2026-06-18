/**
 * Characterization + regression tests for useSegmentSelection — #388 Phase 0.
 *
 * Locks the behavior of the shared click/arrow/shift-range selection hook
 * before the #388 workbench consolidation migrates CodingWorkbench +
 * TextCodingView onto it (and extends it with Ctrl+Arrow variants).
 *
 * Includes the Q1 fix (2026-05-25): the shift-range anchor is now validated
 * against the CURRENT selection and re-derived when stale, so an external
 * selection change (Escape-clear, a programmatic "jump" select, a click handled
 * elsewhere) no longer makes the next shift-gesture range from a stale index.
 * The remaining `QUIRK:` cases document current behavior the future refactor
 * may still revisit — change those tests deliberately when the refactor changes
 * the behavior. See the internal design notes.
 *
 * `setupControlled` echoes the emitted selection back into the prop, mirroring
 * a controlled parent — required for multi-step shift sequences, because the
 * anchor validity check reads the live `selectedIds`.
 */
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { useSegmentSelection } from './useSegmentSelection'

interface Item { id: number }
const ITEMS: Item[] = [{ id: 10 }, { id: 20 }, { id: 30 }, { id: 40 }, { id: 50 }]
const getId = (i: Item) => i.id

// Single-shot harness: selectedIds is fixed; assert what a handler emits.
function setup(selectedIds: number[] = [], opts: { enabled?: boolean; scrollToIndex?: (i: number) => void } = {}) {
  const onSelectionChange = vi.fn<(ids: number[]) => void>()
  const props = { items: ITEMS, getId, selectedIds, onSelectionChange, ...opts }
  const view = renderHook((p: typeof props) => useSegmentSelection(p), { initialProps: props })
  return { onSelectionChange, ...view }
}

// Controlled harness: emitted selection is echoed back into the prop (like a
// real parent). `rerender({ sel })` simulates an EXTERNAL selection change.
function setupControlled(initial: number[] = []) {
  const onSelectionChange = vi.fn<(ids: number[]) => void>()
  const { result, rerender } = renderHook(
    ({ sel }: { sel: number[] }) => useSegmentSelection({ items: ITEMS, getId, selectedIds: sel, onSelectionChange }),
    { initialProps: { sel: initial } },
  )
  onSelectionChange.mockImplementation((ids) => rerender({ sel: ids }))
  const external = (sel: number[]) => act(() => rerender({ sel }))
  return { onSelectionChange, result, external }
}

const plain = {} as ReactMouseEvent
const shift = { shiftKey: true } as ReactMouseEvent
const ctrl = { ctrlKey: true } as ReactMouseEvent
const meta = { metaKey: true } as ReactMouseEvent

describe('useSegmentSelection — handleItemClick', () => {
  it('plain click single-selects the clicked id', () => {
    const { result, onSelectionChange } = setup([])
    act(() => result.current.handleItemClick(30, plain))
    expect(onSelectionChange).toHaveBeenCalledWith([30])
  })

  it('shift click after a plain click selects the inclusive range from the anchor', () => {
    const { result, onSelectionChange } = setupControlled([])
    act(() => result.current.handleItemClick(20, plain)) // anchor = idx 1, echoes sel=[20]
    act(() => result.current.handleItemClick(40, shift)) // → idx 3
    expect(onSelectionChange).toHaveBeenLastCalledWith([20, 30, 40])
  })

  it('shift click range works regardless of direction (clicked before anchor)', () => {
    const { result, onSelectionChange } = setupControlled([])
    act(() => result.current.handleItemClick(40, plain)) // anchor = idx 3
    act(() => result.current.handleItemClick(20, shift)) // → idx 1
    expect(onSelectionChange).toHaveBeenLastCalledWith([20, 30, 40])
  })

  it('ctrl/cmd click toggles the id into an empty selection', () => {
    const { result, onSelectionChange } = setup([])
    act(() => result.current.handleItemClick(30, ctrl))
    expect(onSelectionChange).toHaveBeenCalledWith([30])
  })

  it('ctrl/cmd click adds then removes an id (filter preserves order)', () => {
    const { result, onSelectionChange } = setupControlled([10, 30])
    act(() => result.current.handleItemClick(50, meta)) // add → [10,30,50]
    expect(onSelectionChange).toHaveBeenLastCalledWith([10, 30, 50])
    act(() => result.current.handleItemClick(10, ctrl)) // remove → [30,50]
    expect(onSelectionChange).toHaveBeenLastCalledWith([30, 50])
  })

  it('ignores clicks on ids not present in items', () => {
    const { result, onSelectionChange } = setup([])
    act(() => result.current.handleItemClick(999, plain))
    expect(onSelectionChange).not.toHaveBeenCalled()
  })

  it('calls scrollToIndex with the clicked index when provided', () => {
    const scrollToIndex = vi.fn()
    const { result } = setup([], { scrollToIndex })
    act(() => result.current.handleItemClick(30, plain))
    expect(scrollToIndex).toHaveBeenCalledWith(2)
  })
})

describe('useSegmentSelection — handleArrowNav (plain)', () => {
  it('arrow down moves to the next item after the last selected', () => {
    const { result, onSelectionChange } = setup([20])
    act(() => result.current.handleArrowNav(1))
    expect(onSelectionChange).toHaveBeenCalledWith([30])
  })

  it('arrow up moves to the previous item before the last selected', () => {
    const { result, onSelectionChange } = setup([30])
    act(() => result.current.handleArrowNav(-1))
    expect(onSelectionChange).toHaveBeenCalledWith([20])
  })

  it('arrow uses the LAST selected id as the cursor when several are selected', () => {
    const { result, onSelectionChange } = setup([10, 40])
    act(() => result.current.handleArrowNav(1))
    expect(onSelectionChange).toHaveBeenCalledWith([50]) // from idx 3 → 4
  })

  it('arrow down clamps at the last item', () => {
    const { result, onSelectionChange } = setup([50])
    act(() => result.current.handleArrowNav(1))
    expect(onSelectionChange).toHaveBeenCalledWith([50])
  })

  it('arrow up clamps at the first item', () => {
    const { result, onSelectionChange } = setup([10])
    act(() => result.current.handleArrowNav(-1))
    expect(onSelectionChange).toHaveBeenCalledWith([10])
  })

  it('no-ops when items is empty', () => {
    const onSelectionChange = vi.fn()
    const { result } = renderHook(() =>
      useSegmentSelection({ items: [] as Item[], getId, selectedIds: [], onSelectionChange }),
    )
    act(() => result.current.handleArrowNav(1))
    expect(onSelectionChange).not.toHaveBeenCalled()
  })
})

describe('useSegmentSelection — handleArrowNav (shift extend)', () => {
  it('shift+arrow extends a range from the existing selection', () => {
    const { result, onSelectionChange } = setupControlled([20])
    act(() => result.current.handleArrowNav(1, { extend: true }))
    expect(onSelectionChange).toHaveBeenLastCalledWith([20, 30])
  })

  it('shift+arrow then shift+arrow keeps extending from the same anchor', () => {
    const { result, onSelectionChange } = setupControlled([20])
    act(() => result.current.handleArrowNav(1, { extend: true }))
    act(() => result.current.handleArrowNav(1, { extend: true }))
    expect(onSelectionChange).toHaveBeenLastCalledWith([20, 30, 40])
  })

  it('shift+arrow can shrink back toward the anchor', () => {
    const { result, onSelectionChange } = setupControlled([20])
    act(() => result.current.handleArrowNav(1, { extend: true })) // [20,30]
    act(() => result.current.handleArrowNav(1, { extend: true })) // [20,30,40]
    act(() => result.current.handleArrowNav(-1, { extend: true })) // back toward anchor
    expect(onSelectionChange).toHaveBeenLastCalledWith([20, 30])
  })

  it('enabled:false makes both handlers no-op', () => {
    const { result, onSelectionChange } = setup([20], { enabled: false })
    act(() => result.current.handleItemClick(30, plain))
    act(() => result.current.handleArrowNav(1))
    expect(onSelectionChange).not.toHaveBeenCalled()
  })
})

describe('useSegmentSelection — handleArrowNav (Ctrl jump + Ctrl+Shift range-to-end, #388 P2.1)', () => {
  // items fixture = [10,20,30,40,50] (indices 0-4)
  it('Ctrl+Down jumps to the last item (single select)', () => {
    const { result, onSelectionChange } = setup([20])
    act(() => result.current.handleArrowNav(1, { jump: true }))
    expect(onSelectionChange).toHaveBeenCalledWith([50])
  })

  it('Ctrl+Up jumps to the first item (single select)', () => {
    const { result, onSelectionChange } = setup([40])
    act(() => result.current.handleArrowNav(-1, { jump: true }))
    expect(onSelectionChange).toHaveBeenCalledWith([10])
  })

  it('Ctrl+Shift+Down selects from the anchor to the last item', () => {
    const { result, onSelectionChange } = setup([20]) // anchor derives to idx 1
    act(() => result.current.handleArrowNav(1, { jump: true, extend: true }))
    expect(onSelectionChange).toHaveBeenCalledWith([20, 30, 40, 50])
  })

  it('Ctrl+Shift+Up selects from the first item to the anchor', () => {
    const { result, onSelectionChange } = setup([40]) // anchor derives to idx 3
    act(() => result.current.handleArrowNav(-1, { jump: true, extend: true }))
    expect(onSelectionChange).toHaveBeenCalledWith([10, 20, 30, 40])
  })

  it('jump is a no-op when disabled', () => {
    const { result, onSelectionChange } = setup([20], { enabled: false })
    act(() => result.current.handleArrowNav(1, { jump: true }))
    expect(onSelectionChange).not.toHaveBeenCalled()
  })
})

describe('useSegmentSelection — Q1 fix: anchor resyncs on external selection change', () => {
  it('after an external clear (e.g. Escape), shift-click starts clean instead of ranging from a stale anchor', () => {
    const { result, onSelectionChange, external } = setupControlled([])
    act(() => result.current.handleItemClick(10, plain)) // anchor = idx 0
    external([]) // parent clears the selection (Escape) — anchorRef is now stale
    act(() => result.current.handleItemClick(30, shift))
    // No live selection to anchor to → plain single-select, NOT [10,20,30].
    expect(onSelectionChange).toHaveBeenLastCalledWith([30])
  })

  it('after an external select of a different item (e.g. jump-to-uncoded), shift-click ranges from the NEW selection', () => {
    const { result, onSelectionChange, external } = setupControlled([])
    act(() => result.current.handleItemClick(10, plain)) // anchor = idx 0 (id 10)
    external([50]) // parent moves selection to id 50 by other means
    act(() => result.current.handleItemClick(30, shift))
    // Ranges from the live selection (id 50), not the stale anchor (id 10).
    expect(onSelectionChange).toHaveBeenLastCalledWith([30, 40, 50])
  })

  it('shift+click with a live selection but no prior in-hook anchor extends from the current selection', () => {
    // Pre-#388 this fell through to a plain single-select; the Q1 fix derives the
    // anchor from the live selection so shift-click extends it (file-explorer-style).
    const { result, onSelectionChange } = setup([10, 20, 30])
    act(() => result.current.handleItemClick(50, shift))
    expect(onSelectionChange).toHaveBeenCalledWith([30, 40, 50])
  })
})

describe('useSegmentSelection — characterized quirks (revisit in #388 refactor)', () => {
  it('QUIRK: plain arrow from an EMPTY selection selects the first item — for BOTH directions', () => {
    // currentId is null → curIdx = -1 → down: min(len-1, 0)=0; up: max(0, -1)=0.
    const down = setup([])
    act(() => down.result.current.handleArrowNav(1))
    expect(down.onSelectionChange).toHaveBeenCalledWith([10])

    const up = setup([])
    act(() => up.result.current.handleArrowNav(-1))
    expect(up.onSelectionChange).toHaveBeenCalledWith([10]) // up from empty also lands on index 0
  })
})
