import type { QueryClient } from '@tanstack/react-query'

/**
 * #450 — single source for invalidating the cross-surface DERIVED counts/aggregates that go
 * stale after a code application, a code edit/merge, or a coverage-changing segment op.
 *
 * Each surface's own queries (segment lists, `['codes']`, `text-data`, the codebook tree
 * while you're ON the codebook screen, …) are invalidated locally at the mutation site. THIS
 * helper covers the counts shown on OTHER screens that no single mutation owned — so a number
 * edited on screen A stops lagging on screen B (the bug). Keys are PREFIX-matched (TanStack
 * partial match), so every param variant of a key is covered by the bare `[key, projectId]`.
 *
 * Cost: these readers are INACTIVE while you code (their screens are unmounted) → invalidate
 * just marks them stale at zero network cost; they refetch when you next open the screen. The
 * one always-mounted reader (`['project-summary']` via TopRail) is lightweight, and
 * document-coding already invalidates it on every change. Deliberately does NOT touch any
 * `staleTime` — that would trade a cosmetic lag for a real perf regression (#450 fix note).
 *
 * `opts.metrics`: also invalidate the dataset analysis aggregates that TEXT-coding-domain
 * code changes feed (`['metrics']` scale scores, `['canvas-chart']` inline charts). Pass true
 * only from text-coding / qualitative-analysis / codebook-CRUD sites — conversation/document
 * coding does not feed dataset metrics, so it leaves these alone.
 *
 * New code-application / code-edit mutation sites MUST route through this helper rather than
 * re-listing the cross-surface keys (the convention-only drift was the #450 root cause).
 */
export function invalidateDerivedCounts(
  qc: QueryClient,
  projectId: number | string,
  opts?: { metrics?: boolean },
): void {
  const keys: (string | number)[][] = [
    ['search', projectId],
    ['project-summary', projectId],
    ['codebook-tree', projectId],
    ['consensus-status', projectId],
    ['code-sample-segments', projectId],
    ['irr', projectId],
    ['reconciliation', projectId],
    // Group A (#1/#3/#13): per-source / per-project coder coverage — a coder's
    // first (or last) code on a source changes who's "active here".
    ['coder-coverage', projectId],
  ]
  if (opts?.metrics) {
    keys.push(['metrics', projectId], ['canvas-chart', projectId])
  }
  for (const key of keys) {
    qc.invalidateQueries({ queryKey: key })
  }
}
