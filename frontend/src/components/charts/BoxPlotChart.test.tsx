/**
 * #522b — the box plot.
 *
 * ⚠️ jsdom computes no layout, so nothing here can see whether the shapes are in
 * the right PLACE — that is what the browser check is for, and #522(a)'s flush-bar
 * defect is the standing reminder that a green suite is not a rendered chart.
 * What these DO pin is the part that is not geometry: which numbers are drawn,
 * that none are invented, and that the accessible equivalent carries the same
 * five numbers the shapes encode.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// The established pattern for a chart test (see AnalysisCrossTabTable.test) —
// ThemeProvider reads localStorage, which jsdom does not supply here.
vi.mock('@/lib/theme-context', async (orig) => {
  const { CHART_COLORS } = await import('@/lib/chart-data')
  return {
    ...(await orig<typeof import('@/lib/theme-context')>()),
    useChartColors: () => CHART_COLORS,
  }
})

import BoxPlotChart from './BoxPlotChart'
import { describeBoxBasis } from '@/lib/box-plot-basis'
import type { GroupStat } from '@/lib/api'

afterEach(cleanup)

const box = (over: Partial<NonNullable<GroupStat['box']>> = {}) => ({
  min: 1, q1: 3, median: 5, q3: 7, max: 9,
  whisker_low: 1, whisker_high: 9,
  outliers: [] as number[], outliers_omitted: 0,
  quartile_method: 'type7_linear', whisker_rule: 'tukey_1_5_iqr',
  ...over,
})

const group = (name: string, n = 10, over = {}): GroupStat => ({
  group: name, n, mean: 5, sd: 2, median: 5, ci_lower: 4, ci_upper: 6,
  undefined_reason: null, box: box(over),
} as GroupStat)

const renderBox = (groups: GroupStat[]) =>
  render(<BoxPlotChart groups={groups} />)

describe('BoxPlotChart (#522b)', () => {
  it('the accessible equivalent carries the same five numbers as the shapes', () => {
    renderBox([group('Control'), group('Treatment')])
    const table = screen.getByRole('table')
    const row = within(table).getByRole('row', { name: /Control/ })
    for (const v of ['1', '3', '5', '7', '9']) {
      expect(row).toHaveTextContent(v)
    }
  })

  it('the drawing itself is hidden — the table is the accessible path', () => {
    const { container } = renderBox([group('A')])
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })

  /**
   * 🔴 The load-bearing one. A box plot is uninterpretable without knowing which
   * quartile definition drew it — several exist and disagree on small samples —
   * so the basis is DISPLAYED, from the payload, never assumed by the client.
   */
  it('states the quartile method and whisker rule from the PAYLOAD', () => {
    renderBox([group('A')])
    expect(screen.getByText(/type 7/i)).toBeInTheDocument()
    expect(screen.getByText(/1\.5 × IQR/)).toBeInTheDocument()
  })

  it('an unknown convention is reported verbatim, never silently relabelled', () => {
    expect(describeBoxBasis({ quartile_method: 'hinges', whisker_rule: 'minmax' }))
      .toMatch(/hinges/)
    expect(describeBoxBasis({ quartile_method: 'hinges', whisker_rule: 'minmax' }))
      .not.toMatch(/type 7/i)
  })

  it('a capped outlier list REPORTS the remainder rather than truncating silently', () => {
    renderBox([group('A', 300, { outliers: [99], outliers_omitted: 12 })])
    expect(screen.getByText(/12 further outliers not plotted/)).toBeInTheDocument()
  })

  /**
   * An empty group has no box, by the same #689 reasoning that makes its mean
   * null: there is nobody to summarise. It must be skipped, not drawn as zero.
   */
  it('skips a group the server gave no box for', () => {
    const empty = { ...group('Empty', 0), box: null } as GroupStat
    renderBox([group('Real'), empty])
    const table = screen.getByRole('table')
    expect(within(table).queryByRole('row', { name: /Empty/ })).not.toBeInTheDocument()
    expect(within(table).getByRole('row', { name: /Real/ })).toBeInTheDocument()
  })

  it('says so when NO group can be drawn, instead of rendering an empty axis', () => {
    const empty = { ...group('Empty', 0), box: null } as GroupStat
    renderBox([empty])
    expect(screen.getByRole('status')).toHaveTextContent(/No group has enough data/)
  })
})

/**
 * #522b — group names must stay legible as the group count grows.
 *
 * Found by LOOKING at 9 schools: "Maple RidgeRoosevelt Washington" ran together
 * as one string. jsdom cannot measure text, so this asserts the DECISION (the
 * rotate transform is applied / not applied), not the pixels — the browser check
 * is what confirmed the result.
 */
describe('#522b — group label legibility', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => group(`Long School Name ${i}`, 15))

  it('angles the names when they cannot fit their band', () => {
    const { container } = render(<BoxPlotChart groups={many(9)} />)
    const rotated = [...container.querySelectorAll('text')]
      .filter(t => (t.getAttribute('transform') || '').includes('rotate'))
    expect(rotated).toHaveLength(9)
    // n is folded into the angled line, so there is only one thing to angle.
    expect(rotated[0].textContent).toMatch(/\(n=15\)/)
  })

  it('leaves them horizontal when there is room', () => {
    const { container } = render(<BoxPlotChart groups={[group('A'), group('B')]} />)
    const rotated = [...container.querySelectorAll('text')]
      .filter(t => (t.getAttribute('transform') || '').includes('rotate'))
    expect(rotated).toHaveLength(0)
  })
})
