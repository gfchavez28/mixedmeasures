/**
 * #1406 — `AnalysisChartRenderer`'s bar, table and histogram arms, RENDERED.
 *
 * Its three bar arms used to decide "grouped?" inline (three copies of
 * `isGroupedMetrics` + hide + sort); #1406 routes them through
 * `shapeScalarBarFigure` / `shapeFrequencyBarFigure`, the functions the Canvas
 * embed and its export ask. No test rendered this component unmocked (both
 * AnalysisView tests mock it), so the refactor had no net. Its Summary Table
 * and Histogram were WRONG under group-by — DRIVEN at 3d1d7380: the table
 * printed `score n 1 mean 100.00` (the missing-group bucket, which NULL-first
 * ordering puts at `results[0]`) and the histogram drew one bar, `99`, at 100%.
 *
 * ⚠️ The chart components are MOCKED to record their props: the load-bearing
 * assertion is WHICH figure an arm chose and WHAT numbers it handed over, which
 * jsdom's zero-width recharts cannot show. Everything else is the real code.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, cleanup } from '@testing-library/react'
import type { ReactNode } from 'react'

const { seen, recorder } = vi.hoisted(() => {
  const seen: { name: string; props: Record<string, unknown> }[] = []
  const recorder = (name: string) => ({
    default: (props: Record<string, unknown>) => { seen.push({ name, props }); return null },
  })
  return { seen, recorder }
})
vi.mock('@/components/charts/HorizontalBarChart', () => recorder('HorizontalBarChart'))
vi.mock('@/components/charts/GroupedScalarBarChart', () => recorder('GroupedScalarBarChart'))
vi.mock('@/components/charts/VerticalBarChart', () => recorder('VerticalBarChart'))
vi.mock('@/components/charts/SummaryStatsTable', () => recorder('SummaryStatsTable'))
vi.mock('@/components/charts/ChartExportWrapper', () => ({
  default: (props: Record<string, unknown> & { children?: ReactNode }) => {
    seen.push({ name: 'ChartExportWrapper', props })
    return <>{props.children}</>
  },
}))

import AnalysisChartRenderer, { type AnalysisChartRendererProps } from './AnalysisChartRenderer'
import { DEFAULT_FORMATTING, type ChartType } from '@/lib/chart-data'
import type { MetricDefinitionResponse } from '@/lib/api'

const metric = (id: number, type: string, results: unknown[], grouped = true) =>
  ({ id, name: `Q${id}`, input_source_label: `score${id}`, metric_type: type, input_source_id: id, input_source_type: 'dataset_column', grouping_column_id: grouped ? 9 : null, results }) as unknown as MetricDefinitionResponse

/** The measured wire order: the missing-group bucket FIRST; C undefined, D a real 0. */
const groupedMean = () => metric(1, 'mean', [
  { group_value: null, valid_n: 1, result_data: { mean: 100, ci_method: 't' } },
  { group_value: 'A', valid_n: 3, result_data: { mean: 3, ci_method: 't' } },
  { group_value: 'B', valid_n: 3, result_data: { mean: 6, ci_method: 't' } },
  { group_value: 'C', valid_n: 0, result_data: { mean: null, ci_method: 't' } },
  { group_value: 'D', valid_n: 3, result_data: { mean: 0, ci_method: 't' } },
])
const ungroupedMean = () => metric(2, 'mean', [{ group_value: null, valid_n: 40, result_data: { mean: 0, ci_method: 't' } }], false)
const groupedFreq = () => metric(6, 'frequency_distribution', [
  { group_value: null, valid_n: 1, result_data: { scale_order: ['4'], counts: { 4: 1 }, percentages: { 4: 100 } } },
  { group_value: 'A', valid_n: 3, result_data: { scale_order: ['1'], counts: { 1: 3 }, percentages: { 1: 100 } } },
  { group_value: 'B', valid_n: 3, result_data: { scale_order: ['5'], counts: { 5: 3 }, percentages: { 5: 100 } } },
])
const ungroupedFreq = () => metric(7, 'frequency_distribution', [
  { group_value: null, valid_n: 4, result_data: { scale_order: ['1', '2'], counts: { 1: 1, 2: 3 }, percentages: { 1: 25, 2: 75 } } },
], false)
/** age by grp: 3 + 3 grouped records and 1 with no group (age 99). */
const groupedAge = () => metric(5, 'frequency_distribution', [
  { group_value: null, valid_n: 1, result_data: { counts: { 99: 1 } } },
  { group_value: 'A', valid_n: 3, result_data: { counts: { 20: 1, 22: 1, 24: 1 } } },
  { group_value: 'B', valid_n: 3, result_data: { counts: { 40: 1, 42: 1, 44: 1 } } },
])

function renderArm(chartType: ChartType, metrics: MetricDefinitionResponse[], over: Partial<AnalysisChartRendererProps> = {}) {
  const props: AnalysisChartRendererProps = {
    hasAnySelection: true, isComputing: false, qcError: null, hasResults: true, chartType,
    onComputeAll: () => {}, isComputeAllPending: false,
    orderedMetrics: metrics, selectedMetrics: metrics, colorMap: new Map(), activeLabelMap: undefined,
    chartTitle: '', chartSubtitle: '', chartFootnote: '',
    display: 'percentage', scaling: 'relative', showChartN: true, showGroupN: false, showVariableN: 'off', showCI: false,
    metricType: metrics[0].metric_type, sortOrder: 'none', axisTransform: 'linear',
    formatting: DEFAULT_FORMATTING,
    hiddenResponseOptions: [], scaleOrder: 'natural', hiddenGroupValues: [], groupOrganization: 'variable-first', responseLabels: [],
    divergingMode: false, divergingCenter: null, divergingCenterAuto: { centerLabel: null, mode: 'boundary' }, hasMixedScales: false,
    hasMixedTypes: false,
    showErrorBand: false, lineStyle: 'connected', lineOverlay: false,
    proportionMode: 'numeric', proportionOperator: '>=', proportionThreshold: 0, proportionValues: [],
    crossTabColumnId: null, crossTabDisplay: 'count', crossTabData: undefined,
    ...over,
  }
  render(<AnalysisChartRenderer {...props} />)
  return seen.filter(s => s.name !== 'ChartExportWrapper')
}

