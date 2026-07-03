// #406 regression: numeric-aware ordering of group-value labels.
// compareValueLabels is the frontend mirror of backend
// services/grouping.py::order_value_labels — multi-digit values are the
// load-bearing test data (lexicographic == numeric for 1–5 Likert, which is
// how the bug stayed hidden).
import { describe, expect, it } from 'vitest'

import type { MetricDefinitionResponse } from './api'
import type { DumbbellRow } from './chart-data'
import { compareValueLabels, getGroupValues, sortGroupValues, formatP, formatPValue, resolveFrequencyBarColors, resolveColorPalette, computeDumbbellAxis, shapeFrequencyTable } from './chart-data'

function metricsWithGroups(groupValues: string[]): MetricDefinitionResponse[] {
  return [
    {
      results: groupValues.map(gv => ({ group_value: gv })),
    },
  ] as unknown as MetricDefinitionResponse[]
}

// #429 regression: inline p-value strings must carry exactly one operator.
// The bug was sites writing `p = ${formatP(p)}` → "p = <.001" (double operator).
describe('formatPValue (inline, operator-aware)', () => {
  it('uses "<" for tiny p, never "= <"', () => {
    expect(formatPValue(0.0001)).toBe('p < .001')
    expect(formatPValue(0)).toBe('p < .001')
  })
  it('uses "=" with a stripped leading zero otherwise', () => {
    expect(formatPValue(0.523)).toBe('p = .523')
    expect(formatPValue(0.04)).toBe('p = .040')
    expect(formatPValue(0.999)).toBe('p = .999')
  })
  it('never emits "p = 0.0000" for a significant result', () => {
    expect(formatPValue(0.00004)).not.toContain('0.0000')
    expect(formatPValue(0.00004)).toBe('p < .001')
  })
})

// formatP stays the bare cell formatter (no operator — the column header says "p").
describe('formatP (bare cell)', () => {
  it('returns "<.001" / ".523" without an operator', () => {
    expect(formatP(0.0001)).toBe('<.001')
    expect(formatP(0.523)).toBe('.523')
  })
})

describe('compareValueLabels', () => {
  it('sorts numeric labels numerically (1, 2, 9, 12, 15 — not 1, 12, 15, 2, 9)', () => {
    expect(['1', '12', '15', '2', '9'].sort(compareValueLabels)).toEqual([
      '1', '2', '9', '12', '15',
    ])
  })

  it('handles 3-digit values and decimals', () => {
    expect(['100', '2.5', '10', '2'].sort(compareValueLabels)).toEqual(['2', '2.5', '10', '100'])
  })

  it('keeps pure-text labels lexicographic', () => {
    expect(['Gamma', 'Alpha', 'Beta'].sort(compareValueLabels)).toEqual([
      'Alpha', 'Beta', 'Gamma',
    ])
  })

  it('puts numeric labels before text in mixed sets', () => {
    expect(['Other', '12', '2', 'Unknown'].sort(compareValueLabels)).toEqual([
      '2', '12', 'Other', 'Unknown',
    ])
  })

  it('treats empty/whitespace strings as text, not Number("") === 0', () => {
    expect([' ', '5', ''].sort(compareValueLabels)).toEqual(['5', '', ' '])
  })
})

describe('getGroupValues', () => {
  it('returns numeric group values in numeric order', () => {
    expect(getGroupValues(metricsWithGroups(['12', '8', '100']))).toEqual(['8', '12', '100'])
  })
})

// #417: numeric frequency bars should be one color (position carries the
// meaning), not a rainbow; categorical labels and explicit palette/custom
// choices keep per-label colors.
describe('resolveFrequencyBarColors', () => {
  const single = resolveColorPalette('default')[0]

  it('renders all-numeric labels in a single color under the default palette', () => {
    const colors = resolveFrequencyBarColors(['10', '20', '35', '60'], 'default', {})
    expect(new Set(Object.values(colors)).size).toBe(1)
    expect(colors['10']).toBe(single)
    expect(colors['60']).toBe(single)
  })

  it('keeps per-label rainbow colors for categorical (non-numeric) labels', () => {
    const colors = resolveFrequencyBarColors(['Yes', 'No', 'Maybe'], 'default', {})
    expect(new Set(Object.values(colors)).size).toBe(3)
  })

  it('honors an explicit non-default palette even for numeric labels', () => {
    const colors = resolveFrequencyBarColors(['10', '20', '30'], 'warm', {})
    // warm palette is multi-color → distinct per label, not collapsed to one.
    expect(new Set(Object.values(colors)).size).toBeGreaterThan(1)
  })

  it('honors custom colors instead of collapsing to one', () => {
    const colors = resolveFrequencyBarColors(['10', '20'], 'default', { '10': '#abcdef' })
    expect(colors['10']).toBe('#abcdef')
  })

  it('treats a label set with any non-numeric member as categorical', () => {
    const colors = resolveFrequencyBarColors(['10', '20', 'N/A'], 'default', {})
    expect(new Set(Object.values(colors)).size).toBe(3)
  })
})

