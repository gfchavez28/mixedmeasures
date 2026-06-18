/**
 * Characterization tests for useCodeShortcutLabels — #388 Phase 0.
 *
 * Locks the CURRENT code → chord-label mapping before the #388 consolidation.
 * The label scheme is the visible counterpart of the chord keystroke resolver,
 * so these tests double as documentation of the label space the future shared
 * chord hook must keep in sync (see gotcha in the internal design notes):
 *   - universal codes      → String(numeric_id)            (the 0 / 1 row)
 *   - categorized codes    → `${catIdx+2}.${codeIdx+1}`    (2.1 … 9.9)
 *   - uncategorized codes  → String(numeric_id)
 * Category index is by FIRST-APPEARANCE order in the input array, and the
 * scheme TRUNCATES at 8 categories / 9 codes-per-category — overflow falls back
 * to numeric_id. Those truncation/collision edges are characterized below and
 * flagged for the refactor; do not "fix" them here.
 */
import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useCodeShortcutLabels } from './useCodeShortcutLabels'

type Code = { id: number; numeric_id?: number | null; is_universal?: boolean; category_id?: number | null }
const labels = (codes: Code[]) => renderHook(() => useCodeShortcutLabels(codes)).result.current

describe('useCodeShortcutLabels', () => {
  it('returns an empty map for no codes', () => {
    expect(labels([]).size).toBe(0)
  })

  it('labels universal codes with their numeric_id', () => {
    const m = labels([
      { id: 1, numeric_id: 0, is_universal: true },
      { id: 2, numeric_id: 1, is_universal: true },
    ])
    expect(m.get(1)).toBe('0')
    expect(m.get(2)).toBe('1')
  })

  it("labels a universal code with no numeric_id as '?'", () => {
    expect(labels([{ id: 1, numeric_id: null, is_universal: true }]).get(1)).toBe('?')
  })

  it('labels a single category as 2.1, 2.2, 2.3 (category index +2, code position 1-indexed)', () => {
    const m = labels([
      { id: 11, category_id: 100 },
      { id: 12, category_id: 100 },
      { id: 13, category_id: 100 },
    ])
    expect(m.get(11)).toBe('2.1')
    expect(m.get(12)).toBe('2.2')
    expect(m.get(13)).toBe('2.3')
  })

  it('numbers categories by first-appearance order, not by category_id value', () => {
    // category 200 appears first in the array → it becomes "2.x"; 100 → "3.x".
    const m = labels([
      { id: 21, category_id: 200 },
      { id: 11, category_id: 100 },
      { id: 22, category_id: 200 },
    ])
    expect(m.get(21)).toBe('2.1')
    expect(m.get(22)).toBe('2.2')
    expect(m.get(11)).toBe('3.1')
  })

  it('labels uncategorized non-universal codes with their numeric_id', () => {
    expect(labels([{ id: 5, numeric_id: 7, category_id: null }]).get(5)).toBe('7')
  })

  it('reaches the 9.9 boundary (8th category, 9th code)', () => {
    const codes: Code[] = []
    for (let c = 0; c < 8; c++) for (let k = 0; k < 9; k++) codes.push({ id: c * 100 + k, category_id: 1000 + c })
    const m = labels(codes)
    expect(m.get(0)).toBe('2.1') // cat 0, code 0
    expect(m.get(7 * 100 + 8)).toBe('9.9') // cat 7 (→9), code 8 (→9)
  })

  describe('characterized quirks (revisit in #388 refactor)', () => {
    it('QUIRK: a 9th category falls outside the chord space → its codes get numeric_id labels', () => {
      const codes: Code[] = []
      for (let c = 0; c < 9; c++) codes.push({ id: c, numeric_id: 50 + c, category_id: 1000 + c })
      const m = labels(codes)
      expect(m.get(7)).toBe('9.1') // 8th category still chorded
      expect(m.get(8)).toBe('58') // 9th category → numeric_id fallback (50 + 8)
    })

    it('QUIRK: a 10th code in a category falls back to numeric_id', () => {
      const codes: Code[] = []
      for (let k = 0; k < 10; k++) codes.push({ id: k, numeric_id: 60 + k, category_id: 100 })
      const m = labels(codes)
      expect(m.get(8)).toBe('2.9') // 9th code chorded
      expect(m.get(9)).toBe('69') // 10th code → numeric_id fallback (60 + 9)
    })

    it('QUIRK: a universal code that also has a category_id is still labeled by numeric_id (not chorded)', () => {
      const m = labels([{ id: 1, numeric_id: 0, is_universal: true, category_id: 100 }])
      expect(m.get(1)).toBe('0')
    })
  })
})
