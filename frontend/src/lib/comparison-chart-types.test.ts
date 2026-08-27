/**
 * #525b — the comparison output vocabulary, declared once.
 *
 * The value of single-sourcing this is mostly a COMPILE-time property (the
 * `satisfies Record<…>` on the labels, and on the icon map in
 * `CorrelationsComparisonsContent`), which a runtime test cannot observe. What
 * these pin is the half TypeScript cannot: the URL sanitiser, which takes a
 * user-editable string and must never widen the union by accident.
 */
import { describe, it, expect } from 'vitest'
import {
  COMPARISON_CHART_TYPES,
  COMPARISON_CHART_LABELS,
  DEFAULT_COMPARISON_CHART_TYPE,
  isComparisonChartType,
  toComparisonChartType,
} from './comparison-chart-types'

describe('the vocabulary', () => {
  it('found something — a scan whose expected result is empty passes by finding nothing', () => {
    expect(COMPARISON_CHART_TYPES.length).toBeGreaterThanOrEqual(5)
  })

  it('labels EVERY type, with no duplicates among the ids', () => {
    for (const t of COMPARISON_CHART_TYPES) {
      expect(COMPARISON_CHART_LABELS[t]).toBeTruthy()
    }
    expect(new Set(COMPARISON_CHART_TYPES).size).toBe(COMPARISON_CHART_TYPES.length)
  })

  it('includes the Q–Q plot', () => {
    expect(COMPARISON_CHART_TYPES).toContain('comparison_qq')
  })
})

describe('toComparisonChartType', () => {
  it('accepts every declared type unchanged', () => {
    for (const t of COMPARISON_CHART_TYPES) expect(toComparisonChartType(t)).toBe(t)
  })

  it('falls back for a RETIRED value rather than passing it through', () => {
    // Stale deep links still carry `forest_plot`, removed with #426.
    expect(toComparisonChartType('forest_plot')).toBe(DEFAULT_COMPARISON_CHART_TYPE)
  })

  it('falls back for null and for junk', () => {
    expect(toComparisonChartType(null)).toBe(DEFAULT_COMPARISON_CHART_TYPE)
    expect(toComparisonChartType('')).toBe(DEFAULT_COMPARISON_CHART_TYPE)
    expect(toComparisonChartType('../../etc/passwd')).toBe(DEFAULT_COMPARISON_CHART_TYPE)
  })

  it('does not accept a PREFIX of a real type', () => {
    // A `startsWith`-shaped implementation would pass everything above.
    expect(isComparisonChartType('comparison_')).toBe(false)
    expect(isComparisonChartType('comparison_qq_extra')).toBe(false)
  })
})