/** The (group, value, n) triples a grouped scalar section was handed. */
function groupsOf(sections: unknown): [string, number | null, number][] {
  const s = (sections as { groups: { groupValue: string; value: number | null; n: number }[] }[])[0]
  return s.groups.map(g => [g.groupValue, g.value, g.n])
}
const EXPECTED: [string, number | null, number][] = [['A', 3, 3], ['B', 6, 3], ['C', null, 0], ['D', 0, 3]]

beforeEach(() => { seen.length = 0 })
afterEach(cleanup)

describe('#1406 — the Analysis view’s scalar bar arms', () => {
  it('horizontal_bar, grouped: every group with its own number, never the bucket', () => {
    const [chart] = renderArm('horizontal_bar', [groupedMean()])
    expect(chart.name).toBe('GroupedScalarBarChart')
    expect(chart.props.groupValues).toEqual(['A', 'B', 'C', 'D'])
    expect(groupsOf(chart.props.sections)).toEqual(EXPECTED)
  })

  it('horizontal_bar, grouped: the hidden groups stay hidden and the chosen sort is kept', () => {
    const [chart] = renderArm('horizontal_bar', [groupedMean()], { hiddenGroupValues: ['A'], sortOrder: 'data_desc' })
    // B 6, D 0, then C (undefined sorts last)
    expect(chart.props.groupValues).toEqual(['B', 'D', 'C'])
  })

  it('horizontal_bar, ungrouped: one bar per variable, a real 0 kept', () => {
    const [chart] = renderArm('horizontal_bar', [ungroupedMean()])
    expect(chart.name).toBe('HorizontalBarChart')
    expect((chart.props.data as { value: number | null; n: number }[]).map(b => [b.value, b.n])).toEqual([[0, 40]])
  })

  it('vertical_bar, grouped: grouped scalar data in the vertical chart', () => {
    const [chart] = renderArm('vertical_bar', [groupedMean()])
    expect(chart.name).toBe('VerticalBarChart')
    expect(chart.props.scalarData).toBeUndefined()
    expect(chart.props.groupValues).toEqual(['A', 'B', 'C', 'D'])
    expect(groupsOf(chart.props.groupedScalarData)).toEqual(EXPECTED)
  })

  it('vertical_bar, ungrouped: scalar data', () => {
    const [chart] = renderArm('vertical_bar', [ungroupedMean()])
    expect(chart.props.groupedScalarData).toBeUndefined()
    expect((chart.props.scalarData as { value: number | null }[]).map(b => b.value)).toEqual([0])
  })
})

describe('#1406 — the Analysis view’s vertical frequency arm', () => {
  it('grouped: a section per group, the hidden ones left out', () => {
    const [chart] = renderArm('vertical_bar', [groupedFreq()], { hiddenGroupValues: ['B'] })
    expect(chart.props.frequencyData).toBeUndefined()
    expect(chart.props.groupValues).toEqual(['A'])
    expect((chart.props.groupedFrequencyData as { groups: { groupValue: string }[] }).groups.map(g => g.groupValue)).toEqual(['A'])
  })

  it('ungrouped: the distribution’s bars', () => {
    const [chart] = renderArm('vertical_bar', [ungroupedFreq()])
    expect(chart.props.groupedFrequencyData).toBeUndefined()
    expect((chart.props.frequencyData as { label: string; count: number }[]).map(b => [b.label, b.count])).toEqual([['1', 1], ['2', 3]])
  })
})

describe('#1406 — the Analysis view’s Summary Table and Histogram under group-by', () => {
  it('table: a row per group with its own n — the drive printed the bucket’s n 1, mean 100', () => {
    const [table] = renderArm('table', [groupedMean()])
    const rows = table.props.data as { groupValue: string; n: number; mean: number | null; label: string }[]
    expect(rows.map(r => [r.groupValue, r.mean, r.n])).toEqual(EXPECTED)
    expect(rows[0].label).toBe('score1 (A)')
  })

  it('table: the hidden groups stay hidden and the chosen sort is kept', () => {
    const [table] = renderArm('table', [groupedMean()], { hiddenGroupValues: ['D'], sortOrder: 'desc' })
    expect((table.props.data as { groupValue: string }[]).map(r => r.groupValue)).toEqual(['C', 'B', 'A'])
  })

  it('histogram: every group pooled (7 records, not the bucket’s 1), and the basis line says so', () => {
    const [chart] = renderArm('histogram', [groupedAge()])
    const bars = chart.props.frequencyData as { count: number }[]
    expect(bars.reduce((s, b) => s + b.count, 0)).toBe(7)
    const wrapper = seen.find(s => s.name === 'ChartExportWrapper')!
    expect(wrapper.props.footnote).toContain('All groups combined — a histogram shows one distribution.')
  })
})
