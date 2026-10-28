/**
 * #1408 — what `VerticalBarChart` calls itself.
 *
 * The same component draws a histogram (`histogram`, #522) and a bar chart, and
 * both were captioned *"Vertical bar chart"* — measured in Chrome's tree on the
 * Canvas and in the Analysis view (run 14). The caption is the figure's
 * accessible name (`ChartFigure`, #698), so it must say which chart it is.
 *
 * ⚠️ jsdom computes no name from a `<figcaption>`, so this reads the caption
 * itself, as `ChartFigure.test.tsx` does; Chrome's tree is the name sweep's.
 *
 * #1455 — the grouped frequency arm draws its x-axis from the first group's
 * bars, so it drew only that group's categories; the shaper now hands every
 * group the union, and this reads the categories the chart actually DREW.
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

import VerticalBarChart from './VerticalBarChart'
import { stubChartGlobals } from '@/test-support/recharts-render'
import { shapeFrequencyBarFigure, type BarDatum } from '@/lib/chart-data'
import type { MetricDefinitionResponse } from '@/lib/api'

beforeEach(stubChartGlobals)
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const BINS: BarDatum[] = [
  { label: '0–50', value: 60, count: 3, n: 5 },
  { label: '50–100', value: 40, count: 2, n: 5 },
]

const caption = (container: HTMLElement) =>
  container.querySelector('figure > figcaption')?.textContent

describe('#1408 — the caption names the chart it draws', () => {
  it('histogram mode: "Histogram, 2 bins"', () => {
    const { container } = render(<VerticalBarChart frequencyData={BINS} histogram />)
    expect(caption(container)).toBe('Histogram, 2 bins')
  })

  it('control: the same data as a frequency bar chart keeps "Vertical bar chart"', () => {
    const { container } = render(<VerticalBarChart frequencyData={BINS} />)
    expect(caption(container)).toBe('Vertical bar chart')
  })

  it('control: the scalar branch keeps "Vertical bar chart"', () => {
    const { container } = render(<VerticalBarChart scalarData={[{ label: 'Q1', value: 3, n: 5 }]} metricType="mean" />)
    expect(caption(container)).toBe('Vertical bar chart')
  })
})

describe('#1455 — a grouped frequency chart draws every category any group gave', () => {
  /** The re-check's fixture: A answered 3 and 6, B answered 4 and 6 (no value labels). */
  const grouped = () => {
    const freq = (gv: string, a: string, b: string) => ({
      group_value: gv, valid_n: 2,
      result_data: { scale_order: [a, b], counts: { [a]: 1, [b]: 1 }, percentages: { [a]: 50, [b]: 50 } },
    })
    const fig = shapeFrequencyBarFigure([
      { id: 1, name: 'score', metric_type: 'frequency_distribution', results: [freq('A', '3', '6'), freq('B', '4', '6')] },
    ] as unknown as MetricDefinitionResponse[])
    if (fig.kind !== 'grouped') throw new Error('expected a grouped figure')
    return fig
  }

  /** The x-axis categories drawn, by each tick's full-label `<title>`. */
  const xCategories = (container: HTMLElement) =>
    [...container.querySelectorAll('.recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-label title')].map(t => t.textContent)

  it('draws 3, 4 and 6 — B’s "4" was never drawn', () => {
    const fig = grouped()
    const { container } = render(<VerticalBarChart groupedFrequencyData={fig.section} groupValues={fig.groupValues} />)
    expect(xCategories(container)).toEqual(['3', '4', '6'])
  })
})
