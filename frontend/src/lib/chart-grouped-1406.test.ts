/**
 * #1406 — a GROUPED payload drawn or tabulated as the UNGROUPED figure.
 *
 * The fixture is the wire order MEASURED on a scratch stack (quick compute,
 * mean of `score` grouped by `grp`): results arrive ordered by `group_value`
 * with SQLite's NULLs FIRST, so `results[0]` is the missing-group bucket — one
 * record with no group, mean 100 — and every reader of `results[0]` printed
 * that under the variable's name. The groups DISAGREE (3, 6, —, 0), C is
 * undefined (`mean: null`, declared-missing cells) and D is a real zero.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CanvasTheme, MetricDefinitionResponse } from '@/lib/api'

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
import { fetchChartTables, docxChartTables } from './canvas-export'
import { shapeSummaryStats, shapeHistogramBars, describeHistogramBasis } from './chart-data'

const LENS = { blind: false, self: null, machineCoderIds: new Set<number>() as ReadonlySet<number> }

const metric = (id: number, type: string, results: unknown[]) =>
  ({ id, name: `Q${id}`, input_source_label: `score${id}`, metric_type: type, input_source_id: id, input_source_type: 'dataset_column', grouping_column_id: 9, results }) as unknown as MetricDefinitionResponse

/** Mean of `score` by grp, in the measured wire order (NULL bucket first). */
const groupedMean = () => metric(1, 'mean', [
  { group_value: null, valid_n: 1, result_data: { mean: 100 } },
  { group_value: 'A', valid_n: 3, result_data: { mean: 3 } },
  { group_value: 'B', valid_n: 3, result_data: { mean: 6 } },
  { group_value: 'C', valid_n: 0, result_data: { mean: null } },
  { group_value: 'D', valid_n: 3, result_data: { mean: 0 } },
])

/** Frequency of q1 by grp: each group answered one option; the bucket answered "4". */
const groupedFreq = () => metric(6, 'frequency_distribution', [
  { group_value: null, valid_n: 1, result_data: { scale_order: ['4'], counts: { 4: 1 }, percentages: { 4: 100 } } },
  { group_value: 'A', valid_n: 3, result_data: { scale_order: ['1'], counts: { 1: 3 }, percentages: { 1: 100 } } },
  { group_value: 'B', valid_n: 3, result_data: { scale_order: ['5'], counts: { 5: 3 }, percentages: { 5: 100 } } },
])

/** age by grp: 3 + 3 records in groups, 1 with no group (age 99). */
const groupedAge = () => metric(5, 'frequency_distribution', [
  { group_value: null, valid_n: 1, result_data: { counts: { 99: 1 } } },
  { group_value: 'A', valid_n: 3, result_data: { counts: { 20: 1, 22: 1, 24: 1 } } },
  { group_value: 'B', valid_n: 3, result_data: { counts: { 40: 1, 42: 1, 44: 1 } } },
])

function themeWithChart(config: Record<string, unknown>): CanvasTheme[] {
  return [{ id: 1, content: { type: 'doc', content: [{ type: 'chart-embed', attrs: { materialId: 1, config: JSON.stringify(config) } }] } } as unknown as CanvasTheme]
}
function mdRows(md: string): string[][] {
  return md.split('\n').slice(2).map(l => l.split('|').slice(1, -1).map(c => c.trim()))
}
async function exportMd(metrics: MetricDefinitionResponse[], config: Record<string, unknown>) {
  vi.mocked(metricsApi.quickCompute).mockResolvedValue({ metrics } as never)
  const t = await fetchChartTables(themeWithChart({ column_ids: metrics.map(m => m.id), grouping_column_id: 9, ...config }), 3, LENS)
  return t.get(1)!.md
}

beforeEach(() => vi.mocked(metricsApi.quickCompute).mockReset())

describe('#1406 — the exported table of a grouped scalar figure', () => {
  for (const chart_type of ['horizontal_bar', 'vertical_bar', 'table']) {
    it(`${chart_type}: a row per group with its own n; never the missing-group bucket`, async () => {
      const md = await exportMd([groupedMean()], { metric_type: 'mean', chart_type })
      expect(md.split('\n')[0]).toBe('| Metric | Group | Value | N |')
      const rows = mdRows(md)
      expect(rows.map(r => [r[1], r[2], r[3]])).toEqual([
        ['A', '3', '3'], ['B', '6', '3'], ['C', expect.stringMatching(/^— .*Not computable/), '0'], ['D', '0', '3'],
      ])
      expect(md).not.toMatch(/\| 100 \|/)
    })
  }

  it('the saved hidden groups are left out, as the embed leaves them out', async () => {
    const md = await exportMd([groupedMean()], { metric_type: 'mean', chart_type: 'horizontal_bar', hidden_group_values: ['B'] })
    expect(mdRows(md).map(r => r[1])).toEqual(['A', 'C', 'D'])
  })

  it('the dumbbell table honours the saved hidden groups too', async () => {
    const md = await exportMd([groupedMean()], { metric_type: 'mean', chart_type: 'dumbbell', hidden_group_values: ['B'] })
    expect(md.split('\n')[0]).toBe('| Metric | A | C | D | N |')
  })

  it('an UNGROUPED scalar keeps its one-row-per-variable table', async () => {
    const ungrouped = metric(2, 'mean', [{ group_value: null, valid_n: 40, result_data: { mean: 0 } }])
    const md = await exportMd([ungrouped], { metric_type: 'mean', chart_type: 'horizontal_bar' })
    expect(md.split('\n')[0]).toBe('| Metric | Value | N |')
    expect(mdRows(md)).toEqual([[expect.any(String), '0', '40']])
  })
})

