/**
 * Shared category-grouping for code keyboard shortcuts (#388).
 *
 * SINGLE SOURCE consumed by both the visible label map (`useCodeShortcutLabels`)
 * and the chord keystroke resolver (`useCodeChordShortcuts`). Keeping one ordering
 * + truncation here is what prevents the label/keystroke desync documented as
 * plan §3a / gotcha: categories are ordered by FIRST-APPEARANCE in the input
 * array — which equals the backend's `category.display_order` sort
 * (`routers/codes.py:94`) — and explicitly NOT by the per-code `category_order`
 * field (the old `chordMap` build sorted by `category_order`, which silently
 * diverged from the labels whenever a category's codes didn't start at 0).
 *
 * Chord space: prefix digits 2-9 select a category (max 8); code digits 1-9
 * select a code within it (max 9). Universal codes (the 0/1 row) and uncategorized
 * codes are resolved by `numeric_id` elsewhere and are intentionally excluded here.
 */

export interface ShortcutCodeInput {
  id: number
  numeric_id?: number | null
  is_universal?: boolean
  category_id?: number | null
}

export interface ShortcutCategory<T> {
  categoryId: number
  /** ≤ MAX_CODES_PER_CATEGORY codes, in input order; index j → chord code digit j+1 */
  codes: T[]
}

/** Chord prefix digits 2-9 → at most 8 categories are reachable. */
export const MAX_SHORTCUT_CATEGORIES = 8
/** Chord code digits 1-9 → at most 9 codes per category are reachable. */
export const MAX_CODES_PER_CATEGORY = 9

/**
 * Group categorized, non-universal codes into the chord category space.
 *
 * Categories are returned in first-appearance order (== backend `display_order`),
 * truncated to {@link MAX_SHORTCUT_CATEGORIES}; each category's codes are truncated
 * to {@link MAX_CODES_PER_CATEGORY}. The returned index `i` maps to chord prefix
 * digit `i + 2` (and label prefix `i + 2`); the code index `j` maps to code digit
 * `j + 1`. Codes beyond the truncation limits are simply absent — callers fall back
 * to `numeric_id` for them, matching the prior behaviour exactly.
 */
export function buildShortcutCategories<T extends ShortcutCodeInput>(codes: T[]): ShortcutCategory<T>[] {
  const order: number[] = []
  const groups = new Map<number, T[]>()
  for (const code of codes) {
    if (code.is_universal) continue
    if (code.category_id == null) continue
    if (!groups.has(code.category_id)) {
      groups.set(code.category_id, [])
      order.push(code.category_id)
    }
    groups.get(code.category_id)!.push(code)
  }
  return order.slice(0, MAX_SHORTCUT_CATEGORIES).map(categoryId => ({
    categoryId,
    codes: groups.get(categoryId)!.slice(0, MAX_CODES_PER_CATEGORY),
  }))
}
