/**
 * #525 — the assumption note beside a comparison.
 *
 * The load-bearing assertions are about HONESTY rather than formatting: a group
 * the test could not run on must be named, and the caveat must appear in the
 * direction that applies to the n at hand.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import AssumptionNote from './AssumptionNote'
import type { ComparisonRow } from '@/lib/api'

afterEach(cleanup)

const g = (group: string, n: number, p: number | null, reason: string | null = null) => ({
  group, n, mean: 1, sd: 1, median: 1, ci_lower: null, ci_upper: null,
  undefined_reason: null,
  normality: { test: 'shapiro_wilk', statistic: p == null ? null : 0.95, p, undefined_reason: reason },
})

const row = (groups: ReturnType<typeof g>[], variance: unknown = {
  test: 'levene', statistic: 1.1, p: 0.396, center: 'median', undefined_reason: null,
}): ComparisonRow => ({
  label: 'X', full_label: 'X', source_id: 1, source_type: 'dataset_column',
  group_stats: groups, test: null, test_omitted_reason: null,
  variance_homogeneity: variance,
} as unknown as ComparisonRow)

describe('#525 — the assumption note', () => {
  it('reports the failing groups by name', () => {
    render(<AssumptionNote row={row([g('A', 20, 0.01), g('B', 20, 0.4)])} />)
    expect(screen.getByText(/1 of 2 groups departs at p < .05 \(A\)/)).toBeInTheDocument()
  })

  /**
   * 🔴 Found by reading the live output: nine schools produced "1 of 8 groups"
   * and nothing said a ninth existed and was skipped for being too small. A
   * count that quietly shrinks reads as a complete one.
   */
  it('NAMES the groups it could not test, so the denominator is not silently short', () => {
    render(<AssumptionNote row={row([
      g('A', 20, 0.01), g('B', 20, 0.4), g('Tiny', 2, null, 'insufficient_n'),
    ])} />)
    expect(screen.getByText(/1 of 2 groups/)).toBeInTheDocument()
    expect(screen.getByText(/1 not testable \(Tiny\)/)).toBeInTheDocument()
  })

  it('names Levene\'s centre, not just "Levene"', () => {
    render(<AssumptionNote row={row([g('A', 20, 0.4)])} />)
    expect(screen.getByText(/Brown–Forsythe/)).toBeInTheDocument()
  })

  it('says equal variances is not computable rather than showing a blank', () => {
    render(<AssumptionNote row={row([g('A', 20, 0.4)], {
      test: 'levene', statistic: null, p: null, center: 'median',
      undefined_reason: 'no_variance',
    })} />)
    expect(screen.getByText(/Equal variances: not computable/)).toBeInTheDocument()
  })

  it('shows the small-n caveat, and does not call a null result evidence', () => {
    render(<AssumptionNote row={row([g('A', 4, 0.9)])} />)
    expect(screen.getByText(/little power/)).toBeInTheDocument()
    expect(screen.getByText(/not evidence of it/)).toBeInTheDocument()
  })

  it('shows the large-n caveat instead when that is the risk', () => {
    render(<AssumptionNote row={row([g('A', 900, 0.001)])} />)
    expect(screen.getByText(/too small/)).toBeInTheDocument()
  })

  it('renders nothing when the row carries no checks at all', () => {
    const bare = { ...row([]), variance_homogeneity: null } as ComparisonRow
    const { container } = render(<AssumptionNote row={bare} />)
    expect(container).toBeEmptyDOMElement()
  })
})
