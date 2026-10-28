/**
 * #1412 — a group nobody answered was drawn as 0% on every response option, in
 * every frequency shaper and the Canvas export's table.
 *
 * The fixtures are the WIRE, copied from `compute_metric` over real columns (the
 * pre-implementation review's backend probe): a DECLARED scale sends `None` per
 * option for an empty group, an UNDECLARED variable sends `percentages: {}` and
 * `scale_order: []` — so the reader keys on `valid_n`, and both shapes are here.
 * Every case pairs the empty group with a REAL 0% (group A answered, none chose
 * "Fair"), which must still read 0.
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
import { fetchChartTables } from './canvas-export'
import {
  frequencyUndefined, frequencyUndefinedReason, undefinedGroupsNote,
  shapeFrequencyBars, shapeFrequencyBarFigure, shapeHeatmapRows, shapeStackedBars,
  shapeDivergingStackedBars, shapeFrequencyTable,
} from './chart-data'

const res = (group_value: string | null, valid_n: number, total_n: number, percentages: Record<string, number | null>, counts: Record<string, number>, scale_order: string[]) =>
  ({ id: 0, group_value, valid_n, total_n, computed_at: '', result_data: { percentages, counts, scale_order } })
const metric = (id: number, name: string, results: ReturnType<typeof res>[], grouped = true) =>
  ({ id, name, metric_type: 'frequency_distribution', input_source_id: id, input_source_type: 'dataset_column',
    grouping_column_id: grouped ? 4 : null, results } as unknown as MetricDefinitionResponse)

const L = ['Poor', 'Fair', 'Good']
/** Declared 3-point scale: A answered (Fair a REAL 0), B answered, C nobody (wire: None per option). */
const q1 = metric(1, 'q1', [
  res(null, 1, 1, { Poor: 0, Fair: 0, Good: 100 }, { Poor: 0, Fair: 0, Good: 1 }, L),
  res('A', 2, 2, { Poor: 50, Fair: 0, Good: 50 }, { Poor: 1, Fair: 0, Good: 1 }, L),
  res('B', 2, 2, { Poor: 0, Fair: 100, Good: 0 }, { Poor: 0, Fair: 2, Good: 0 }, L),
  res('C', 0, 2, { Poor: null, Fair: null, Good: null }, { Poor: 0, Fair: 0, Good: 0 }, L),
])
/** Undeclared numeric: C nobody — the wire carries NO None to read (`{}`, `[]`). */
const score = metric(2, 'score', [
  res(null, 1, 1, { 100: 100 }, { 100: 1 }, ['100']),
  res('A', 2, 2, { 3: 50, 12: 50 }, { 3: 1, 12: 1 }, ['3', '12']),
  res('B', 2, 2, { 4: 50, 6: 50 }, { 4: 1, 6: 1 }, ['4', '6']),
  res('C', 0, 2, {}, {}, []),
])
/** Ungrouped, every record missing. */
const allna = metric(3, 'allna', [res(null, 0, 7, { Poor: null, Fair: null, Good: null }, { Poor: 0, Fair: 0, Good: 0 }, L)], false)

describe('#1412 — the reader', () => {
  it('keys on valid_n, so the undeclared shape (no None anywhere) is undefined too', () => {
    expect(frequencyUndefined(score.results[3])).toBe(true)
    expect(frequencyUndefined(q1.results[3])).toBe(true)
    // control: a group with answers is defined even where an option is 0
    expect(frequencyUndefined(q1.results[1])).toBe(false)
  })

  it('passes the server reason through and invents none', () => {
    expect(frequencyUndefinedReason(q1.results[3])).toBeNull()
    expect(frequencyUndefinedReason({ valid_n: 0, result_data: { undefined_reason: 'empty_group' } })).toBe('empty_group')
    // a reason on a DEFINED result is not this reader's business
    expect(frequencyUndefinedReason({ valid_n: 3, result_data: { undefined_reason: 'empty_group' } })).toBeNull()
    expect(undefinedGroupsNote([{ group: 'C', reason: null }])).toBe('C — Not computable for this data.')
    expect(undefinedGroupsNote([])).toBeNull()
  })
})

