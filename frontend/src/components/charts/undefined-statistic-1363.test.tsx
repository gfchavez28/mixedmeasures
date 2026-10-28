/**
 * #1363 — what a chart DRAWS for a statistic the server could not compute.
 *
 * Each case feeds the chart from its real shaper (`chart-data.ts`), so it tests
 * the path a researcher's data takes, and pairs the undefined result with a REAL
 * zero, which must still read as 0.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'

vi.mock('@/lib/theme-context', async (orig) => {
  const { CHART_COLORS } = await import('@/lib/chart-data')
  return { ...(await orig<typeof import('@/lib/theme-context')>()), useChartColors: () => CHART_COLORS }
})
vi.mock('recharts', async (orig) => {
  const { withSizedResponsiveContainer } = await import('@/test-support/recharts-render')
  return withSizedResponsiveContainer(await orig<typeof import('recharts')>())
})

import HorizontalBarChart from './HorizontalBarChart'
import DumbbellChart from './DumbbellChart'
import LineChartComponent from './LineChart'
import GroupedScalarBarChart from './GroupedScalarBarChart'
import VerticalBarChart from './VerticalBarChart'
import { stubChartGlobals } from '@/test-support/recharts-render'
import { shapeScalarBars, shapeDumbbellRows, shapeLineChart, shapeGroupedScalarBars } from '@/lib/chart-data'
import type { MetricDefinitionResponse } from '@/lib/api'

beforeEach(stubChartGlobals)
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const metric = (id: number, type: string, results: unknown[]) =>
  ({ id, name: `Q${id}`, metric_type: type, input_source_id: id, input_source_type: 'dataset_column', results } as unknown as MetricDefinitionResponse)

describe('#1363 — HorizontalBarChart', () => {
  it('marks the undefined row with "—" and the reason; a real 0% row is not marked', () => {
    const data = shapeScalarBars([
      metric(1, 'proportion', [{ group_value: null, valid_n: 0, result_data: { percentage: null } }]),
      metric(2, 'proportion', [{ group_value: null, valid_n: 40, result_data: { percentage: 0 } }]),
      metric(3, 'proportion', [{ group_value: null, valid_n: 40, result_data: { percentage: 50 } }]),
    ])
    const { container } = render(
      <HorizontalBarChart data={data} metricType="proportion" fixedDimensions={{ width: 800, height: 400 }} isAnimationActive={false} />,
    )
    const marks = container.querySelectorAll('[data-undefined-statistic]')
    expect(marks).toHaveLength(1)
    expect(marks[0].textContent).toBe('—')
    const titles = Array.from(container.querySelectorAll('title')).map(t => t.textContent)
    expect(titles).toContain('Q1: Not computable for this data.')
    expect(titles).toContain('Q2')
  })
})

describe('#1363 — DumbbellChart', () => {
  it('draws no dot at 0 for an empty group, and names it with the reason', () => {
    const data = shapeDumbbellRows([
      metric(1, 'proportion', [
        { group_value: 'A', valid_n: 0, result_data: { percentage: null } },
        { group_value: 'B', valid_n: 9, result_data: { percentage: 0 } },
        { group_value: 'C', valid_n: 9, result_data: { percentage: 40 } },
      ]),
    ])
    const { container } = render(<DumbbellChart data={data} metricType="proportion" />)
    const titles = Array.from(container.querySelectorAll('title')).map(t => t.textContent ?? '')
    // HEAD: "A: 0.0%, n = 0" — a measured zero, in the dot's own accessible text
    expect(titles.some(t => t.startsWith('A: 0.0'))).toBe(false)
    expect(titles).toContain('A: Not computable for this data., n = 0')
    // the real zero keeps its dot and its number
    expect(titles).toContain('B: 0.0%, n = 9')
  })
})

const groupedMeans = () => shapeGroupedScalarBars([
  metric(1, 'mean', [
    { group_value: 'A', valid_n: 0, result_data: { mean: null } },
    { group_value: 'B', valid_n: 5, result_data: { mean: 0 } },
    { group_value: 'C', valid_n: 5, result_data: { mean: 4 } },
  ]),
], ['A', 'B', 'C'])

describe('#1363 — the grouped bar charts name the empty group', () => {
  it('GroupedScalarBarChart: "A —" with the reason, and nothing for the real-zero B', () => {
    const { container } = render(<GroupedScalarBarChart sections={groupedMeans()} groupValues={['A', 'B', 'C']} metricType="mean" />)
    const marks = container.querySelectorAll('[data-undefined-statistic]')
    expect(marks).toHaveLength(1)
    expect(marks[0].getAttribute('title')).toBe('A: Not computable for this data.')
    expect(marks[0].textContent).not.toContain('B')
  })

  it('VerticalBarChart (grouped): the tick names "A —" and the reason', () => {
    const { container } = render(<VerticalBarChart groupedScalarData={groupedMeans()} groupValues={['A', 'B', 'C']} metricType="mean" />)
    const marks = container.querySelectorAll('[data-undefined-statistic]')
    expect(marks).toHaveLength(1)
    expect(marks[0].textContent).toBe('A —')
  })

  it('VerticalBarChart (scalar): the undefined row is marked, the real-zero row is not', () => {
    const data = shapeScalarBars([
      metric(1, 'mean', [{ group_value: null, valid_n: 0, result_data: { mean: null } }]),
      metric(2, 'mean', [{ group_value: null, valid_n: 3, result_data: { mean: 0 } }]),
    ])
    const { container } = render(<VerticalBarChart scalarData={data} metricType="mean" />)
    expect(container.querySelectorAll('[data-undefined-statistic]')).toHaveLength(1)
    const titles = Array.from(container.querySelectorAll('title')).map(t => t.textContent)
    expect(titles).toContain('Q1: Not computable for this data.')
  })
})

describe('#1363 — LineChart', () => {
  it("the sr-only table says '—' and why for an undefined point; a real 0 reads 0.0", () => {
    const data = shapeLineChart([
      metric(1, 'mean', [{ group_value: null, valid_n: 0, result_data: { mean: null } }]),
      metric(2, 'mean', [{ group_value: null, valid_n: 3, result_data: { mean: 0 } }]),
    ])
    const { container } = render(<LineChartComponent data={data} metricType="mean" />)
    const cells = Array.from(container.querySelectorAll('table.sr-only tbody td')).map(td => td.textContent)
    expect(cells).toEqual(['Q1', '— Not computable for this data.', 'Q2', '0.0'])
  })

  // Found by the Batch 10 live drive: recharts hands the dot renderer `cy = null`
  // for a null value, React drops the attribute, and a circle drew at the SVG's top
  // edge — read as a value above the scale. The other shapes built `NaN` points.
  it('draws no dot for an undefined point, in any shape; the defined points keep theirs', () => {
    const ungrouped = shapeLineChart([
      metric(1, 'mean', [{ group_value: null, valid_n: 0, result_data: { mean: null } }]),
      metric(2, 'mean', [{ group_value: null, valid_n: 3, result_data: { mean: 0 } }]),
      metric(3, 'mean', [{ group_value: null, valid_n: 3, result_data: { mean: 2 } }]),
    ])
    const one = render(<LineChartComponent data={ungrouped} metricType="mean" />)
    const circles = Array.from(one.container.querySelectorAll('svg circle'))
    expect(circles).toHaveLength(2)
    expect(circles.every(c => Number.isFinite(Number(c.getAttribute('cy'))) && c.hasAttribute('cy'))).toBe(true)
    cleanup()

    // Four groups, so all four shapes (circle · square · diamond · triangle) draw.
    const groups = ['A', 'B', 'C', 'D']
    const grouped = shapeLineChart([
      metric(1, 'mean', groups.map(g => ({ group_value: g, valid_n: 0, result_data: { mean: null } }))),
      metric(2, 'mean', groups.map((g, i) => ({ group_value: g, valid_n: 3, result_data: { mean: i } }))),
    ])
    const four = render(<LineChartComponent data={grouped} metricType="mean" />)
    const svg = four.container.querySelector('svg.recharts-surface')!
    const polygons = Array.from(svg.querySelectorAll('polygon'))
    expect(polygons.length).toBeGreaterThan(0)
    expect(polygons.every(p => !/NaN|undefined|null/.test(p.getAttribute('points') ?? ''))).toBe(true)
    expect(Array.from(svg.querySelectorAll('rect')).every(r => !/NaN/.test(r.getAttribute('y') ?? ''))).toBe(true)
  })
})
