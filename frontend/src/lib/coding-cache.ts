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
    // #1030 — the model comparison is a tab of its own now, opened straight after
    // the coding import that fills it; a coding on either side moves its figures.
    ['machine-agreement', projectId],
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

/**
 * After a BULK coding import (row 49) — every query of this project, not the list above.
 *
 * 🔴 **#1038 (d): the list above is the set ONE coding moves on OTHER screens; an import
 * moves every coding surface at once** — the code list's "N uses", the qualitative
 * analysis frequencies, Text Coding's totals and gauges, the segment lists — and the page's
 * finish offers *Open Qualitative Analysis*, whose frequencies had been served from the
 * cache for up to a minute showing none of what was just imported. Naming each of those
 * keys here would be the #450 hand-list again, one surface short the day a surface is added.
 *
 * Cheap for the reason the helper above is: an import runs from its own page, so nearly
 * every one of these queries is INACTIVE — marked stale at no network cost and refetched
 * when its screen opens. `String()` because a project id reaches keys as a number from the
 * layout and as a string from a route param.
 */
export function invalidateAfterCodingImport(qc: QueryClient, projectId: number | string): void {
  invalidateDerivedCounts(qc, projectId, { metrics: true })
  const pid = String(projectId)
  qc.invalidateQueries({ predicate: (query) => String(query.queryKey[1]) === pid })
}
