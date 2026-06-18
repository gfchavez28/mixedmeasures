/**
 * Tests for the shared chord category-grouping helper (#388 Phase 1).
 *
 * This is the single source of truth both the label map and the chord keystroke
 * resolver consume. The headline case (`orders categories by first-appearance,
 * NOT category_order`) is the regression net for plan §3a: the old DocumentCoding-
 * Workbench `chordMap` sorted categories by the per-code `category_order` field,
 * which silently diverged from the labels (which order by appearance / backend
 * display_order). This helper locks the correct, shared ordering.
 */
import { describe, it, expect } from 'vitest'
import {
  buildShortcutCategories,
  MAX_SHORTCUT_CATEGORIES,
  MAX_CODES_PER_CATEGORY,
  type ShortcutCodeInput,
} from './codeShortcuts'

type Code = ShortcutCodeInput & { category_order?: number | null }

describe('buildShortcutCategories', () => {
  it('returns [] for no codes', () => {
    expect(buildShortcutCategories([])).toEqual([])
  })

  it('groups a single category, preserving input order of its codes', () => {
    const cats = buildShortcutCategories([
      { id: 11, category_id: 100 },
      { id: 12, category_id: 100 },
      { id: 13, category_id: 100 },
    ])
    expect(cats).toHaveLength(1)
    expect(cats[0].categoryId).toBe(100)
    expect(cats[0].codes.map(c => c.id)).toEqual([11, 12, 13])
  })

  it('orders categories by FIRST-APPEARANCE, not by category_id value', () => {
    const cats = buildShortcutCategories([
      { id: 21, category_id: 200 },
      { id: 11, category_id: 100 },
      { id: 22, category_id: 200 },
    ])
    expect(cats.map(c => c.categoryId)).toEqual([200, 100]) // 200 appeared first
  })

  // ── §3a regression: ordering must NOT follow the per-code category_order field ──
  it('§3a: ignores category_order — appearance order wins even when category_order would reorder', () => {
    // Category A (appears first) has codes whose category_order (3,4) is HIGHER than
    // category B's (0,1). The buggy chordMap sorted by category_order → B before A,
    // desyncing from the labels. The helper must keep appearance order: A, then B.
    const cats = buildShortcutCategories<Code>([
      { id: 1, category_id: 100, category_order: 3 },
      { id: 2, category_id: 100, category_order: 4 },
      { id: 3, category_id: 200, category_order: 0 },
      { id: 4, category_id: 200, category_order: 1 },
    ])
    expect(cats.map(c => c.categoryId)).toEqual([100, 200])
    // → category 100 is chord prefix digit 2 (index 0), matching its "2.x" label.
  })

  it('excludes universal codes (resolved by numeric_id elsewhere)', () => {
    const cats = buildShortcutCategories([
      { id: 1, is_universal: true, category_id: 100 }, // universal-with-category: excluded
      { id: 2, category_id: 100 },
    ])
    expect(cats).toHaveLength(1)
    expect(cats[0].codes.map(c => c.id)).toEqual([2])
  })

  it('excludes uncategorized codes', () => {
    const cats = buildShortcutCategories([
      { id: 1, category_id: null },
      { id: 2, category_id: 100 },
    ])
    expect(cats).toHaveLength(1)
    expect(cats[0].codes.map(c => c.id)).toEqual([2])
  })

  it(`truncates to ${MAX_SHORTCUT_CATEGORIES} categories (chord prefix digits 2-9)`, () => {
    const codes: Code[] = []
    for (let c = 0; c < 10; c++) codes.push({ id: c, category_id: 1000 + c })
    const cats = buildShortcutCategories(codes)
    expect(cats).toHaveLength(MAX_SHORTCUT_CATEGORIES)
    expect(cats.map(c => c.categoryId)).toEqual([1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007])
  })

  it(`truncates each category to ${MAX_CODES_PER_CATEGORY} codes (chord code digits 1-9)`, () => {
    const codes: Code[] = []
    for (let k = 0; k < 12; k++) codes.push({ id: k, category_id: 100 })
    const cats = buildShortcutCategories(codes)
    expect(cats[0].codes).toHaveLength(MAX_CODES_PER_CATEGORY)
    expect(cats[0].codes.map(c => c.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
  })
})
