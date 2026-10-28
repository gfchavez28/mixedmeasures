/**
 * #1363 — the Canvas export's TABLE for a scalar chart printed `0` for a
 * statistic the server could not compute. Markdown has no image at all, and
 * HTML/PDF/docx fall back to these tables whenever capture does not run, so the
 * table is the figure for those readers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CanvasTheme } from '@/lib/api'

vi.mock('html-to-image', () => ({ toPng: vi.fn() }))
vi.mock('@/lib/api', () => ({
  metricsApi: { quickCompute: vi.fn(), crossTabulation: vi.fn() },
  comparisonsApi: { groupComparison: vi.fn() },
  codeAnalysisApi: {
    sourceFrequencies: vi.fn(), frequencies: vi.fn(), saturation: vi.fn(),
    cooccurrence: vi.fn(), demographicComparison: vi.fn(),
  },
  codesApi: { list: vi.fn() },
  observationsApi: { list: vi.fn(), listSegments: vi.fn() },
}))

import { metricsApi } from '@/lib/api'
import { fetchChartTables } from './canvas-export'

const LENS = { blind: false, self: null, machineCoderIds: new Set<number>() as ReadonlySet<number> }

function themeWithChart(config: Record<string, unknown>): CanvasTheme[] {
  return [{ id: 1, content: { type: 'doc', content: [{ type: 'chart-embed', attrs: { materialId: 1, config: JSON.stringify(config) } }] } } as unknown as CanvasTheme]
}
const m = (id: number, type: string, results: unknown[]) =>
  ({ id, name: `Q${id}`, metric_type: type, input_source_id: id, input_source_type: 'dataset_column', results })

/** The body rows of a Markdown table, as cell arrays. */
function mdRows(md: string): string[][] {
  return md.split('\n').slice(2).map(l => l.split('|').slice(1, -1).map(c => c.trim()))
}

beforeEach(() => vi.mocked(metricsApi.quickCompute).mockReset())

describe('#1363 — the exported scalar table', () => {
  it('an undefined proportion is "—" and why, a real 0% is 0', async () => {
    vi.mocked(metricsApi.quickCompute).mockResolvedValue({
      metrics: [
        m(1, 'proportion', [{ group_value: null, valid_n: 0, result_data: { percentage: null } }]),
        m(2, 'proportion', [{ group_value: null, valid_n: 40, result_data: { percentage: 0 } }]),
      ],
    } as never)
    const t = await fetchChartTables(themeWithChart({ column_ids: [1, 2], metric_type: 'proportion', chart_type: 'horizontal_bar' }), 3, LENS)
    const rows = mdRows(t.get(1)!.md)
    expect(rows[0][1]).not.toBe('0')
    expect(rows[0][1]).toMatch(/^—/)
    expect(rows[0][1]).toContain('Not computable')
    expect(rows[1][1]).toBe('0')
  })

  it('the dumbbell table: an undefined group reads "—", and a missing group does not shift the columns', async () => {
    vi.mocked(metricsApi.quickCompute).mockResolvedValue({
      metrics: [
        m(1, 'mean', [
          { group_value: 'A', valid_n: 0, result_data: { mean: null } },
          { group_value: 'B', valid_n: 4, result_data: { mean: 3 } },
          { group_value: 'C', valid_n: 4, result_data: { mean: 5 } },
        ]),
        // no result for group B at all
        m(2, 'mean', [
          { group_value: 'A', valid_n: 4, result_data: { mean: 1 } },
          { group_value: 'C', valid_n: 4, result_data: { mean: 9 } },
        ]),
      ],
    } as never)
    const t = await fetchChartTables(themeWithChart({ column_ids: [1, 2], metric_type: 'mean', chart_type: 'dumbbell', grouping_column_id: 9 }), 3, LENS)
    const md = t.get(1)!.md
    const header = md.split('\n')[0].split('|').slice(1, -1).map(c => c.trim())
    expect(header).toEqual(['Metric', 'A', 'B', 'C', 'N'])
    const rows = mdRows(md)
    expect(rows[0][1]).toMatch(/^—/)
    expect(rows[0][2]).toBe('3')
    // Q2's C value sits under C, not under B
    expect(rows[1][1]).toBe('1')
    expect(rows[1][3]).toBe('9')
  })

  it('RIDE-ALONG (#1314 class): with every value defined, a metric missing a group keeps its columns', async () => {
    vi.mocked(metricsApi.quickCompute).mockResolvedValue({
      metrics: [
        m(1, 'mean', [
          { group_value: 'A', valid_n: 4, result_data: { mean: 2 } },
          { group_value: 'B', valid_n: 4, result_data: { mean: 3 } },
          { group_value: 'C', valid_n: 4, result_data: { mean: 5 } },
        ]),
        m(2, 'mean', [
          { group_value: 'A', valid_n: 4, result_data: { mean: 1 } },
          { group_value: 'C', valid_n: 4, result_data: { mean: 9 } },
        ]),
      ],
    } as never)
    const t = await fetchChartTables(themeWithChart({ column_ids: [1, 2], metric_type: 'mean', chart_type: 'dumbbell', grouping_column_id: 9 }), 3, LENS)
    const rows = mdRows(t.get(1)!.md)
    // HEAD: ['Q2', '1', '9', '4'] — C's 9 printed under B, and the N column under C
    expect(rows[1]).toEqual(['Q2', '1', '', '9', '4'])
  })
})
