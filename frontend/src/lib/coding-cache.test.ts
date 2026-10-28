import { describe, it, expect, vi } from 'vitest'
import type { QueryClient } from '@tanstack/react-query'
import { invalidateDerivedCounts } from './coding-cache'

function makeQc() {
  const invalidateQueries = vi.fn()
  return { qc: { invalidateQueries } as unknown as QueryClient, invalidateQueries }
}

function invalidatedKeys(invalidateQueries: ReturnType<typeof vi.fn>): string[] {
  return invalidateQueries.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey[0] as string)
}

describe('invalidateDerivedCounts (#450, #1337)', () => {
  /**
   * #1337 — an ORACLE written from the screens, not from the helper's array: every
   * reader on ANOTHER screen whose numbers or chips a single coding moves, keyed as the
   * real query is (project id second, then that query's own params).
   */
  const READERS_A_CODING_MOVES: unknown[][] = [
    ['search', 7, 'q'], ['project-summary', 7], ['codebook-tree', 7, {}],
    ['consensus-status', 7], ['code-sample-segments', 7, 3], ['irr', 7, null],
    ['reconciliation', 7, null, false], ['machine-agreement', 7, null], ['coder-coverage', 7, null, null, ''],
    // Qualitative Analysis (QualitativeAnalysisView, QualCooccurrence, OpenCutReliability)
    ['code-frequencies', 7, {}], ['qual-source-frequencies', 7, {}], ['qual-saturation', 7, false],
    ['qual-demographic-comparison', 7, 'g'], ['code-cooccurrence', 7, false], ['binned-kappa', 7, 2, 5],
    ['unitizing-alpha', 7, 2], ['qual-text-columns', 7],
    // Content / Quote Board lists and the read-only source panes (ContentByCode, ContentBySource)
    ['code-segments-context', 7, 3], ['code-texts-context', 7, 3], ['excerpts-quoted', 7],
    ['conversation-segments-readonly', 7, 4], ['document-segments-readonly', 7, 5], ['text-column-readonly', 7, 6, ''],
    // The Canvas's qualitative embeds (InlineChartRenderer — 5 min staleTime)
    ['canvas-qual-chart', 7, 1, {}], ['canvas-qual-saturation', 7, 1, {}], ['canvas-qual-comparison', 7, 1, {}],
    // The Ratings page; Text Coding's Analysis tab (CrossAnalysisPanel)
    ['rating-queue', 7, null], ['text-filtered-freq', 7, '6'], ['text-crosstab', 7, '6'],
    ['text-density', 7, '6'], ['text-length', 7, '6'],
  ]
  /** Controls: another project; dataset readers; a workbench's OWN active list. */
  const NOT_MOVED: unknown[][] = [
    ['code-frequencies', 8, {}],            // project 8 — the prefix must carry the id
    ['memos', 7], ['datasets', 7], ['correlation-matrix', 7],
    ['metrics', 7], ['canvas-chart', 7, 1], // only with `{ metrics: true }`
    ['segments', 4], ['observation-segments', 7, 2], ['text-data', 7], ['codes', 7],
  ]

  it('🔴 stales every reader on another screen that a coding moves — and nothing else', async () => {
    const { QueryClient: RealClient } = await import('@tanstack/react-query')
    const qc = new RealClient()
    for (const key of [...READERS_A_CODING_MOVES, ...NOT_MOVED]) qc.setQueryData(key, 1)
    invalidateDerivedCounts(qc, 7)
    const stale = (k: unknown[]) => qc.getQueryCache().find({ queryKey: k, exact: true })?.state.isInvalidated
    expect(READERS_A_CODING_MOVES.filter(k => !stale(k)).map(k => k[0])).toEqual([])
    expect(NOT_MOVED.filter(k => stale(k)).map(k => `${k[0]}:${k[1]}`)).toEqual([])
  })

  it('keys carry the projectId for prefix-match invalidation', () => {
    const { qc, invalidateQueries } = makeQc()
    invalidateDerivedCounts(qc, 42)
    for (const call of invalidateQueries.mock.calls) {
      expect((call[0] as { queryKey: unknown[] }).queryKey[1]).toBe(42)
    }
  })

  it('does NOT touch dataset metrics by default (conversation/document coding)', () => {
    const { qc, invalidateQueries } = makeQc()
    invalidateDerivedCounts(qc, 1)
    const keys = invalidatedKeys(invalidateQueries)
    expect(keys).not.toContain('metrics')
    expect(keys).not.toContain('canvas-chart')
  })

  it('adds metrics + canvas-chart when opts.metrics is set (text-coding / qual-analysis)', () => {
    const { qc, invalidateQueries } = makeQc()
    invalidateDerivedCounts(qc, 1, { metrics: true })
    const keys = invalidatedKeys(invalidateQueries)
    expect(keys).toContain('metrics')
    expect(keys).toContain('canvas-chart')
    const plain = makeQc()
    invalidateDerivedCounts(plain.qc, 1)
    expect(keys.length - invalidatedKeys(plain.invalidateQueries).length).toBe(2)
  })
})

