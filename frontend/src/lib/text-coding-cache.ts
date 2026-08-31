import type { QueryClient } from '@tanstack/react-query'

/**
 * #816 — single source for invalidating every reader of the project's
 * NON-RESPONSE VOCABULARY (`treat_as_empty`) after it changes.
 *
 * Sibling of `dataset-cache.ts::invalidateColumnDictionary` and
 * `coding-cache.ts::invalidateDerivedCounts`, for the same reason (#450/#608):
 * a hand-listed key set at the call site rots, and the rot is invisible because
 * a missing key looks like a screen that simply has not refreshed.
 *
 * ## Why the list is this wide
 *
 * `treat_as_empty` is the decision "which texts count", and #519 made it the
 * SINGLE denominator rule for the whole qualitative stack. So changing it moves:
 *
 *  - the focal-column picker's `N/M responded` (`text-columns` — also read by
 *    the codebook and the datasets list page)
 *  - which rows the coding view shows under `hide_empty` (`text-data`) and the
 *    coding gauge (`text-progress`)
 *  - every text-analysis denominator: code density, the cross-tab, response
 *    length, the filtered frequencies (`text-crosstab`, `text-density`,
 *    `text-length`, `text-filtered-freq`)
 *  - the read-only text panes in the qualitative analysis view
 *    (`text-column-readonly`)
 *  - the config itself (`text-config`)
 *
 * Keys are PREFIX-matched, so the bare `[key, projectId]` covers every param
 * variant. The analysis readers are INACTIVE while the coding view is open
 * (their screens are unmounted), so invalidating marks them stale at ZERO
 * network cost and they refetch on screen-open — the same argument
 * `invalidateColumnDictionary` records. Do not micro-optimize it per surface.
 *
 * ⚠️ **The picker's own counts are the point, not a side effect.** #519 left
 * open "if a researcher adds a string, the counts move, and nothing currently
 * says so". The editor lives in the popover that renders `N/M responded`, so
 * invalidating `text-columns` makes the disclosure the counts themselves —
 * which is why that key is load-bearing rather than tidy.
 */
export function invalidateTextEmptinessReaders(
  qc: QueryClient,
  projectId: number | string,
): void {
  const keys: (string | number)[][] = [
    ['text-config', projectId],
    ['text-columns', projectId],
    ['text-data', projectId],
    ['text-progress', projectId],
    ['text-crosstab', projectId],
    ['text-density', projectId],
    ['text-length', projectId],
    ['text-filtered-freq', projectId],
    ['text-column-readonly', projectId],
  ]
  for (const key of keys) {
    qc.invalidateQueries({ queryKey: key })
  }
}
