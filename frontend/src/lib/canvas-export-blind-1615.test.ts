/**
 * #1615 — a Canvas export's chart tables (the Markdown, the Word fallback table) follow blind
 * mode as the embed on screen does: the viewer alone while the export lens is blind, nothing
 * extra for every coder, and NO read at all while blind with no viewer to scope to (D96).
 *
 * Positive control: with blind mode off the request is exactly the request before #1615
 * (no `coder_ids` key), so every existing export is unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CanvasTheme } from '@/lib/api'

vi.mock('html-to-image', () => ({ toPng: vi.fn() }))
vi.mock('@/lib/api', () => ({
  metricsApi: { quickCompute: vi.fn(), crossTabulation: vi.fn() },
  comparisonsApi: { groupComparison: vi.fn() },
  codeAnalysisApi: {},
  codesApi: { list: vi.fn() },
  observationsApi: { list: vi.fn(), listSegments: vi.fn() },
}))

import { metricsApi, comparisonsApi } from '@/lib/api'
import { fetchChartTables } from './canvas-export'

const NO_MACHINES: ReadonlySet<number> = new Set()
const lens = (blind: boolean, self: number | null) => ({ blind, self, machineCoderIds: NO_MACHINES })

function themeWithChart(config: Record<string, unknown>): CanvasTheme[] {
  return [{ id: 1, content: { type: 'doc', content: [
    { type: 'chart-embed', attrs: { materialId: 1, config: JSON.stringify(config) } },
  ] } } as unknown as CanvasTheme]
}

const DESCRIPTIVES = { chart_type: 'bar', column_ids: [10], metric_type: 'mean' }
const CROSS_TAB = { chart_type: 'cross_tab', column_ids: [7], cross_tab_column_id: 12 }

beforeEach(() => {
  vi.mocked(metricsApi.quickCompute).mockReset().mockResolvedValue({ metrics: [], computed_count: 0, reused_count: 0 } as never)
  vi.mocked(metricsApi.crossTabulation).mockReset().mockResolvedValue({
    row_values: [], col_values: [], matrix: [], row_totals: [], col_totals: [], n_shared: 0,
    row_column_label: 'a', col_column_label: 'b', chi_square: null,
  } as never)
  vi.mocked(comparisonsApi.groupComparison).mockReset()
})

describe('the Canvas export follows blind mode (#1615)', () => {
  it('the viewer alone while blind, on the metric and the cross-tab reads', async () => {
    await fetchChartTables(themeWithChart(DESCRIPTIVES), 3, lens(true, 7))
    expect(vi.mocked(metricsApi.quickCompute).mock.calls[0][1]).toMatchObject({ coder_ids: [7] })
    await fetchChartTables(themeWithChart(CROSS_TAB), 3, lens(true, 7))
    expect(vi.mocked(metricsApi.crossTabulation).mock.calls[0][1]).toMatchObject({ coder_ids: [7] })
  })

  it('positive control: blind mode off sends the request exactly as before', async () => {
    await fetchChartTables(themeWithChart(CROSS_TAB), 3, lens(false, 7))
    expect(metricsApi.crossTabulation).toHaveBeenCalledWith(3, { row_column_id: 7, col_column_id: 12, include_chi_square: true })
  })

  it('blind with no viewer id: reads nothing and says why in the file (D96)', async () => {
    const tables = await fetchChartTables(themeWithChart(DESCRIPTIVES), 3, lens(true, null))
    expect(metricsApi.quickCompute).not.toHaveBeenCalled()
    expect(tables.get(1)?.md).toBe('*[The chart was not computed: the coder could not be identified while blind mode is on.]*')
  })
})
