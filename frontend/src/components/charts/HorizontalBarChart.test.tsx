/**
 * #1314 — a horizontal bar's data label, and its `(n=…)`, state ITS OWN row.
 *
 * Horizontal Bar is the default chart for a single Likert item, and a small sample often
 * leaves an end category empty. recharts drops the zero-width bar before it draws labels and
 * numbers the survivors, so a renderer that indexed the rows by that number printed the
 * previous row's value — and its n — on every bar after the empty one. Each assertion reads
 * the label drawn on a row's BAND (see `test-support/recharts-render.ts`).
 *
 * An empty row draws no label, and so no `(n=…)` either: recharts draws no label for a bar it
 * did not draw. The tooltip still states it.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'

vi.mock('@/lib/theme-context', async (orig) => {
  const { CHART_COLORS } = await import('@/lib/chart-data')
  return { ...(await orig<typeof import('@/lib/theme-context')>()), useChartColors: () => CHART_COLORS }
})

import HorizontalBarChart from './HorizontalBarChart'
import { dataLabelsByCategory, stubChartGlobals } from '@/test-support/recharts-render'
import type { BarDatum } from '@/lib/chart-data'

beforeEach(stubChartGlobals)
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const SCALE = ['Strongly disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly agree']

/** One Likert item's frequency bars, as `shapeFrequencyBars` hands them over: value = percentage. */
const likertBars = (counts: number[]): BarDatum[] => {
  const n = counts.reduce((a, b) => a + b, 0)
  return SCALE.map((label, i) => ({ label, value: (counts[i] / n) * 100, count: counts[i], percentage: (counts[i] / n) * 100, n }))
}

const drawn = (data: BarDatum[], props: { showVariableN?: 'off' | 'all' } = {}) => {
  const { container } = render(
    <HorizontalBarChart data={data} fixedDimensions={{ width: 800, height: 400 }} isAnimationActive={false} {...props} />,
  )
  return Object.fromEntries(dataLabelsByCategory(container))
}

describe('HorizontalBarChart data labels (#1314)', () => {
  it('a LEADING empty category on a Likert item', () => {
    expect(drawn(likertBars([0, 4, 6, 7, 3]))).toEqual({
      'Strongly disagree': [],
      Disagree: ['20.0%'],
      Neutral: ['30.0%'],
      Agree: ['35.0%'],
      'Strongly agree': ['15.0%'],
    })
  })

  it('an INTERIOR empty category on a Likert item', () => {
    expect(drawn(likertBars([4, 6, 0, 7, 3]))).toEqual({
      'Strongly disagree': ['20.0%'],
      Disagree: ['30.0%'],
      Neutral: [],
      Agree: ['35.0%'],
      'Strongly agree': ['15.0%'],
    })
  })

  it("the (n=…) beside each bar is that row's n, after an empty row", () => {
    const rows: BarDatum[] = [
      { label: 'Q1 Attended', value: 40, n: 25 },
      { label: 'Q2 Referred', value: 0, n: 12 },
      { label: 'Q3 Returned', value: 25, n: 30 },
      { label: 'Q4 Enrolled', value: 60, n: 18 },
    ]
    expect(drawn(rows, { showVariableN: 'all' })).toEqual({
      'Q1 Attended': ['40.0%', '(n=25)'],
      'Q2 Referred': [],
      'Q3 Returned': ['25.0%', '(n=30)'],
      'Q4 Enrolled': ['60.0%', '(n=18)'],
    })
  })

  it('no empty row — every bar keeps its label (the harness draws labels at all)', () => {
    expect(drawn(likertBars([2, 4, 6, 5, 3]))).toEqual({
      'Strongly disagree': ['10.0%'],
      Disagree: ['20.0%'],
      Neutral: ['30.0%'],
      Agree: ['25.0%'],
      'Strongly agree': ['15.0%'],
    })
  })
})