describe('#1412 — grouped bars (vertical arm; the horizontal arm reads the same section)', () => {
  it('declared scale: C has no share under any option, and A keeps its real 0', () => {
    const fig = shapeFrequencyBarFigure([q1])
    if (fig.kind !== 'grouped') throw new Error('grouped expected')
    const c = fig.section.groups.find(g => g.groupValue === 'C')!
    expect(c.undefinedStatistic).toBe(true)
    expect(c.bars.map(b => b.value)).toEqual([null, null, null])
    expect(c.bars.map(b => b.count)).toEqual([0, 0, 0]) // counts are real
    const a = fig.section.groups.find(g => g.groupValue === 'A')!
    expect(a.undefinedStatistic).toBeUndefined()
    expect(a.bars.find(b => b.label === 'Fair')!.value).toBe(0)
  })

  it('undeclared: C has no share under the union #1455 gave it', () => {
    const fig = shapeFrequencyBarFigure([score])
    if (fig.kind !== 'grouped') throw new Error('grouped expected')
    const c = fig.section.groups.find(g => g.groupValue === 'C')!
    expect(c.bars.map(b => b.label)).toEqual(['3', '4', '6', '12'])
    expect(c.bars.every(b => b.value === null)).toBe(true)
    // control: A answered, never chose 4 — a real 0 from the zero-fill
    expect(fig.section.groups.find(g => g.groupValue === 'A')!.bars.find(b => b.label === '4')!.value).toBe(0)
  })

  it('ungrouped: a variable nobody answered has no share, a variable with answers keeps its numbers', () => {
    expect(shapeFrequencyBars(allna).map(b => b.value)).toEqual([null, null, null])
    expect(shapeFrequencyBars(allna).map(b => b.count)).toEqual([0, 0, 0])
    const answered = metric(4, 'q', [res(null, 5, 7, { Poor: 20, Fair: 0, Good: 80 }, { Poor: 1, Fair: 0, Good: 4 }, L)], false)
    expect(shapeFrequencyBars(answered).map(b => b.value)).toEqual([20, 0, 80])
  })
})

describe('#1412 — heatmap', () => {
  it('every cell of an empty row is an undefined share (declared AND undeclared); a real 0 stays 0', () => {
    const c = shapeHeatmapRows([q1]).rows.find(r => r.groupLabel === 'C')!
    expect(c.undefinedStatistic).toBe(true)
    expect(c.cells.map(x => x?.percentage)).toEqual([null, null, null])
    expect(c.cells.map(x => x?.count)).toEqual([0, 0, 0])
    const cs = shapeHeatmapRows([score]).rows.find(r => r.groupLabel === 'C')!
    // HEAD: `null` cells — "No data", the same mark as a label this row never saw (#1443)
    expect(cs.cells.every(x => x != null && x.percentage === null)).toBe(true)
    expect(shapeHeatmapRows([allna]).rows[0].cells.map(x => x?.percentage)).toEqual([null, null, null])
    const a = shapeHeatmapRows([q1]).rows.find(r => r.groupLabel === 'A')!
    expect(a.cells[1]).toEqual({ count: 0, percentage: 0 })
    // a defined row keeps `null` for a label it never saw (that is #1443, not this)
    // (columns: the bucket's "100" first — #1443's first-seen order — then 3, 12, 4, 6)
    expect(shapeHeatmapRows([score]).rows.find(r => r.groupLabel === 'A')!.cells[0]).toBeNull()
  })
})

describe('#1412 — stacked and diverging bars', () => {
  it('an empty row stacks no share and says so; a real 0 segment stays 0', () => {
    const st = shapeStackedBars([q1])
    const c = st.rows.find(r => r.groupLabel === 'C')!
    expect(c.undefinedStatistic).toBe(true)
    expect(c.segments.map(s => s.percentage)).toEqual([null, null, null])
    expect(st.rows.find(r => r.groupLabel === 'A')!.segments[1].percentage).toBe(0)
    const dv = shapeDivergingStackedBars(st, 'Fair', 'center', false)
    const dc = dv.rows.find(r => r.groupLabel === 'C')!
    expect(dc.undefinedStatistic).toBe(true)
    expect(Object.values(dc.percentages)).toEqual([null, null, null])
    expect(dv.rows.find(r => r.groupLabel === 'A')!.percentages.Fair).toBe(0)
  })
})

