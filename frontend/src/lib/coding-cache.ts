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
 * 🔴 **#1337: what a coding moves is a POPULATION, and `coding-cache-population.test.ts`
 * classifies every query-key root in `src/`** — a new root fails it until it says whether a
 * coding changes it. ⚠️ A root in this list must be INACTIVE on every coding workbench: an
 * active one is refetched on every chord, and a workbench that also invalidates its own
 * copy re-issues the request (TanStack cancels the in-flight fetch and starts another).
 * So a workbench's OWN list (`['observation-segments', …]`, `['document', …]`,
 * `text-data`, `codes`) is invalidated by its hosts — the test names them.
 *
 * `opts.metrics`: also invalidate the dataset analysis aggregates that TEXT-coding-domain
 * code changes feed (`['metrics']` scale scores, `['canvas-chart']` inline charts). Pass true
 * only from text-coding / qualitative-analysis / codebook-CRUD sites — conversation/document
 * coding does not feed dataset metrics, so it leaves these alone.
 *
 * New code-application / code-edit mutation sites MUST route through this helper rather than
 * re-listing the cross-surface keys (the convention-only drift was the #450 root cause).
 */
export const DERIVED_COUNT_ROOTS = [
  'search',
  'project-summary',
  'codebook-tree',
  'consensus-status',
  'code-sample-segments',
  'irr',
  'reconciliation',
  // #1030 — the model comparison is a tab of its own now, opened straight after
  // the coding import that fills it; a coding on either side moves its figures.
  'machine-agreement',
  // Group A (#1/#3/#13): per-source / per-project coder coverage — a coder's
  // first (or last) code on a source changes who's "active here".
  'coder-coverage',
  // #1337 — Qualitative Analysis. Staleness there was bounded only by the 60 s
  // staleTime; the open-cut tab (binned κ, unitizing α) is observation coding's.
  'code-frequencies',
  'qual-source-frequencies',
  'qual-saturation',
  'qual-demographic-comparison',
  'code-cooccurrence',          // also the Canvas's co-occurrence embed
  'binned-kappa',
  'unitizing-alpha',
  'qual-text-columns',          // which text columns carry coding (the source picker)
  // #1337 — the Content and Quote Board tabs' lists and read-only source panes. Coding
  // a document passage or a clip from Content › by source left its chips stale: the
  // page's own handler named the conversation and text panes only.
  'code-segments-context',
  'code-texts-context',
  'excerpts-quoted',
  'conversation-segments-readonly',
  'document-segments-readonly',
  'text-column-readonly',
  // #1337 — the Canvas's qualitative embeds hold 5 min (`InlineChartRenderer`), so
  // without these a coding never reached them inside a working session.
  'canvas-qual-chart',
  'canvas-qual-saturation',
  'canvas-qual-comparison',
  // ROADMAP row 56 — the joint display's counts and rated cells, and a pin's suggested
  // passages (their chips): a coding or a rating's code moves both.
  'joint-display',
  'joint-display-passages',
  // Joint display slice 2, round 2 (r5): the case view and each row's misfit count — a case's
  // "used / not used" is its codings, so a coding moves it.
  'joint-display-cases',
  // #1337 — the Ratings page: an applied ratable code adds a passage to rate.
  'rating-queue',
  // #1337 — Text Coding's Analysis tab (`CrossAnalysisPanel`), mounted only on that
  // tab, so a coding made on the table tab reached it only after 60 s.
  'text-filtered-freq',
  'text-crosstab',
  'text-density',
  'text-length',
] as const

/** With `opts.metrics` (text-coding / qualitative-analysis / codebook CRUD). */
export const DERIVED_METRIC_ROOTS = ['metrics', 'canvas-chart'] as const

export function invalidateDerivedCounts(
  qc: QueryClient,
  projectId: number | string,
  opts?: { metrics?: boolean },
): void {
  const roots: readonly string[] = opts?.metrics
    ? [...DERIVED_COUNT_ROOTS, ...DERIVED_METRIC_ROOTS]
    : DERIVED_COUNT_ROOTS
  for (const root of roots) {
    qc.invalidateQueries({ queryKey: [root, projectId] })
  }
}

/**
 * #1425 — what a RATING moves, on every screen but the one it was given on.
 *
 * A rating changes no coded COUNT, so `invalidateDerivedCounts` is the wrong list — but
 * it is an input to the rating α (`irr`'s `magnitude_per_code`, held 5 minutes), the
 * reconciliation grid (ratings by coder, *Ratings differ*, the consensus median), the
 * consensus layer's stale count (the server marks the target, `routers/coding.py`), the
 * Ratings page's queue (a rated passage leaves it, an unrated one returns), the rating
 * chips in Content › by source, and the participant table's "out of date" marker
 * (`managed_stale`, read from `dataset-data` — the dataset LIST carries it too). Before
 * this, no rating door refreshed any of them.
 *
 * Every root here is INACTIVE on every surface that rates (the four workbenches, the
 * Ratings page, the scale dialog), so invalidating marks them stale at no network cost —
 * the #450 bargain. ⚠️ **`rating-queue` is marked with `refetchType: 'none'`**: it IS
 * active on the Ratings page, and its own write needs no queue request per keypress. That
 * is cost, not correctness — `'none'` does not freeze an active query (the next refocus
 * or remount re-reads it), which is why the page itself never trusts its queue to stay
 * still (#1456).
 *
 * `opts.lists` also marks the four workbench lists — ONLY from a surface where none of
 * them is active (the Ratings page): on a workbench its own list is refetched by its
 * writer, and a second invalidation of an active query re-issues the request.
 * `['segments', cid]` carries a conversation id, not the project's, so it is marked by
 * its root alone.
 */
export const RATING_DERIVED_ROOTS = [
  'irr', 'reconciliation', 'consensus-status',
  'conversation-segments-readonly', 'document-segments-readonly', 'text-column-readonly',
  'datasets', 'dataset-data',
  // ROADMAP row 56 — a joint display's rated cells are the live rollup (D168.2).
  'joint-display',
  // r5: a case's value on a participant-score variable, and a rule over one, move with a rating.
  'joint-display-cases',
] as const

/** The workbench lists — marked only with `opts.lists`. */
export const RATING_LIST_ROOTS = ['document', 'observation-segments', 'text-data'] as const

export function invalidateAfterRating(
  qc: QueryClient,
  projectId: number | string,
  opts?: { lists?: boolean },
): void {
  for (const root of RATING_DERIVED_ROOTS) {
    qc.invalidateQueries({ queryKey: [root, projectId] })
  }
  qc.invalidateQueries({ queryKey: ['rating-queue', projectId], refetchType: 'none' })
  if (opts?.lists) {
    for (const root of RATING_LIST_ROOTS) qc.invalidateQueries({ queryKey: [root, projectId] })
    qc.invalidateQueries({ queryKey: ['segments'] })
  }
}

/**
 * After a BULK coding import (row 49) — EVERY query in the cache, not the list above.
 *
 * 🔴 **#1038 (d): the list above is the set ONE coding moves on OTHER screens; an import
 * moves every coding surface at once** — the code list's "N uses", the qualitative
 * analysis frequencies, Text Coding's totals and gauges, the segment lists — and the page's
 * finish offers *Open Qualitative Analysis*, whose frequencies had been served from the
 * cache for up to a minute showing none of what was just imported. Naming each of those
 * keys here would be the #450 hand-list again, one surface short the day a surface is added.
 *
 * 🔴 **#1082 (c): "this project's queries" was itself a hand-list, one key shape long.** It
 * matched `queryKey[1] === projectId`, and the conversation workbench's segment list is
 * `['segments', conversationId]` — a SOURCE id in that slot — so imported chips could be
 * missing there for its 60 s `staleTime`; `['dataset-data', datasetId]` and
 * `['participant-detail', participantId]` are keyed the same way. A key's second element
 * is not a project id by any rule the cache can check, so the import invalidates
 * everything: there is no key it can miss.
 *
 * Cheap for the reason the helper above is: an import runs from its own page, so nearly
 * every query is INACTIVE — marked stale at no network cost and refetched when its screen
 * opens. Another project's queries are marked too, and cost one refetch each if opened.
 */
export function invalidateAfterCodingImport(qc: QueryClient, projectId: number | string): void {
  invalidateDerivedCounts(qc, projectId, { metrics: true })
  qc.invalidateQueries()
}
