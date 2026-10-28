/**
 * #1314 — clicking a comparison bar opens the code the bar is drawn FOR.
 *
 * recharts drops a series' zero-width bar before it draws, and numbers the click callback's
 * `index` by what it drew. The handler read `chartData[index]`, so after any code a group
 * never used, clicking a bar in that group opened the code ABOVE it (measured by the
 * 2026-10-21 review: codes 102 and 103 opened 101 and 102). The handler reads the clicked
 * rectangle's own row now. Each assertion clicks the bar drawn in a code's BAND (see
 * `test-support/recharts-render.ts`) and expects that code.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'

vi.mock('recharts', async (orig) => {
  const { withSizedResponsiveContainer } = await import('@/test-support/recharts-render')
  return withSizedResponsiveContainer(await orig<typeof import('recharts')>())
})
vi.mock('@/lib/theme-context', async (orig) => {
  const { CHART_COLORS } = await import('@/lib/chart-data')
  return { ...(await orig<typeof import('@/lib/theme-context')>()), useChartColors: () => CHART_COLORS }
})

import QualComparisonBar from './QualComparisonBar'
import { seriesBarRects, stubChartGlobals } from '@/test-support/recharts-render'
import type { DemographicComparisonResponse } from '@/lib/api'

beforeEach(stubChartGlobals)
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const CODES: [number, string, { East: number; West: number }][] = [
  [101, 'Barriers', { East: 0, West: 3 }],  // East never used it: a LEADING zero
  [102, 'Cost', { East: 4, West: 0 }],      // West never used it: an INTERIOR zero
  [103, 'Distance', { East: 5, West: 2 }],
  [104, 'Trust', { East: 2, West: 6 }],
]
const CODE_ID = Object.fromEntries(CODES.map(([id, name]) => [name, id]))

const data: DemographicComparisonResponse = {
  groups: ['East', 'West'],
  group_totals: { East: { total_segments: 40, total_word_count: 900 }, West: { total_segments: 40, total_word_count: 900 } },
  codes: CODES.map(([code_id, code_name, counts]) => ({
    code_id,
    code_name,
    category_name: null,
    by_group: {
      East: { count: counts.East, proportion: counts.East / 40, undefined_reason: null },
      West: { count: counts.West, proportion: counts.West / 40, undefined_reason: null },
    },
    delta_proportion: null,
    test: null,
  })),
}

describe('QualComparisonBar click drill-down (#1314)', () => {
  it.each([
    ['East', 0, ['Cost', 'Distance', 'Trust']],
    ['West', 1, ['Barriers', 'Distance', 'Trust']],
  ])('every %s bar opens the code it is drawn for', (_group, series, drawnFor) => {
    const onCodeClick = vi.fn()
    const { container } = render(<QualComparisonBar data={data} onCodeClick={onCodeClick} />)
    const rects = seriesBarRects(container, series)
    expect(rects.map(r => r.category)).toEqual(drawnFor)
    for (const rect of rects) {
      fireEvent.click(rect.el)
      expect(onCodeClick).toHaveBeenLastCalledWith(CODE_ID[rect.category])
    }
    expect(onCodeClick).toHaveBeenCalledTimes(drawnFor.length)
  })
})