describe('#1412 — the frequency table', () => {
  it('Valid % of an empty group is undefined; its Percent of 2 records is a real 0', () => {
    const t = shapeFrequencyTable([q1], undefined, { groupValue: 'C' })[0]
    expect(t.rows.map(r => r.validPercent)).toEqual([null, null, null])
    expect(t.rows.map(r => r.cumulativeValidPercent)).toEqual([null, null, null])
    expect(t.rows.map(r => r.percent)).toEqual([0, 0, 0])
    const a = shapeFrequencyTable([q1], undefined, { groupValue: 'A' })[0]
    expect(a.rows.map(r => r.validPercent)).toEqual([50, 0, 50])
  })

  it('hiding every answered option leaves 0/0 too — the table renormalises, so it must say so', () => {
    const b = shapeFrequencyTable([q1], undefined, { groupValue: 'B', hiddenLabels: ['Fair'] })[0]
    expect(b.totalValid).toBe(0)
    expect(b.rows.map(r => r.validPercent)).toEqual([null, null])
  })

  it('a table with no records at all has no Percent either (#1432 will create these)', () => {
    const none = metric(5, 'none', [res(null, 0, 0, {}, {}, [])], false)
    const withLabels = metric(6, 'none2', [res(null, 0, 0, { Poor: null }, { Poor: 0 }, ['Poor'])], false)
    expect(shapeFrequencyTable([none])[0].rows).toEqual([])
    expect(shapeFrequencyTable([withLabels])[0].rows[0].percent).toBeNull()
  })
})

const LENS = { blind: false, self: null, machineCoderIds: new Set<number>() as ReadonlySet<number> }
const theme = (config: Record<string, unknown>) =>
  [{ id: 1, content: { type: 'doc', content: [{ type: 'chart-embed', attrs: { materialId: 1, config: JSON.stringify(config) } }] } } as unknown as CanvasTheme]
const mdRows = (md: string) => md.split('\n').slice(2).map(l => l.split('|').slice(1, -1).map(c => c.trim()))

describe('#1412 — the Canvas export table', () => {
  beforeEach(() => vi.mocked(metricsApi.quickCompute).mockReset())

  it('a grouped distribution: the empty group reads "—" and why, a real 0 reads 0%', async () => {
    vi.mocked(metricsApi.quickCompute).mockResolvedValue({ metrics: [q1] } as never)
    const t = await fetchChartTables(theme({ column_ids: [1], metric_type: 'frequency_distribution', chart_type: 'heatmap', grouping_column_id: 4 }), 3, LENS)
    const rows = mdRows(t.get(1)!.md)
    const c = rows.find(r => r[0].endsWith('(C)'))!
    expect(c.slice(1, 4).every(x => x.startsWith('—') && x.includes('Not computable'))).toBe(true)
    expect(c[4]).toBe('0')
    expect(rows.find(r => r[0].endsWith('(A)'))![2]).toBe('0%')
    // the .docx renders this same table
    expect(t.get(1)!.table!.rows.find(r => r[0].endsWith('(C)'))![1]).toMatch(/^—/)
  })

  it('one distribution nobody answered: "—" per option, its counts real', async () => {
    vi.mocked(metricsApi.quickCompute).mockResolvedValue({ metrics: [allna] } as never)
    const t = await fetchChartTables(theme({ column_ids: [3], metric_type: 'frequency_distribution', chart_type: 'horizontal_bar' }), 3, LENS)
    const rows = mdRows(t.get(1)!.md)
    expect(rows.map(r => r[1].slice(0, 1))).toEqual(['—', '—', '—'])
    expect(rows.map(r => r[2])).toEqual(['0', '0', '0'])
  })
})
