import { useMemo } from 'react'
import { buildShortcutCategories, type ShortcutCodeInput } from '@/lib/codeShortcuts'

/**
 * Shared code shortcut label computation for coding workbenches.
 * - Categorized codes (within the chord caps): `catIndex+2 . positionInCategory`
 * - Everything else (universal, uncategorized, truncation overflow): the bare
 *   `numeric_id` — but ONLY when that digit actually reaches the code.
 *
 * The categorized-code grouping/ordering/truncation is delegated to the shared
 * `buildShortcutCategories` helper so the visible labels and the chord keystroke
 * resolver (`useCodeChordShortcuts`) can never disagree (plan §3a / gotcha).
 *
 * ⚠️ **A code with no label has no key — do not fall back to printing one
 * (#664).** This map used to hand back `String(numeric_id)` for every leftover
 * code, which reads as a promise the resolver does not keep. Its bare-digit arm
 * is `byNumericId.get(digit)` over a SINGLE keypress, and it is consulted for
 * every digit only while the project has NO categories; once any category
 * exists, digits 2–9 are the chord prefix space and reach category codes
 * instead. So a leftover code is reachable only when:
 *   - its `numeric_id` is a single digit (10+ can never be typed — the chord
 *     machine accumulates digits only behind a category prefix), AND
 *   - either the project has no categories, or the id is 0/1 (the universal row,
 *     which the resolver special-cases ahead of the chord space).
 * Anything else silently did nothing while four surfaces advertised a key for
 * it: the conversation row menu, the document workbench, both text-coding
 * panels — and, since #654, the observation clip menu.
 */
export function useCodeShortcutLabels(codes: ShortcutCodeInput[]): Map<number, string> {
  return useMemo(() => {
    const map = new Map<number, string>()
    const categories = buildShortcutCategories(codes)
    const hasCategories = categories.length > 0
    // Mirrors the resolver's bare-digit arm exactly — see the warning above.
    const digitReaches = (n: number | null | undefined): n is number =>
      n != null && Number.isInteger(n) && n >= 0 && n <= 9 && (!hasCategories || n <= 1)

    // Categorized codes: label = catIndex+2 . positionInCategory (shared grouping).
    // Always reachable — the caps keep the prefix ≤ 9 and the code digit ≤ 9.
    categories.forEach((cat, catIdx) => {
      cat.codes.forEach((code, codeIdx) => {
        map.set(code.id, `${catIdx + 2}.${codeIdx + 1}`)
      })
    })
    // Universal, uncategorized, and truncation overflow: the bare digit, when
    // it lands. No entry = no key, which is the honest answer.
    for (const code of codes) {
      if (!map.has(code.id) && digitReaches(code.numeric_id)) {
        map.set(code.id, String(code.numeric_id))
      }
    }
    return map
  }, [codes])
}