describe('#1406 — the exported table of one grouped frequency distribution', () => {
  it('vertical_bar: a row per group, not the bucket’s distribution', async () => {
    const md = await exportMd([groupedFreq()], { metric_type: 'frequency_distribution', chart_type: 'vertical_bar' })
    const rows = mdRows(md)
    expect(rows.map(r => r[0])).toEqual([expect.stringContaining('(A)'), expect.stringContaining('(B)')])
    expect(md).not.toMatch(/^\| Response \|/m)
  })

  it('histogram: the BINS as drawn, pooled across every group (7 records, not 1)', async () => {
    const md = await exportMd([groupedAge()], { metric_type: 'frequency_distribution', chart_type: 'histogram' })
    expect(md.split('\n')[0]).toBe('| Bin | % | Count |')
    const total = mdRows(md).reduce((s, r) => s + Number(r[2]), 0)
    expect(total).toBe(7)
  })
})

describe('#1406 D5 — the .docx renders the export’s own table', () => {
  it('fetchChartTables returns the table its Markdown renders, and the .docx gets exactly that', async () => {
    vi.mocked(metricsApi.quickCompute).mockResolvedValue({ metrics: [groupedMean()] } as never)
    const tables = await fetchChartTables(
      themeWithChart({ column_ids: [1], grouping_column_id: 9, metric_type: 'mean', chart_type: 'horizontal_bar' }), 3, LENS,
    )
    const entry = tables.get(1)!
    expect(entry.table!.headers).toEqual(['Metric', 'Group', 'Value', 'N'])
    expect(entry.table!.rows).toEqual(mdRows(entry.md))
    expect(docxChartTables(tables).get(1)).toBe(entry.table)
  })

  it('a table the shapers could not build is NOT sent, so the .docx says the data is unavailable', async () => {
    // A result whose `result_data` is null throws inside the shaper.
    vi.mocked(metricsApi.quickCompute).mockResolvedValue({ metrics: [metric(2, 'mean', [{ group_value: null, valid_n: 1, result_data: null }])] } as never)
    const tables = await fetchChartTables(themeWithChart({ column_ids: [2], metric_type: 'mean', chart_type: 'horizontal_bar' }), 3, LENS)
    expect(tables.get(1)!.md).toMatch(/could not be converted/)
    expect(tables.get(1)!.table).toBeNull()
    expect(docxChartTables(tables).size).toBe(0)
  })
})

describe('#1406 — the shared shapers', () => {
  it('shapeSummaryStats: a row per (variable, group) with that group’s n and mean', () => {
    const rows = shapeSummaryStats([groupedMean()], undefined, 'mean')
    expect(rows.map(r => [r.groupValue, r.n, r.mean])).toEqual([
      ['A', 3, 3], ['B', 3, 6], ['C', 0, null], ['D', 3, 0],
    ])
    expect(rows[0].label).toBe('score1 (A)')
    expect(new Set(rows.map(r => `${r.metricId}/${r.groupValue}`)).size).toBe(rows.length)
  })

  it('shapeSummaryStats: an UNGROUPED payload keeps one row, groupValue null', () => {
    const rows = shapeSummaryStats([metric(2, 'mean', [{ group_value: null, valid_n: 40, result_data: { mean: 2 } }])], undefined, 'mean')
    expect(rows.map(r => [r.groupValue, r.n, r.mean, r.label])).toEqual([[null, 40, 2, 'score2']])
  })

  it('shapeHistogramBars: a grouped payload is the variable’s whole distribution, and says so', () => {
    const { bars, histogram } = shapeHistogramBars(groupedAge())
    expect(bars.reduce((s, b) => s + (b.count ?? 0), 0)).toBe(7)
    expect(bars[0].n).toBe(7)
    expect(describeHistogramBasis(histogram)).toContain('All groups combined')
  })

  it('shapeHistogramBars: an ungrouped payload states no pooling', () => {
    const { histogram } = shapeHistogramBars(metric(5, 'frequency_distribution', [{ group_value: null, valid_n: 3, result_data: { counts: { 1: 1, 2: 1, 3: 1 } } }]))
    expect(describeHistogramBasis(histogram)).not.toContain('All groups combined')
  })
})
