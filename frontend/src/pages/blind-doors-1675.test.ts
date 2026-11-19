/**
 * #1675 D358–D360 — the doors #1615's client census missed: the Data view's variable-group
 * scores, the metric list, and Text Coding's record context each send the viewer's scope while
 * blind mode withholds, key the answer by it and wait for the blind state to settle (D96); and
 * *Refresh scores* says only that it ran while withholding.
 *
 * The request SHAPES and the words are pinned by behaviour below; the WIRING in the pages is a
 * SOURCE scan, stated as such (neither page is mounted here — the server's answer is pinned in
 * `backend/tests/test_record_context_blind_1675.py` and `test_blind_rating_analysis_1615.py`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { stripComments } from '@/lib/strip-comments'

const api = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client')
  return { ...actual, default: { get: (...a: unknown[]) => api.get(...a) } }
})

import { datasetsApi } from '@/lib/api/datasets'
import { metricsApi } from '@/lib/api/metrics'
import { textCodingApi } from '@/lib/api/text-coding'
import { refreshToastText, SCORES_REFRESHED_TEXT } from '@/lib/magnitude-rollup-basis'
import { withheldGroupScoresNotice } from '@/lib/blind-rating-columns'

const src = (rel: string) => stripComments(readFileSync(`${__dirname}/../${rel}`, 'utf8'))

beforeEach(() => { api.get.mockReset(); api.get.mockResolvedValue({ data: {} }) })

describe('the three requests carry the scope only when there is one', () => {
  it('getDomainScores, metricsApi.list and recordContext send coder_ids while scoped', async () => {
    await datasetsApi.getDomainScores(1, 2, '7')
    await metricsApi.list(1, '7')
    await textCodingApi.recordContext(1, 9, '7')
    for (const call of api.get.mock.calls) expect(call[1]).toEqual({ params: { coder_ids: '7' } })
  })
  it('CONTROL: every coder sends the request it always sent', async () => {
    await datasetsApi.getDomainScores(1, 2)
    await metricsApi.list(1)
    await textCodingApi.recordContext(1, 9)
    for (const call of api.get.mock.calls) expect(call[1]).toBeUndefined()
  })
})

describe('the words', () => {
  const report = { participants_scored: 12, participants_coded_unrated: 3, excluded_ratings: { facilitator_turn: 2 } }
  it('D360: while withholding, the refresh says only that it ran — no every-coder count', () => {
    expect(refreshToastText(report, true)).toBe(SCORES_REFRESHED_TEXT)
    expect(refreshToastText(report, true)).not.toMatch(/12|3|2/)
    expect(refreshToastText(report, false)).toMatch(/Scored 12 participants/)   // control
  })
  it('D358: a withheld group score is said, and nothing is said when none was', () => {
    expect(withheldGroupScoresNotice(0)).toBeNull()
    expect(withheldGroupScoresNotice(1)).toMatch(/^1 variable group's score is hidden while blind/)
    expect(withheldGroupScoresNotice(2)).toMatch(/^2 variable groups' scores are hidden/)
  })
})

describe('the wiring a scan can see', () => {
  it('the Data view: the group scores follow the grid’s scope, and the refresh toast fails closed', () => {
    const page = src('pages/DatasetView.tsx')
    expect(page).toContain("queryKey: ['domain-scores', pid, iid, coderScope ?? 'every-coder']")
    expect(page).toContain('datasetsApi.getDomainScores(pid, iid, coderScope)')
    expect(page).toMatch(/enabled: !!pid && !!iid && scopeReady,\s*staleTime: 60_000,\s*\}\)\s*const domainScoreCols/)
    expect(page).toContain('withheld_rating_variables')
    expect(page).toContain('refreshToastText(report, coderScope !== undefined || !scopeReady)')
    expect(page).not.toMatch(/toast\.success\(describeRefresh\(/)
  })
  it('the metric list: keyed by the analysis scope wherever it is read or patched', () => {
    for (const rel of ['pages/AnalysisView.tsx', 'pages/CrosswalkView.tsx']) {
      const page = src(rel)
      expect(page).toContain("queryKey: ['metrics', pid, scopeKey]")
      expect(page).toContain('metricsApi.list(pid, coderScope)')
    }
    const hook = src('components/crosswalk/useCrosswalkMutations.ts')
    expect(hook).toContain("const metricsKey = ['metrics', projectId, scopeKey] as const")
    expect(hook).not.toMatch(/QueryData<MetricListResponse>\(\['metrics', projectId\]/)
    expect(hook).toContain('metricsApi.list(projectId, coderScope)')
  })
  it('Text Coding: both record-context readers send the scope, and wait for it', () => {
    const panel = src('components/ByRecordPanel.tsx')
    expect(panel).toContain("queryKey: ['record-context', projectId, currentRecordId, coderScope ?? 'every-coder']")
    expect(panel).toContain('enabled: currentRecordId !== null && scopeReady')
    const table = src('components/ByTextTable.tsx')
    expect(table).toContain('textCodingApi.recordContext(projectId, rid, coderScope)')
    expect(table).toMatch(/if \(!needsContext \|\| !scopeReady\) return/)
    expect(table).toMatch(/\[needsContext, comments, projectId, coderScope, scopeReady\]/)
  })
})
