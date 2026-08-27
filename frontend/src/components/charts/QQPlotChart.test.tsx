/**
 * #525b — the normal Q–Q plot.
 *
 * ⚠️ jsdom computes no layout, so nothing here can see whether the points are in
 * the right PLACE — that is what the browser check is for, and #522(a)'s
 * flush-bar defect plus the 08-18 three-chart round are the standing reminder
 * that a green suite is not a rendered chart. What these DO pin is the part that
 * is not geometry: that no number is invented, that the reference line is drawn
 * from the server's own coefficients, and that the accessible path is a SUMMARY
 * rather than several hundred coordinates.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

vi.mock('@/lib/theme-context', async (orig) => {
  const { CHART_COLORS } = await import('@/lib/chart-data')
  return {
    ...(await orig<typeof import('@/lib/theme-context')>()),
    useChartColors: () => CHART_COLORS,
  }
})

import QQPlotChart from './QQPlotChart'
import type { QQSummary } from '@/lib/api'

afterEach(cleanup)

const qq = (over: Partial<QQSummary> = {}): QQSummary => ({
  points: [
    { theoretical: -1.5, sample: -4.2 },
    { theoretical: -0.5, sample: -1.1 },
    { theoretical: 0.5, sample: 1.4 },
    { theoretical: 1.5, sample: 4.9 },
  ],
  points_omitted: 0,
  n: 4,
  ppcc: 0.9958,
  line_slope: 3.05,
  line_intercept: -0.12,
  singleton_group_count: 0,
  plotting_position: 'r_ppoints_blom_hazen',
  reference_line: 'qqline_quartiles_type7',
  undefined_reason: null,
  ...over,
})

describe('QQPlotChart', () => {
  it('draws one mark per point it was given and invents none', () => {
    const { container } = render(<QQPlotChart qq={qq()} />)
    expect(container.querySelectorAll('circle')).toHaveLength(4)
  })

  it('draws the reference line from the SERVER coefficients', () => {
    // The plotting positions are sample-size-dependent, so a client-side
    // derivation would silently disagree with the tool's own numbers.
    const { container } = render(<QQPlotChart qq={qq()} />)
    expect(container.querySelectorAll('line[stroke-dasharray]')).toHaveLength(1)
  })

  it('omits the reference line rather than guessing one when it is absent', () => {
    const { container } = render(
      <QQPlotChart qq={qq({ line_slope: null, line_intercept: null })} />,
    )
    expect(container.querySelectorAll('line[stroke-dasharray]')).toHaveLength(0)
    expect(container.querySelectorAll('circle')).toHaveLength(4)
  })

  it('states the straightness number and the basis in the caption', () => {
    // Scoped to the figcaption on purpose: `0.9958` is deliberately in BOTH the
    // caption and the accessible summary, so an unscoped query matches twice.
    const { container } = render(<QQPlotChart qq={qq()} />)
    const caption = container.querySelector('figcaption')!
    expect(caption.textContent).toMatch(/0\.9958/)
    expect(caption.textContent).toMatch(/ppoints/)
  })

  it('says the plot is of RESIDUALS, not of any one group', () => {
    // The row-grain choice is invisible otherwise, and "Shapiro flags group B
    // but the Q–Q looks straight" reads as a bug without this sentence.
    render(<QQPlotChart qq={qq()} />)
    expect(screen.getByText(/minus its own group/i)).toBeInTheDocument()
  })

  it('refuses with an explanation rather than an empty frame', () => {
    const { container } = render(
      <QQPlotChart qq={qq({ undefined_reason: 'no_variance', points: [] })} />,
    )
    expect(container.querySelectorAll('circle')).toHaveLength(0)
    expect(screen.getByText(/No Q–Q plot/)).toBeInTheDocument()
  })

  it('handles a null payload without throwing', () => {
    // The field is absent unless the request opted in, so `null` is ordinary.
    expect(() => render(<QQPlotChart qq={null} />)).not.toThrow()
  })

  describe('the accessible path', () => {
    it('is a SUMMARY, not a coordinate table', () => {
      // A box plot pairs its SVG with an sr-only table because its content IS
      // five numbers. 500 rows of coordinates would be an obstacle, not an
      // equivalent — so the equivalent here describes the SHAPE.
      const { container } = render(<QQPlotChart qq={qq()} />)
      expect(container.querySelector('table')).toBeNull()
      const sr = container.querySelector('.sr-only')
      expect(sr).not.toBeNull()
      expect(sr!.textContent).toMatch(/4 model residuals/)
      expect(sr!.textContent).toMatch(/close to the line/)
    })

    it('hides the SVG from the accessibility tree so it is not read as noise', () => {
      const { container } = render(<QQPlotChart qq={qq()} />)
      expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    })

    it('reaches the summary with the variable name when one is given', () => {
      const { container } = render(<QQPlotChart qq={qq()} valueLabel="Wellbeing" />)
      expect(container.querySelector('.sr-only')!.textContent).toContain('Wellbeing')
    })

    /**
     * 🔴 Heard on the rendered page, not read: a `<figcaption>` is ordinary
     * accessible text, so a fact placed in BOTH channels is announced twice in
     * consecutive sentences. Each channel says its own part exactly once — the
     * caption the numbers and the basis, the sr-only paragraph the shape.
     */
    it('declares thinning ONCE, in the caption', () => {
      const { container } = render(
        <QQPlotChart qq={qq({ n: 2400, points_omitted: 1900 })} />,
      )
      expect(container.querySelector('figcaption')!.textContent).toMatch(/1900/)
      expect(container.querySelector('.sr-only')!.textContent).not.toMatch(/1900/)
    })

    it('declares singleton groups ONCE, in the caption', () => {
      const { container } = render(
        <QQPlotChart qq={qq({ singleton_group_count: 3 })} />,
      )
      expect(container.querySelector('figcaption')!.textContent).toMatch(/3 groups/)
      expect(container.querySelector('.sr-only')!.textContent).not.toMatch(/3 groups/)
    })

    it('does not repeat the straightness figure across the two channels', () => {
      const { container } = render(<QQPlotChart qq={qq()} />)
      expect(container.querySelector('figcaption')!.textContent).toMatch(/0\.9958/)
      expect(container.querySelector('.sr-only')!.textContent).not.toMatch(/0\.9958/)
    })
  })
})
