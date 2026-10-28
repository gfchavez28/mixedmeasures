/**
 * #1421 — the comparison bar chart and a group with no segments.
 *
 * The bars are COUNTS (a true 0 for a group with no segments); the false claim was the
 * tooltip's "(0.0%)", fed by `stats?.proportion ?? 0` — a reader the compiler cannot
 * name, because `?? 0` accepts the new `null` silently. The chart now names the group
 * with the server's reason under the plot, and the tooltip prints `(—)` — while a real
 * zero still prints `(0.0%)`.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('recharts', async (orig) => {
  const { withSizedResponsiveContainer } = await import('@/test-support/recharts-render')
  return withSizedResponsiveContainer(await orig<typeof import('recharts')>())
})
vi.mock('@/lib/theme-context', async (orig) => {
  const { CHART_COLORS } = await import('@/lib/chart-data')
  return { ...(await orig<typeof import('@/lib/theme-context')>()), useChartColors: () => CHART_COLORS }
})

import QualComparisonBar, { ComparisonTooltip } from './QualComparisonBar'
import { stubChartGlobals } from '@/test-support/recharts-render'
import type { DemographicComparisonResponse } from '@/lib/api'

beforeEach(stubChartGlobals)
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const data: DemographicComparisonResponse = {
  groups: ['Interviewed', 'Survey only'],
  group_totals: {
    Interviewed: { total_segments: 4, total_word_count: 4 },
    'Survey only': { total_segments: 0, total_word_count: 0 },
  },
  codes: [{
    code_id: 1, code_name: 'Cost', category_name: null,
    by_group: {
      Interviewed: { count: 1, proportion: 0.25, undefined_reason: null },
      'Survey only': { count: 0, proportion: null, undefined_reason: 'no_segments' },
    },
    delta_proportion: null, test: null,
  }],
}

describe('QualComparisonBar — a group with no segments (#1421)', () => {
  it('names the group and the reason under the chart', () => {
    render(<QualComparisonBar data={data} />)
    expect(screen.getByText('Survey only:')).toBeInTheDocument()
    expect(screen.getByText(/No participant turns from this group in the conversations compared/))
      .toBeInTheDocument()
  })

  it('says nothing when every group has a share', () => {
    const full: DemographicComparisonResponse = {
      ...data,
      codes: [{ ...data.codes[0], by_group: {
        Interviewed: { count: 1, proportion: 0.25, undefined_reason: null },
        'Survey only': { count: 0, proportion: 0, undefined_reason: null },
      } }],
    }
    render(<QualComparisonBar data={full} />)
    expect(screen.queryByText(/No participant turns/)).not.toBeInTheDocument()
  })

  it('the tooltip prints (—) for no share and (0.0%) for a real zero', () => {
    const payload = [
      { name: 'Survey only', value: 0, fill: '#000', payload: { '_prop_Survey only': null } },
      { name: 'Phone', value: 0, fill: '#111', payload: { _prop_Phone: 0 } },
    ]
    const { container } = render(
      <ComparisonTooltip active label="Cost" payload={payload as never} />,
    )
    const text = container.textContent ?? ''
    expect(text).toContain('Survey only:0(—)')
    expect(text).not.toContain('Survey only:0(0.0%)')
    expect(text).toContain('Phone:0(0.0%)')
  })
})