// #431: fit the dumbbell x-axis to the means + typical CIs (forest-plot
// convention), so a single pathologically wide CI can't dominate the scale.
describe('computeDumbbellAxis', () => {
  function dumbbellRows(values: number[], cis?: ([number, number] | null)[]): DumbbellRow[] {
    return [
      {
        label: 'Q',
        metricId: 1,
        dots: values.map((value, i) => {
          const ci = cis?.[i]
          return {
            groupValue: `g${i}`,
            value,
            n: 10,
            ciLower: ci ? ci[0] : undefined,
            ciUpper: ci ? ci[1] : undefined,
          }
        }),
      },
    ]
  }

  it('fits the axis to the means (no CI) instead of anchoring at 0', () => {
    expect(computeDumbbellAxis(dumbbellRows([60, 78, 98]), { showCI: false })).toEqual({ xMin: 50, xMax: 110 })
  })

  it('includes typical CIs within the range', () => {
    const axis = computeDumbbellAxis(dumbbellRows([60, 90], [[55, 65], [85, 95]]), { showCI: true })
    expect(axis.xMin).toBeLessThanOrEqual(55)
    expect(axis.xMax).toBeGreaterThanOrEqual(95)
  })

  it('does NOT let one outlier-wide CI dominate the scale (median-capped)', () => {
    // Two tight CIs + one absurd [10,150] (the n=2 case). Axis must stay near
    // the means, not blow out to ~150.
    const axis = computeDumbbellAxis(
      dumbbellRows([60, 75, 86], [[53, 67], [68, 82], [10, 150]]),
      { showCI: true },
    )
    expect(axis.xMax).toBeLessThanOrEqual(110) // not ~150
    expect(axis.xMin).toBeGreaterThanOrEqual(30) // not ~0
    // The outlier CI therefore falls outside the axis → renderer clips + arrows.
    expect(10).toBeLessThan(axis.xMin)
    expect(150).toBeGreaterThan(axis.xMax)
  })

  it('ignores CIs entirely when showCI is false', () => {
    expect(computeDumbbellAxis(dumbbellRows([60, 90], [[0.8, 153], null]), { showCI: false }))
      .toEqual({ xMin: 50, xMax: 100 })
  })

  it('keeps the 0 baseline for non-negative data near zero', () => {
    expect(computeDumbbellAxis(dumbbellRows([3, 6, 8]), { showCI: false }).xMin).toBe(0)
  })

  it('shows negative axis for negative data rather than clipping at 0', () => {
    const axis = computeDumbbellAxis(dumbbellRows([-5, 5, 12]), { showCI: false })
    expect(axis.xMin).toBeLessThan(0)
  })

  it('honors explicit xAxisMin / xAxisMax overrides', () => {
    expect(computeDumbbellAxis(dumbbellRows([60, 90]), { showCI: false, xAxisMin: 0, xAxisMax: 120 }))
      .toEqual({ xMin: 0, xMax: 120 })
  })

  it('returns a sane default for empty data', () => {
    expect(computeDumbbellAxis([], { showCI: false })).toEqual({ xMin: 0, xMax: 100 })
  })
})

describe('sortGroupValues asc/desc', () => {
  it('asc is numeric-aware', () => {
    expect(sortGroupValues(['12', '8', '100'], 'asc', [])).toEqual(['8', '12', '100'])
  })

  it('desc is the exact reverse', () => {
    expect(sortGroupValues(['12', '8', '100'], 'desc', [])).toEqual(['100', '12', '8'])
  })

  it('none returns input untouched', () => {
    expect(sortGroupValues(['12', '8'], 'none', [])).toEqual(['12', '8'])
  })
})

describe('shapeFrequencyTable missing row (#497)', () => {
  it('derives missingN from result-level total_n (result_data never carries it)', () => {
    const metric = {
      id: 1,
      name: 'Freq: Site',
      metric_type: 'frequency_distribution',
      input_source_label: 'Site',
      results: [{
        id: 10,
        group_value: null,
        // Backend shape (metrics.py): counts/percentages/scale_order ONLY —
        // total_n lives on the RESULT row. Values ≥10 per the #406 rule.
        result_data: {
          counts: { '8': 4, '12': 6, 'North': 12 },
          percentages: { '8': 18.2, '12': 27.3, 'North': 54.5 },
          scale_order: ['8', '12', 'North'],
        },
        valid_n: 22,
        total_n: 24,
      }],
    }
    const [table] = shapeFrequencyTable([metric as never])
    expect(table.totalMissing).toBe(2)
    expect(table.totalAll).toBe(24)
    // "% of total" uses total_n (count/24), NOT valid share (count/22).
    const north = table.rows.find(r => r.label === 'North')!
    expect(north.percent).toBeCloseTo((12 / 24) * 100, 5)
    expect(north.validPercent).toBeCloseTo((12 / 22) * 100, 5)
  })
})
