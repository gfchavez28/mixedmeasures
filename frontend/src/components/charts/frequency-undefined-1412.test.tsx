/**
 * #1412 — what a frequency figure DRAWS and PRINTS for a group nobody answered.
 *
 * Each case feeds the chart from its real shaper (`chart-data.ts`) with the wire
 * `compute_metric` sends (see `lib/chart-frequency-undefined-1412.test.ts`), and
 * pairs the empty group C with group A's REAL 0% ("Fair"), which must still read 0.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'

vi.mock('@/lib/theme-context', async (orig) => {
  const { CHART_COLORS } = await import('@/lib/chart-data')
  return {
    ...(await orig<typeof import('@/lib/theme-context')>()),
    useChartColors: () => CHART_COLORS,
    useTheme: () => ({ isDark: false }),
  }
})
// The tooltip is forced open on category 1 ("Fair") — the one place a bar chart
// PRINTS a group's share: recharts draws no bar and no label for a 0 OR a null,
// so the drawn figure alone cannot tell C's undefined share from A's real 0.
vi.mock('recharts', async (orig) => {
  const { withSizedResponsiveContainer } = await import('@/test-support/recharts-render')
  const { createElement } = await import('react')
  const actual = await orig<typeof import('recharts')>()
  const Tip = actual.Tooltip as unknown as Parameters<typeof createElement>[0]
  const open = (p: object) => ({ ...p, defaultIndex: 1, active: true }) as object
  return { ...withSizedResponsiveContainer(actual), Tooltip: (p: object) => createElement(Tip, open(p)) }
})

import FrequencyBarChart from './FrequencyBarChart'
import VerticalBarChart from './VerticalBarChart'
import HeatmapTable from './HeatmapTable'
import DetailedFrequencyTable from './DetailedFrequencyTable'
import StackedHorizontalBarChart from './StackedHorizontalBarChart'
import { stubChartGlobals } from '@/test-support/recharts-render'
import { shapeFrequencyBarFigure, shapeHeatmapRows, shapeStackedBars } from '@/lib/chart-data'
import type { MetricDefinitionResponse } from '@/lib/api'

beforeEach(stubChartGlobals)
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const res = (group_value: string | null, valid_n: number, total_n: number, percentages: Record<string, number | null>, counts: Record<string, number>, scale_order: string[]) =>
  ({ id: 0, group_value, valid_n, total_n, computed_at: '', result_data: { percentages, counts, scale_order } })
const metric = (id: number, name: string, results: ReturnType<typeof res>[], grouped = true) =>
  ({ id, name, metric_type: 'frequency_distribution', input_source_id: id, input_source_type: 'dataset_column',
    grouping_column_id: grouped ? 4 : null, results } as unknown as MetricDefinitionResponse)
const L = ['Poor', 'Fair', 'Good']
const q1 = metric(1, 'q1', [
  res('A', 2, 2, { Poor: 50, Fair: 0, Good: 50 }, { Poor: 1, Fair: 0, Good: 1 }, L),
  res('B', 2, 2, { Poor: 0, Fair: 100, Good: 0 }, { Poor: 0, Fair: 2, Good: 0 }, L),
  res('C', 0, 2, { Poor: null, Fair: null, Good: null }, { Poor: 0, Fair: 0, Good: 0 }, L),
])
const allnaUndeclared = metric(3, 'allna', [res(null, 0, 7, {}, {}, [])], false)
const allnaDeclared = metric(5, 'allna2', [res(null, 0, 7, { Poor: null, Fair: null, Good: null }, { Poor: 0, Fair: 0, Good: 0 }, L)], false)

const texts = (c: HTMLElement, sel: string) => Array.from(c.querySelectorAll(sel)).map(e => e.textContent ?? '')
const NOTE = 'C — Not computable for this data.'

describe('#1412 — FrequencyBarChart (horizontal)', () => {
  it('grouped: C is named once with the reason and never reads 0 (0.0%); A\'s real 0 still does', () => {
    const { container } = render(<FrequencyBarChart metrics={[q1]} />)
    expect(texts(container, '[data-undefined-statistic]')).toEqual([NOTE])
    const tip = container.querySelector('.recharts-tooltip-wrapper')!.textContent ?? ''
    expect(tip).toMatch(/A:\s*0\s*\(0\.0%\)/) // positive control: the tooltip is open on "Fair"
    expect(tip).not.toMatch(/C:\s*0\s*\(0\.0%\)/) // HEAD: "C: 0 (0.0%) n=0"
  })

  it('ungrouped: a variable nobody answered no longer VANISHES — it is named and marked', () => {
    const { container } = render(<FrequencyBarChart metrics={[allnaUndeclared]} />)
    expect(container.textContent).toContain('allna')
    expect(texts(container, '[data-undefined-statistic]')).toEqual(['— Not computable for this data.'])
  })

  it('ungrouped, declared: no "0.0%" per option', () => {
    const { container } = render(<FrequencyBarChart metrics={[allnaDeclared]} />)
    expect(texts(container, 'text').filter(t => t === '0.0%')).toHaveLength(0)
    expect(container.querySelectorAll('[data-undefined-statistic]')).toHaveLength(1)
  })

  it('count display: the counts are real 0s and no mark is printed', () => {
    const { container } = render(<FrequencyBarChart metrics={[q1]} display="count" />)
    expect(container.querySelectorAll('[data-undefined-statistic]')).toHaveLength(0)
  })
})

describe('#1412 — VerticalBarChart (grouped frequency)', () => {
  it('names C once with the reason', () => {
    const fig = shapeFrequencyBarFigure([q1])
    if (fig.kind !== 'grouped') throw new Error('grouped expected')
    const { container } = render(<VerticalBarChart groupedFrequencyData={fig.section} groupValues={fig.groupValues} />)
    expect(texts(container, '[data-undefined-statistic]')).toEqual([NOTE])
    const tip = container.querySelector('.recharts-tooltip-wrapper')!.textContent ?? ''
    expect(tip).toMatch(/A:\s*0\.0/) // positive control
    expect(tip).not.toMatch(/C:\s*0\.0/) // HEAD: "C: 0.0 (n=0)"
  })
})

describe('#1412 — HeatmapTable', () => {
  it('C\'s cells read "—" with the reason in the title; A\'s real 0 reads 0.0%', () => {
    const { container } = render(<HeatmapTable data={shapeHeatmapRows([q1])} />)
    const rows = Array.from(container.querySelectorAll('tbody tr'))
    const c = rows.find(r => r.querySelector('th')!.textContent!.includes('C'))!
    const cells = Array.from(c.querySelectorAll('td'))
    expect(cells.map(td => td.textContent)).toEqual(['—', '—', '—'])
    expect(cells[0].getAttribute('title')).toBe('— Not computable for this data. (n=0)')
    const a = rows.find(r => r.querySelector('th')!.textContent!.includes('A'))!
    expect(a.querySelectorAll('td')[1].textContent).toBe('0.0%')
  })
})

describe('#1412 — DetailedFrequencyTable', () => {
  it('C\'s Valid % and its totals are "—", its Percent of 2 records a real 0.0%', () => {
    const { container } = render(<DetailedFrequencyTable metrics={[q1]} />)
    const tables = Array.from(container.querySelectorAll('table'))
    const c = tables[2]
    const body = Array.from(c.querySelectorAll('tbody tr')).map(tr => Array.from(tr.querySelectorAll('td')).map(td => td.textContent))
    expect(body.map(r => r[2])).toEqual(['—', '—', '—']) // Valid %
    expect(body.map(r => r[4])).toEqual(['—', '—', '—']) // Cum. %
    expect(body.map(r => r[1])).toEqual(['0.0%', '0.0%', '0.0%']) // Percent — real
    const foot = Array.from(c.querySelectorAll('tfoot tr')[0].querySelectorAll('td')).map(td => td.textContent)
    expect(foot[2]).toBe('—') // HEAD: "100.0%" valid of zero valid
    expect(c.querySelector('caption [data-undefined-statistic]')!.textContent).toBe('Valid %: — Not computable for this data.')
    const a = tables[0]
    expect(Array.from(a.querySelectorAll('tbody tr'))[1].querySelectorAll('td')[2].textContent).toBe('0.0%')
  })
})

describe('#1412 — StackedHorizontalBarChart', () => {
  it('marks C\'s row "—" with the reason in its tick title, in the 100% mode only', () => {
    const data = shapeStackedBars([q1])
    const { container } = render(<StackedHorizontalBarChart data={data} mode="100%" />)
    expect(texts(container, '[data-undefined-statistic]')).toEqual(['—'])
    expect(texts(container, 'title').some(t => t.endsWith(': Not computable for this data.') && t.includes('C'))).toBe(true)
    cleanup()
    const counted = render(<StackedHorizontalBarChart data={data} mode="count" />)
    expect(counted.container.querySelectorAll('[data-undefined-statistic]')).toHaveLength(0)
  })
})
