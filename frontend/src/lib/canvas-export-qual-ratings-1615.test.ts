/**
 * #1615 (D297's Canvas path) — a Canvas export of a QUALITATIVE chart grouped by a variable asks
 * the ratings question of the VIEWER (the export lens), exactly as the embed does, while the
 * figure's coding stays the scope it was SAVED with (the recorded rule, `inline-chart-params.ts`).
 *
 * A grouping refused while blind (D284's 409 — a score band) exports the server's sentence in the
 * Markdown and the HTML, escaped (it names a user's variable). Withholding with no viewer: no read.
 * Positive controls: blind mode off sends exactly the request before #1615 (no new key), and a
 * chart that cannot group (saturation) never sends the viewer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CanvasTheme } from '@/lib/api'

vi.mock('html-to-image', () => ({ toPng: vi.fn() }))
vi.mock('@/lib/api', () => ({
  metricsApi: { quickCompute: vi.fn(), crossTabulation: vi.fn() },
  comparisonsApi: { groupComparison: vi.fn() },
  codeAnalysisApi: { sourceFrequencies: vi.fn(), demographicComparison: vi.fn(), saturation: vi.fn() },
  codesApi: { list: vi.fn() },
  observationsApi: { list: vi.fn(), listSegments: vi.fn() },
}))

import { codeAnalysisApi } from '@/lib/api'
import { fetchChartTables } from './canvas-export'

const NO_MACHINES: ReadonlySet<number> = new Set()
const lens = (blind: boolean, self: number | null) => ({ blind, self, machineCoderIds: NO_MACHINES })
const ALICE = 2

function themeWithChart(config: Record<string, unknown>): CanvasTheme[] {
  return [{ id: 1, content: { type: 'doc', content: [
    { type: 'chart-embed', attrs: { materialId: 1, config: JSON.stringify(config) } },
  ] } } as unknown as CanvasTheme]
}

// A comparison a LEAD saved over every coder (`coder_ids: []`), grouped by a score band.
const SAVED = {
  code_ids: [5], code_mode: 'codes', conversation_ids: [9], text_column_ids: [], document_ids: [],
  observation_ids: [], exclude_facilitator: true, participant_ids: [], coder_ids: [], layer_scope: 'human',
}
const COMPARISON = { ...SAVED, tab: 'relationships', rel_view: 'comparisons', comparison_chart_mode: 'table', group_by: 'Score group' }
const BAR = { ...SAVED, tab: 'descriptives', chart_type: 'bar', group_by: 'Score group' }
const SATURATION = { ...SAVED, tab: 'descriptives', chart_type: 'saturation', group_by: 'Score group' }

const REFUSAL = '“Score <b>group</b>” cannot form groups while blind: it comes from participant scores, '
  + "which combine every coder's ratings, so its groups would show your colleagues' judgements."
const refused = Object.assign(new Error('409'), { status: 409, response: { data: { detail: REFUSAL } } })

beforeEach(() => {
  vi.mocked(codeAnalysisApi.demographicComparison).mockReset().mockResolvedValue({ groups: {}, codes: [] } as never)
  vi.mocked(codeAnalysisApi.sourceFrequencies).mockReset().mockResolvedValue(
    { codes: [], sources: [], totals: {}, group_by: 'Score group' } as never)
  vi.mocked(codeAnalysisApi.saturation).mockReset().mockResolvedValue({ points: [] } as never)
})

describe('a qualitative chart export asks the ratings question of the viewer (#1615)', () => {
  it('blind: the comparison names the viewer, and keeps the figure’s SAVED coder scope', async () => {
    await fetchChartTables(themeWithChart(COMPARISON), 1, lens(true, ALICE))
    const sent = vi.mocked(codeAnalysisApi.demographicComparison).mock.calls[0][1]
    expect(sent.ratings_viewer_id).toBe(ALICE)
    expect(sent.coder_ids).toBeNull()                 // the lead's every-coder figure, unchanged
    expect(sent).not.toHaveProperty('ratings_follow_coder_ids')
  })

  it('blind: a bar grouped by a variable names the viewer too', async () => {
    await fetchChartTables(themeWithChart(BAR), 1, lens(true, ALICE))
    const sent = vi.mocked(codeAnalysisApi.sourceFrequencies).mock.calls[0][1]
    expect(sent.ratings_viewer_id).toBe(ALICE)
    expect(sent.group_by_subtype).toBe('Score group')
  })

  it('positive control: not blind, the requests are exactly as before (no new key)', async () => {
    await fetchChartTables(themeWithChart(COMPARISON), 1, lens(false, ALICE))
    await fetchChartTables(themeWithChart(BAR), 1, lens(false, ALICE))
    expect(vi.mocked(codeAnalysisApi.demographicComparison).mock.calls[0][1]).not.toHaveProperty('ratings_viewer_id')
    expect(vi.mocked(codeAnalysisApi.sourceFrequencies).mock.calls[0][1]).not.toHaveProperty('ratings_viewer_id')
  })

  it('a chart that cannot group never sends the viewer (saturation)', async () => {
    await fetchChartTables(themeWithChart(SATURATION), 1, lens(true, ALICE))
    expect(vi.mocked(codeAnalysisApi.saturation).mock.calls[0][1]).not.toHaveProperty('ratings_viewer_id')
  })

  it('a grouping refused while blind exports the server’s sentence, escaped, in Markdown and HTML', async () => {
    vi.mocked(codeAnalysisApi.demographicComparison).mockRejectedValue(refused)
    const t = (await fetchChartTables(themeWithChart(COMPARISON), 1, lens(true, ALICE))).get(1)!
    expect(t.md).toContain('cannot form groups while blind')
    expect(t.md).toContain('\\<b>')                    // a user's variable name, escaped as it enters
    expect(t.md).not.toMatch(/(?<!\\)<b>/)             // (CommonMark reads `\<` as a literal `<`)
    expect(t.html).toContain('cannot form groups while blind')
    expect(t.html).toContain('&lt;b&gt;group&lt;/b&gt;')
    expect(t.table ?? null).toBeNull()                 // no table: Word prints its own fallback
  })

  it('another failure is still a failure (no sentence invented)', async () => {
    vi.mocked(codeAnalysisApi.demographicComparison).mockRejectedValue(
      Object.assign(new Error('500'), { status: 500, response: { data: { detail: 'boom' } } }))
    const tables = await fetchChartTables(themeWithChart(COMPARISON), 1, lens(true, ALICE))
    expect(tables.has(1)).toBe(false)
  })

  it('blind with no viewer to name: no read at all (D96), and the file says why', async () => {
    const t = (await fetchChartTables(themeWithChart(COMPARISON), 1, lens(true, null))).get(1)!
    expect(codeAnalysisApi.demographicComparison).not.toHaveBeenCalled()
    expect(t.md).toContain('the coder could not be identified while blind mode is on')
  })
})
