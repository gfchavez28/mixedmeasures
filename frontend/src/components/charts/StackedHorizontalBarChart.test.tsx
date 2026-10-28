/**
 * #1314 — a stacked or diverging segment's label states ITS OWN row's value.
 *
 * Each response category is its own `<Bar>` series, and recharts drops a series' zero-width
 * segment before it draws that series' labels, numbering the survivors. A renderer that
 * indexed the rows by that number read the wrong row after any row whose segment was empty.
 * 🔴 **Grouped charts shifted with NO empty segment at all:** the gap between groups is a
 * separator ROW whose every segment is zero, so every row after the first group boundary
 * was labelled with the row above it (or with nothing, where that row was the separator).
 * Each assertion reads the labels drawn on a row's BAND (see `test-support/recharts-render.ts`).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import type { ReactElement } from 'react'

vi.mock('recharts', async (orig) => {
  const { withSizedResponsiveContainer } = await import('@/test-support/recharts-render')
  return withSizedResponsiveContainer(await orig<typeof import('recharts')>())
})
vi.mock('@/lib/theme-context', async (orig) => {
  const { CHART_COLORS } = await import('@/lib/chart-data')
  return { ...(await orig<typeof import('@/lib/theme-context')>()), useChartColors: () => CHART_COLORS }
})

import StackedHorizontalBarChart from './StackedHorizontalBarChart'
import { dataLabelsByCategory, stubChartGlobals } from '@/test-support/recharts-render'
import { shapeDivergingStackedBars } from '@/lib/chart-data'
import type { StackedBarData, StackedBarRow } from '@/lib/chart-data'

beforeEach(stubChartGlobals)
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const N = 20

function stacked(responses: string[], rows: [string, number[], Partial<StackedBarRow>?][]): StackedBarData {
  return {
    responseLabels: responses,
    colors: Object.fromEntries(responses.map((r, i) => [r, ['#1d4ed8', '#0f766e', '#7c3aed', '#b45309', '#be123c'][i]])),
    rows: rows.map(([label, pcts, extra], i) => ({
      label,
      fullLabel: label,
      metricId: i + 1,
      totalN: N,
      segments: responses.map((r, j) => ({ label: r, count: (pcts[j] * N) / 100, percentage: pcts[j] })),
      ...extra,
    })),
  }
}

const drawn = (el: ReactElement) => Object.fromEntries(dataLabelsByCategory(render(el).container))
const pct = (...v: number[]) => v.map(x => `${x.toFixed(1)}%`)

const FREQ = ['Never', 'Sometimes', 'Often', 'Always']
const LIKERT = ['Strongly disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly agree']

/**
 * A row of a variable-first grouped chart, as `shapeStackedBars` builds it — the chart puts a
 * separator row after each `isGroupEnd` but the last.
 */
const grouped = (metricLabel: string, groupLabel: string, isGroupEnd: boolean): Partial<StackedBarRow> =>
  ({ metricLabel, groupLabel, isGroupEnd })

describe('StackedHorizontalBarChart — stacked segments (#1314)', () => {
  const withZeros = stacked(FREQ, [
    ['Q1 Read', [0, 20, 30, 50]],       // a LEADING row's empty segment for "Never"
    ['Q2 Wrote', [40, 0, 25, 35]],      // an INTERIOR row's empty segment for "Sometimes"
    ['Q3 Listened', [15, 45, 0, 40]],
    ['Q4 Spoke', [25, 25, 25, 25]],
  ])

  it('100% mode: each segment after an empty one keeps its own row', () => {
    expect(drawn(<StackedHorizontalBarChart data={withZeros} mode="100%" />)).toEqual({
      'Q1 Read': pct(20, 30, 50),
      'Q2 Wrote': pct(40, 25, 35),
      'Q3 Listened': pct(15, 45, 40),
      'Q4 Spoke': pct(25, 25, 25, 25),
    })
  })

  it('count mode: the same, in counts', () => {
    expect(drawn(<StackedHorizontalBarChart data={withZeros} mode="count" />)).toEqual({
      'Q1 Read': ['4', '6', '10'],
      'Q2 Wrote': ['8', '5', '7'],
      'Q3 Listened': ['3', '9', '8'],
      'Q4 Spoke': ['5', '5', '5', '5'],
    })
  })

  it('a GROUPED chart with no empty segment at all — the separator row shifted every later row', () => {
    const data = stacked(FREQ, [
      ['Q1 Read (Men)', [10, 20, 30, 40], grouped('Q1 Read', 'Men', false)],
      ['Q1 Read (Women)', [20, 30, 40, 10], grouped('Q1 Read', 'Women', true)],
      ['Q2 Wrote (Men)', [30, 40, 10, 20], grouped('Q2 Wrote', 'Men', false)],
      ['Q2 Wrote (Women)', [40, 10, 20, 30], grouped('Q2 Wrote', 'Women', true)],
    ])
    expect(drawn(<StackedHorizontalBarChart data={data} mode="100%" />)).toEqual({
      'Q1 Read (Men)': pct(10, 20, 30, 40),
      'Q1 Read (Women)': pct(20, 30, 40, 10),
      'Q2 Wrote (Men)': pct(30, 40, 10, 20),
      'Q2 Wrote (Women)': pct(40, 10, 20, 30),
    })
  })
})

describe('StackedHorizontalBarChart — diverging (#1314)', () => {
  it('an empty OUTER segment does not shift the rows after it', () => {
    const data = shapeDivergingStackedBars(stacked(LIKERT, [
      ['Q1 Useful', [0, 20, 20, 30, 30]],
      ['Q2 Clear', [25, 15, 20, 15, 25]],
      ['Q3 Paced', [15, 25, 20, 20, 20]],
    ]), 'Neutral', 'center', false)
    // Left to right as drawn: Strongly disagree … Strongly agree, Neutral labelled once.
    expect(drawn(<StackedHorizontalBarChart data={stacked(LIKERT, [])} mode="100%" divergingData={data} />)).toEqual({
      'Q1 Useful': pct(20, 20, 30, 30),
      'Q2 Clear': pct(25, 15, 20, 15, 25),
      'Q3 Paced': pct(15, 25, 20, 20, 20),
    })
  })

  it('a GROUPED diverging chart with no empty segment — the separator row shifted every later row', () => {
    const data = shapeDivergingStackedBars(stacked(LIKERT, [
      ['Q1 Useful (Men)', [10, 20, 20, 30, 20], grouped('Q1 Useful', 'Men', false)],
      ['Q1 Useful (Women)', [20, 30, 20, 15, 15], grouped('Q1 Useful', 'Women', true)],
      ['Q2 Clear (Men)', [15, 15, 30, 25, 15], grouped('Q2 Clear', 'Men', false)],
      ['Q2 Clear (Women)', [25, 15, 20, 15, 25], grouped('Q2 Clear', 'Women', true)],
    ]), 'Neutral', 'center', false)
    expect(drawn(<StackedHorizontalBarChart data={stacked(LIKERT, [])} mode="100%" divergingData={data} />)).toEqual({
      'Q1 Useful (Men)': pct(10, 20, 20, 30, 20),
      'Q1 Useful (Women)': pct(20, 30, 20, 15, 15),
      'Q2 Clear (Men)': pct(15, 15, 30, 25, 15),
      'Q2 Clear (Women)': pct(25, 15, 20, 15, 25),
    })
  })
})
