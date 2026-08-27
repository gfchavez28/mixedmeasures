/**
 * #525b — the Q–Q request parameter must appear in its query's KEY.
 *
 * `include_qq` is opt-in, so the same comparison selection is fetched with the
 * flag off (table, dumbbell, grouped, box) and on (Q–Q). React Query caches on
 * the key alone: a query that SENDS a parameter and does not KEY on it serves
 * the response from before the parameter changed. Here that means switching to
 * the Q–Q panel renders an empty chart from cache — and then renders correctly
 * after any unrelated refetch, which is the shape of bug that gets filed as
 * "intermittent" and never reproduced.
 *
 * This is the #454 family, which the internal design notes records as recurring: *"a query
 * sending `effectiveCoderIncludeCsv` must put that value in its `queryKey`, or
 * Reveal serves a stale cache."* Same defect, different parameter.
 *
 * ⚠️ **A scan, not a component test.** Mounting `AnalysisView` to observe a
 * cache miss needs a query client, a router, a project fixture and four mocked
 * endpoints, and it would still only cover the one query that exists today.
 *
 * ⚠️ **Comments are stripped before scanning** — the #772 lesson: this file's
 * own prose names `include_qq` and `queryKey`, and a naive scan of the source
 * would match explanatory text as though it were code.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from './strip-comments'

const ANALYSIS_VIEW = join(__dirname, '..', 'pages', 'AnalysisView.tsx')

/** The `useQuery({...})` object literal whose queryKey names `group-comparison`. */
function comparisonQueryBlock(src: string): string {
  const anchor = src.indexOf("'group-comparison'")
  expect(anchor, 'the comparison query moved or was renamed').toBeGreaterThan(-1)
  // From the key back to the enclosing useQuery, forward to `staleTime` — the
  // last field of every query object in this file.
  const start = src.lastIndexOf('useQuery(', anchor)
  const end = src.indexOf('staleTime', anchor)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(anchor)
  return src.slice(start, end)
}

describe('#525b — the opt-in Q–Q flag is part of the cache key', () => {
  const src = stripComments(readFileSync(ANALYSIS_VIEW, 'utf-8'))

  it('found the query at all — a scan that matches nothing passes by finding nothing', () => {
    // The population self-check (#730): without it, a renamed query key would
    // make every assertion below vacuously true.
    expect(src).toContain("'group-comparison'")
    expect(comparisonQueryBlock(src).length).toBeGreaterThan(200)
  })

  it('SENDS the flag', () => {
    expect(comparisonQueryBlock(src)).toMatch(/include_qq:/)
  })

  it('KEYS on the flag', () => {
    const block = comparisonQueryBlock(src)
    const key = block.slice(block.indexOf('queryKey'), block.indexOf('queryFn'))
    expect(key, 'include_qq is sent but not in the queryKey — stale cache (#454)')
      .toMatch(/includeQq/)
  })

  it('derives the flag from the chart type rather than a literal', () => {
    // A hard-coded `true` would reintroduce the O(n) payload for every panel,
    // which is the cost the opt-in exists to avoid.
    expect(src).toMatch(/const includeQq = rcChartType === 'comparison_qq'/)
  })
})
