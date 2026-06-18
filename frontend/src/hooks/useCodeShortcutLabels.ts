import { useMemo } from 'react'
import { buildShortcutCategories, type ShortcutCodeInput } from '@/lib/codeShortcuts'

/**
 * Shared code shortcut label computation for coding workbenches.
 * Mirrors CodePanel's labeling logic:
 * - Universal codes: label = numeric_id
 * - Categorized codes: label = catIndex+2 . positionInCategory
 * - Uncategorized codes: label = numeric_id
 *
 * The categorized-code grouping/ordering/truncation is delegated to the shared
 * `buildShortcutCategories` helper so the visible labels and the chord keystroke
 * resolver (`useCodeChordShortcuts`) can never disagree (plan §3a / gotcha).
 */
export function useCodeShortcutLabels(codes: ShortcutCodeInput[]): Map<number, string> {
  return useMemo(() => {
    const map = new Map<number, string>()
    // Universal codes: label = numeric_id
    for (const code of codes) {
      if (code.is_universal) {
        map.set(code.id, String(code.numeric_id ?? '?'))
      }
    }
    // Categorized codes: label = catIndex+2 . positionInCategory (shared grouping)
    buildShortcutCategories(codes).forEach((cat, catIdx) => {
      cat.codes.forEach((code, codeIdx) => {
        map.set(code.id, `${catIdx + 2}.${codeIdx + 1}`)
      })
    })
    // Everything else (uncategorized non-universal + truncation overflow): label = numeric_id
    for (const code of codes) {
      if (!map.has(code.id)) {
        map.set(code.id, String(code.numeric_id ?? '?'))
      }
    }
    return map
  }, [codes])
}
