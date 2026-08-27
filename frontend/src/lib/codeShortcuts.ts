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

/**
 * `categoryId → chord PREFIX digit`, for the `[2]` markers a code panel prints
 * beside a category header (#824).
 *
 * The panels used to derive this themselves, and BOTH derivations were a
 * different question from the one the resolver answers. `TextCodingView` sorted
 * **every** category by `display_order` and took index+2 — so an EMPTY category
 * sorted first shifted every populated category's advertised digit by one, and
 * the panel printed `6.1` for a chord that fires `3.1`. (Measured on real data:
 * one of five prefixes agreed, by coincidence.) `CodePanel` re-derived it from
 * its own category list, which happens to agree today. Both now read this.
 *
 * Only categories that HAVE codes occupy the chord space, in first-appearance
 * order — because that is what `buildShortcutCategories` hands the resolver.
 */
export function categoryShortcutPrefixes<T extends ShortcutCodeInput>(
  codes: T[],
): Map<number, number> {
  const prefixes = new Map<number, number>()
  buildShortcutCategories(codes).forEach((cat, i) => {
    prefixes.set(cat.categoryId, i + 2)
  })
  return prefixes
}

/**
 * The status-bar hint naming the keys that apply a code (#830c).
 *
 * ⚠️ **It is STATE-DEPENDENT, and the filed remedy was wrong about that.** All
 * three workbenches printed a flat `0-9: code`, which misdescribes a project
 * WITH categories — there, `2`–`9` arm a two-key chord and a single digit does
 * nothing. But the flat form is exactly right for a project with NO categories,
 * where `useCodeChordShortcuts` resolves every digit by `numeric_id` in one
 * press. A fixed replacement string would have traded one wrong hint for
 * another, so the hint is derived from the same helper the resolver uses.
 *
 * The universal half is named only when a code can actually answer it — the
 * #664 rule ("a code with no key has no label") applied to copy.
 */
export function codeKeyHint(codes: ShortcutCodeInput[]): string {
  if (buildShortcutCategories(codes).length === 0) return '0-9: code'
  const hasUniversal = codes.some(
    c => c.numeric_id != null && c.numeric_id >= 0 && c.numeric_id <= 1,
  )
  return hasUniversal
    ? '0-1: universal · 2-9 then 1-9: code'
    : '2-9 then 1-9: code'
}
