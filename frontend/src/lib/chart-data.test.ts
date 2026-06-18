// #406 regression: numeric-aware ordering of group-value labels.
// compareValueLabels is the frontend mirror of backend
// services/grouping.py::order_value_labels — multi-digit values are the
// load-bearing test data (lexicographic == numeric for 1–5 Likert, which is
// how the bug stayed hidden).
import { describe, expect, it } from 'vitest'

import type { MetricDefinitionResponse } from './api'
import { compareValueLabels, getGroupValues, sortGroupValues, formatP, formatPValue } from './chart-data'

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