describe('invalidateAfterCodingImport (#1038 d, #1082 c)', () => {
  it('🔴 stales EVERY query in the cache — a SOURCE-keyed segment list included', async () => {
    const { QueryClient: RealClient } = await import('@tanstack/react-query')
    const { invalidateAfterCodingImport } = await import('./coding-cache')
    const qc = new RealClient()
    const keys: unknown[][] = [
      ['code-frequencies', 7, { coder: 'x' }],
      ['text-coding-texts', '7'],          // a route param reaches keys as text
      ['codes', 7],
      // #1082 (c): the conversation workbench keys its segments by CONVERSATION, so
      // "this project's queries" (`queryKey[1] === projectId`) never matched it, and
      // imported chips were missing there until the 60 s staleTime ran out.
      ['segments', 42],
      ['dataset-data', 9],                 // keyed by dataset — the same shape
      ['participant-detail', 3],           // keyed by participant
      ['coders'],                          // the roster: the page also RESETS it (#964)
    ]
    for (const key of keys) qc.setQueryData(key, 1)

    invalidateAfterCodingImport(qc, 7)

    // Population, not a list of expectations: a key shape nobody named here is covered too.
    const all = qc.getQueryCache().getAll()
    expect(all.length).toBe(keys.length)
    expect(all.filter(q => !q.state.isInvalidated).map(q => q.queryKey)).toEqual([])
  })
})

describe('invalidateAfterRating (#1425)', () => {
  /**
   * An ORACLE written from the server, not from the helper's array: every reader whose
   * payload carries a rating, or a figure computed from one (`grep -rln magnitude
   * backend/app/routers backend/app/services`), keyed as the real query is.
   */
  const READERS_A_RATING_MOVES: unknown[][] = [
    ['irr', 7, null, null],                       // magnitude_per_code — the rating α (5 min staleTime)
    ['reconciliation', 7, null, false],           // ratings_by_coder, has_rating_disagreement
    ['consensus-status', 7],                      // the server marks the target stale
    ['rating-queue', 7, null],                    // a rated passage leaves it
    ['conversation-segments-readonly', 7, 4],     // Content › by source: chips carry the rating
    ['document-segments-readonly', 7, 5],
    ['text-column-readonly', 7, 6, ''],
    ['dataset-data', 7, 9, 0],                    // the participant table's managed_stale
    ['datasets', 7],
  ]
  /** A rating moves no coded count; the workbench lists only with `lists`. */
  const NOT_MOVED: unknown[][] = [
    ['irr', 8, null, null],                       // another project
    ['code-frequencies', 7, {}], ['codes', 7], ['project-summary', 7], ['coder-coverage', 7, null, null, ''],
    ['segments', 4], ['document', 7, 5], ['observation-segments', 7, 2], ['text-data', 7, '6'],
  ]

  it('🔴 stales every reader a rating moves — and no count', async () => {
    const { QueryClient: RealClient } = await import('@tanstack/react-query')
    const { invalidateAfterRating } = await import('./coding-cache')
    const qc = new RealClient()
    for (const key of [...READERS_A_RATING_MOVES, ...NOT_MOVED]) qc.setQueryData(key, 1)
    invalidateAfterRating(qc, 7)
    const stale = (k: unknown[]) => qc.getQueryCache().find({ queryKey: k, exact: true })?.state.isInvalidated
    expect(READERS_A_RATING_MOVES.filter(k => !stale(k)).map(k => k[0])).toEqual([])
    expect(NOT_MOVED.filter(k => stale(k)).map(k => `${k[0]}:${k[1]}`)).toEqual([])
  })

  it('with `lists` (the Ratings page) the four workbench lists too — `segments` by its root', async () => {
    const { QueryClient: RealClient } = await import('@tanstack/react-query')
    const { invalidateAfterRating } = await import('./coding-cache')
    const qc = new RealClient()
    const lists = [['segments', 4], ['document', 7, 5], ['observation-segments', 7, 2], ['text-data', 7, '6']]
    for (const key of [...lists, ['code-frequencies', 7, {}]]) qc.setQueryData(key, 1)
    invalidateAfterRating(qc, 7, { lists: true })
    const stale = (k: unknown[]) => qc.getQueryCache().find({ queryKey: k, exact: true })?.state.isInvalidated
    expect(lists.filter(k => !stale(k)).map(k => k[0])).toEqual([])
    expect(stale(['code-frequencies', 7, {}])).toBe(false)
  })

  it('🔴 marks an ACTIVE queue without refetching it (the Ratings page’s own write)', async () => {
    const { QueryClient: RealClient, QueryObserver } = await import('@tanstack/react-query')
    const { invalidateAfterRating } = await import('./coding-cache')
    const qc = new RealClient()
    const queryFn = vi.fn().mockResolvedValue({ entries: [] })
    const unsub = new QueryObserver(qc, { queryKey: ['rating-queue', 7, null], queryFn }).subscribe(() => {})
    // Answered first: a mark that lands while the fetch is in flight is erased when
    // that fetch succeeds (query-core's success state resets `isInvalidated`).
    await vi.waitFor(() => expect(qc.getQueryState(['rating-queue', 7, null])?.status).toBe('success'))
    invalidateAfterRating(qc, 7)
    await new Promise(r => setTimeout(r, 0))
    expect(qc.getQueryState(['rating-queue', 7, null])?.isInvalidated).toBe(true)
    expect(queryFn).toHaveBeenCalledTimes(1)
    unsub()
  })
})
