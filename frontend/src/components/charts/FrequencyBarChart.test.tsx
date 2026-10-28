/**
 * #1314 — a frequency bar's data label states ITS OWN category's value.
 *
 * recharts drops a zero-width bar before it draws labels, and numbers the labels it does
 * draw from what survived, so a renderer that indexed the chart's rows by that number
 * printed the PREVIOUS category's value on every bar after an empty one — the review's run:
 * 0 / 4 / 6 / 7 / 3 of 20 labelled 0.0%, 20.0%, 30.0%, 35.0% where the bars were 20, 30, 35
 * and 15. Each assertion reads the label drawn on a category's BAND (see
 * `test-support/recharts-render.ts`), so it fails whenever the text and the bar disagree.
 *
 * An empty category draws no label at all (recharts draws none for a bar it did not draw);
 * the Frequency Table states the zero.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import type { MetricDefinitionResponse } from '@/lib/api'

vi.mock('recharts', async (orig) => {
  const { withSizedResponsiveContainer } = await import('@/test-support/recharts-render')
  return withSizedResponsiveContainer(await orig<typeof import('recharts')>())
})
vi.mock('@/lib/theme-context', async (orig) => {
  const { CHART_COLORS } = await import('@/lib/chart-data')
  return { ...(await orig<typeof import('@/lib/theme-context')>()), useChartColors: () => CHART_COLORS }
})

import FrequencyBarChart from './FrequencyBarChart'
import { dataLabelsByCategory, stubChartGlobals } from '@/test-support/recharts-render'

beforeEach(stubChartGlobals)
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const SCALE = ['Strongly disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly agree']

function likertItem(counts: number[]): MetricDefinitionResponse {
  const n = counts.reduce((a, b) => a + b, 0)
  const byLabel = (vals: number[]) => Object.fromEntries(SCALE.map((l, i) => [l, vals[i]]))
  return {
    id: 1,
    name: 'Q1',
    input_source_label: 'Q1 The sessions were useful',
    origin_context: null,
    metric_type: 'frequency_distribution',
    results: [{
      id: 1, group_value: null, valid_n: n, total_n: n, computed_at: '2026-10-21T00:00:00Z',
      result_data: { scale_order: SCALE, counts: byLabel(counts), percentages: byLabel(counts.map(c => (c / n) * 100)) },
    }],
  } as unknown as MetricDefinitionResponse
}

const labels = (counts: number[], display: 'count' | 'percentage') => {
  const { container } = render(<FrequencyBarChart metrics={[likertItem(counts)]} display={display} />)
  return Object.fromEntries(dataLabelsByCategory(container))
}

describe('FrequencyBarChart data labels (#1314)', () => {
  it('a LEADING empty category — percentages (the review\'s 20-response item)', () => {
    expect(labels([0, 4, 6, 7, 3], 'percentage')).toEqual({
      'Strongly disagree': [],
      Disagree: ['20.0%'],
      Neutral: ['30.0%'],
      Agree: ['35.0%'],
      'Strongly agree': ['15.0%'],
    })
  })

  it('an INTERIOR empty category — percentages', () => {
    expect(labels([4, 0, 6, 7, 3], 'percentage')).toEqual({
      'Strongly disagree': ['20.0%'],
      Disagree: [],
      Neutral: ['30.0%'],
      Agree: ['35.0%'],
      'Strongly agree': ['15.0%'],
    })
  })

  it('a LEADING empty category — counts', () => {
    expect(labels([0, 4, 6, 7, 3], 'count')).toEqual({
      'Strongly disagree': [],
      Disagree: ['4'],
      Neutral: ['6'],
      Agree: ['7'],
      'Strongly agree': ['3'],
    })
  })

  it('an INTERIOR empty category — counts', () => {
    expect(labels([4, 0, 6, 7, 3], 'count')).toEqual({
      'Strongly disagree': ['4'],
      Disagree: [],
      Neutral: ['6'],
      Agree: ['7'],
      'Strongly agree': ['3'],
    })
  })

  it('no empty category — every bar keeps its label (the harness draws labels at all)', () => {
    expect(labels([2, 4, 6, 5, 3], 'count')).toEqual({
      'Strongly disagree': ['2'],
      Disagree: ['4'],
      Neutral: ['6'],
      Agree: ['5'],
      'Strongly agree': ['3'],
    })
  })
})
