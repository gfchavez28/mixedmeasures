// #406 regression: numeric-aware ordering of group-value labels.
// compareValueLabels is the frontend mirror of backend
// services/grouping.py::order_value_labels — multi-digit values are the
// load-bearing test data (lexicographic == numeric for 1–5 Likert, which is
// how the bug stayed hidden).
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { MetricDefinitionResponse } from './api'
import type { DumbbellRow } from './chart-data'
import { compareValueLabels, getGroupValues, sortGroupValues, formatP, formatPValue, resolveFrequencyBarColors, resolveColorPalette, computeDumbbellAxis, shapeFrequencyTable, shapeFrequencyBars, shapeGroupedFrequencyBars, getVisibleOptions,
  binFrequencyCounts,
  shapeHistogramBars,
  describeHistogramBasis,
  MAX_HISTOGRAM_BINS,
  getApplicableChartTypes,
  HISTOGRAM_DEFAULT_THRESHOLD,
} from './chart-data'

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

/**
 * queue #42 — the margin of error on a frequency distribution.
 *
 * "What % chose each option" is the most-reported number in survey work and it
 * shipped with no interval, while Wilson was already implemented and wired to
 * the threshold-`proportion` metric.
 */
describe('shapeFrequencyBars — per-category intervals', () => {
  const metric = (rd: Record<string, unknown>) => ({
    id: 1,
    metric_type: 'frequency_distribution',
    results: [{ result_data: rd, valid_n: 50, group_value: null }],
  }) as unknown as Parameters<typeof shapeFrequencyBars>[0]

  const rd = {
    counts: { Low: 30, Neutral: 0, High: 20 },
    percentages: { Low: 60, Neutral: 0, High: 40 },
    scale_order: ['Low', 'Neutral', 'High'],
    ci_lower_by_label: { Low: 46.2, Neutral: 0, High: 27.6 },
    ci_upper_by_label: { Low: 72.4, Neutral: 7.1, High: 53.8 },
    ci_level: 0.95,
    ci_method: 'wilson_per_category',
  }

  it('carries each category its own interval and the method', () => {
    const bars = shapeFrequencyBars(metric(rd))
    expect(bars.map(b => [b.ciLower, b.ciUpper])).toEqual([
      [46.2, 72.4], [0, 7.1], [27.6, 53.8],
    ])
    expect(bars.every(b => b.ciMethod === 'wilson_per_category')).toBe(true)
  })

  it('keeps the zero-count level bounded away from certainty', () => {
    // The Wilson-over-Wald argument, at the value that makes it: a declared
    // level nobody chose (#591) has p = 0, where Wald collapses to [0, 0] and
    // would assert that nobody COULD have chosen it.
    const neutral = shapeFrequencyBars(metric(rd)).find(b => b.label === 'Neutral')!
    expect(neutral.percentage).toBe(0)
    expect(neutral.ciUpper).toBeGreaterThan(0)
  })

  it('leaves the interval ABSENT on a result that predates it', () => {
    // `?? undefined`, never `?? 0` — a zero-width bar sitting on the estimate
    // reads as a precise measurement rather than as no measurement.
    const older = { counts: rd.counts, percentages: rd.percentages, scale_order: rd.scale_order }
    const bars = shapeFrequencyBars(metric(older))
    expect(bars.every(b => b.ciLower === undefined && b.ciUpper === undefined)).toBe(true)
  })

  it('carries the interval through label hiding and scale reversal', () => {
    // Both options rewrite `scaleOrder`; a CI looked up by index rather than by
    // label would silently attach the wrong interval to each bar.
    const bars = shapeFrequencyBars(metric(rd), { reverseScale: true })
    expect(bars.map(b => b.label)).toEqual(['High', 'Neutral', 'Low'])
    expect(bars[0].ciLower).toBe(27.6)

    const hidden = shapeFrequencyBars(metric(rd), { hiddenLabels: ['Neutral'] })
    expect(hidden.map(b => b.label)).toEqual(['Low', 'High'])
    expect(hidden[1].ciUpper).toBe(53.8)
  })
})

describe('getVisibleOptions — where the CI toggle is offered', () => {
  it('offers error bars on a frequency BAR chart', () => {
    expect(getVisibleOptions('horizontal_bar', 'frequency_distribution').showCI).toBe(true)
    expect(getVisibleOptions('vertical_bar', 'frequency_distribution').showCI).toBe(true)
  })

  it('withholds them where an error bar would be a false statement', () => {
    // On a stacked bar the categories sum to 100% by construction: an error bar
    // on a segment of a fixed whole implies uncertainty about a composition
    // that has none. Heatmap and frequency_table have nowhere to draw one.
    for (const t of ['stacked_bar', 'heatmap', 'frequency_table'] as const) {
      expect(getVisibleOptions(t, 'frequency_distribution').showCI).toBe(false)
    }
  })

  it('still offers them for scalar metrics, unchanged', () => {
    expect(getVisibleOptions('horizontal_bar', 'mean').showCI).toBe(true)
    expect(getVisibleOptions('cross_tab', 'frequency_distribution').showCI).toBe(false)
  })
})

describe('shapeGroupedFrequencyBars — per-category intervals', () => {
  const groupResult = (gv: string, lo: number, hi: number) => ({
    group_value: gv,
    valid_n: 25,
    result_data: {
      counts: { Yes: 10, No: 15 },
      percentages: { Yes: 40, No: 60 },
      scale_order: ['Yes', 'No'],
      ci_lower_by_label: { Yes: lo, No: 40 },
      ci_upper_by_label: { Yes: hi, No: 78 },
      ci_method: 'wilson_per_category',
    },
  })

  const metric = {
    id: 7,
    metric_type: 'frequency_distribution',
    name: 'Q1',
    results: [groupResult('A', 22, 61), groupResult('B', 25, 64)],
  } as unknown as Parameters<typeof shapeGroupedFrequencyBars>[0]

  it('carries an interval per group, since each group has its own denominator', () => {
    // Not symmetry with the ungrouped path: VerticalBarChart draws an ErrorBar
    // per group series, so omitting these would leave the toggle on and nothing
    // drawn — which reads as "this data has no uncertainty".
    const section = shapeGroupedFrequencyBars(metric, ['A', 'B'])
    expect(section.groups[0].bars[0].ciLower).toBe(22)
    expect(section.groups[1].bars[0].ciLower).toBe(25)
    expect(section.groups[0].bars[0].ciMethod).toBe('wilson_per_category')
  })

  it('leaves a group with no result alone rather than inventing an interval', () => {
    const section = shapeGroupedFrequencyBars(metric, ['A', 'missing'])
    expect(section.groups[1].bars).toEqual([])
  })
})

// ── #522 histogram binning ──────────────────────────────────────────────────

describe('binFrequencyCounts (#522)', () => {
  /** n identical observations of `v`. */
  const counts = (pairs: [number, number][]): Record<string, number> =>
    Object.fromEntries(pairs.map(([v, c]) => [String(v), c]))

  it('is EXACT — every observation lands in exactly one bin', () => {
    const c = counts([[40, 3], [41, 5], [55, 2], [91, 1]])
    const h = binFrequencyCounts(c)
    const total = h.bins.reduce((s, b) => s + b.count, 0)
    expect(total).toBe(11)
  })

  it('collapses the picket fence — 42 distinct values become a readable few', () => {
    // The entry's own repro: a continuous 40–91 score drew ~42 one-per-value bars.
    const c = counts(Array.from({ length: 42 }, (_, i) => [40 + i, 3] as [number, number]))
    const h = binFrequencyCounts(c)
    expect(h.bins.length).toBeGreaterThan(1)
    expect(h.bins.length).toBeLessThan(42)
    expect(h.rule).toBe('freedman_diaconis')
  })

  it('honours a manual width and says so', () => {
    const c = counts([[0, 1], [5, 1], [10, 1], [15, 1]])
    const h = binFrequencyCounts(c, { binWidth: 10 })
    expect(h.rule).toBe('manual')
    expect(h.binWidth).toBe(10)
    expect(h.bins.reduce((s, b) => s + b.count, 0)).toBe(4)
  })

  it('the LAST bin owns its upper edge, so the maximum is never dropped', () => {
    const c = counts([[0, 1], [10, 1]])
    const h = binFrequencyCounts(c, { binWidth: 5 })
    expect(h.bins.reduce((s, b) => s + b.count, 0)).toBe(2)
    expect(h.bins[h.bins.length - 1].count).toBeGreaterThan(0)
  })

  /**
   * ⚠️ The degenerate cases are the ones that matter: Freedman–Diaconis divides
   * by the interquartile range, and both of these make it zero or undefined.
   */
  it('all values identical — one bin, and it says so rather than dividing by zero', () => {
    const h = binFrequencyCounts(counts([[7, 40]]))
    expect(h.rule).toBe('single')
    expect(h.bins).toHaveLength(1)
    expect(h.bins[0].count).toBe(40)
    expect(Number.isFinite(h.binWidth)).toBe(true)
  })

  it('a zero IQR falls back to Sturges instead of producing a zero width', () => {
    // 98 observations on one value, two far outliers: Q1 === Q3, so FD gives 0.
    const h = binFrequencyCounts(counts([[10, 98], [80, 1], [90, 1]]))
    expect(h.rule).toBe('sturges')
    expect(h.binWidth).toBeGreaterThan(0)
    expect(h.bins.reduce((s, b) => s + b.count, 0)).toBe(100)
  })

  it('an empty distribution is empty, not a crash', () => {
    expect(binFrequencyCounts({}).bins).toEqual([])
    expect(binFrequencyCounts({ '5': 0 }).bins).toEqual([])
  })

  /**
   * 🔴 Non-numeric labels are REPORTED, never folded into a bin. A declared value
   * label on a numeric column ("Refused") has no position on a number line;
   * binning it would invent one and dropping it silently would understate the
   * distribution.
   */
  it('reports non-numeric labels instead of binning or silently dropping them', () => {
    const h = binFrequencyCounts({ '10': 5, '20': 5, 'Refused': 3, '': 2 })
    expect(h.skippedLabels).toContain('Refused')
    expect(h.skippedLabels).toContain('')
    expect(h.bins.reduce((s, b) => s + b.count, 0)).toBe(10)
    expect(describeHistogramBasis(h)).toMatch(/cannot be placed on a number line/)
  })

  it('names its own rule in the basis line — the stated-basis habit', () => {
    expect(describeHistogramBasis(binFrequencyCounts(
      counts(Array.from({ length: 30 }, (_, i) => [i, 2] as [number, number])),
    ))).toMatch(/Freedman–Diaconis/)
    expect(describeHistogramBasis(binFrequencyCounts(counts([[1, 2], [9, 2]]), { binWidth: 4 })))
      .toMatch(/set manually/)
  })

  it('caps the bin count so a pathological width cannot generate unbounded bars', () => {
    const h = binFrequencyCounts(counts([[0, 1], [1e6, 1]]), { binWidth: 0.001 })
    expect(h.bins.length).toBeLessThanOrEqual(MAX_HISTOGRAM_BINS)
  })
})

describe('shapeHistogramBars (#522) — no interval fields, structurally', () => {
  const metric = (counts: Record<string, number>) => ({
    id: 1, results: [{ result_data: {
      counts,
      // The payload queue #42 now sends. The shaper must NOT carry these through.
      ci_lower_by_label: { '10': 1, '20': 2 },
      ci_upper_by_label: { '10': 9, '20': 8 },
      ci_method: 'wilson_per_category',
    }, valid_n: 20 }],
  } as unknown as MetricDefinitionResponse)

  it('emits no ciLower/ciUpper, so the chart suppresses error bars with no flag', () => {
    const { bars } = shapeHistogramBars(metric({ '10': 10, '20': 10 }))
    expect(bars.length).toBeGreaterThan(0)
    for (const b of bars) {
      expect(b.ciLower).toBeUndefined()
      expect(b.ciUpper).toBeUndefined()
      expect(b.ciMethod).toBeUndefined()
    }
  })

  it('percentages are computed over the BINNED total, and sum to 100', () => {
    const { bars } = shapeHistogramBars(metric({ '10': 5, '20': 15 }))
    const sum = bars.reduce((s, b) => s + (b.percentage ?? 0), 0)
    expect(sum).toBeCloseTo(100, 6)
  })
})

/**
 * 🔴 #522 — the option-visibility map is the enumeration-debt hotspot for a new
 * chart type, and it does NOT fail to compile when one is added.
 *
 * Several of its expressions are NEGATIVE (`!isCrossTab`,
 * `chartType !== 'table'`), so an unlisted type silently inherits them. Two
 * would have been actively wrong on a histogram: `sort` (bins are ordered by
 * value — sorting by count scrambles the axis) and `excludeValues` (it operates
 * on the per-value labels that binning has just replaced).
 *
 * This is a POPULATION assertion, pinning the whole row rather than the options
 * that happened to be wrong today, because the risk is the 25th option added
 * later. Same shape as #771's "every button in an unselected row".
 */
describe('#522 — getVisibleOptions declares the FULL histogram row', () => {
  it('every option is decided, and the dangerous ones are off', () => {
    const vis = getVisibleOptions('histogram', 'frequency_distribution')
    expect(vis).toEqual({
      sort: false,                  // bins are ordered by value; nothing else is honest
      display: false,
      scaling: false,
      scaleOrder: false,            // a bin order is derived, not authored
      groupBy: false,
      groupFilter: false,
      groupOrganization: false,
      excludeValues: false,         // there are no per-value labels left to exclude
      hideFromChart: false,
      showCI: false,                // queue #42's intervals are PER CATEGORY
      sampleSizes: true,
      groupN: false,
      referenceLine: false,
      barSize: false,          // the bar width IS the bin width
      heatmapColor: false,
      colorPalette: true,
      responseColors: false,
      pointSize: false,
      dataWidth: false,
      proportionThreshold: false,
      dataLabels: true,
      dataLabelsInsideOnly: false,
      axisRange: false,
      divergingLayout: false,
      errorBand: false,
      lineStyle: false,
      lineOverlay: false,
      axisTransform: false,
      crossTabColumn: false,
      crossTabDisplay: false,
      binWidth: true,               // and it is the only type that gets this one
    })
  })

  it('no OTHER chart type offers the bin-width control', () => {
    const others = ['heatmap', 'horizontal_bar', 'stacked_bar', 'vertical_bar',
      'dumbbell', 'table', 'line', 'frequency_table', 'cross_tab'] as const
    for (const t of others) {
      expect(getVisibleOptions(t, 'frequency_distribution').binWidth).toBe(false)
      expect(getVisibleOptions(t, 'mean').binWidth).toBe(false)
    }
  })
})

describe('#522 — histogram availability', () => {
  const freq = 'frequency_distribution'

  it('is offered for ONE continuous variable', () => {
    const info = getApplicableChartTypes(freq, false, 1, true, true, 5)
    expect(info.available).toContain('histogram')
  })

  it('is visible-but-disabled with a REASON when the variable is not continuous', () => {
    const info = getApplicableChartTypes(freq, false, 1, true, false, 5)
    expect(info.available).not.toContain('histogram')
    expect(info.disabledReasons.histogram).toMatch(/continuous/i)
  })

  it('is visible-but-disabled with a REASON when several variables are selected', () => {
    const info = getApplicableChartTypes(freq, false, 3, true, true, 40)
    expect(info.available).not.toContain('histogram')
    expect(info.disabledReasons.histogram).toMatch(/single variable/i)
  })

  /**
   * The actual complaint in #522: a continuous score drew ~42 one-per-value
   * bars. Above the stated threshold the histogram is what you LAND on.
   */
  it('DEFAULTS to the histogram past the distinct-value threshold', () => {
    expect(getApplicableChartTypes(freq, false, 1, true, true, HISTOGRAM_DEFAULT_THRESHOLD + 1).default)
      .toBe('histogram')
  })

  it('does NOT default to it for a short numeric scale', () => {
    // A 1–5 Likert stored as numeric is a bar chart's job; binning would merge
    // response options the researcher chose.
    expect(getApplicableChartTypes(freq, false, 1, true, true, 5).default).not.toBe('histogram')
  })

  it('never defaults to it for a non-continuous variable, however many values', () => {
    expect(getApplicableChartTypes(freq, false, 1, true, false, 99).default).not.toBe('histogram')
  })
})

/**
 * #522 — the histogram's rendering conventions, pinned as a SOURCE SCAN.
 *
 * ⚠️ Technique-only, and the reason is worth stating: the defect was a LAYOUT
 * one (bars 24px wide in a ~195px band, 171px gaps) and **jsdom computes no
 * layout**, so no unit test in this suite could have seen it. It was found by a
 * developer looking at the chart, diagnosed by measuring the real rects in a
 * browser, and re-verified the same way (24px → 195px, 171px gaps → 0.1px, six
 * fills → one).
 *
 * What this scan CAN do is stop the three properties being silently dropped
 * from the source. Re-measure in a browser after touching the histogram branch;
 * a green suite here is not evidence that the bars are flush.
 */
describe('#522 — histogram rendering conventions (technique pin)', () => {
  const src = readFileSync(
    join(__dirname, '..', 'components', 'charts', 'VerticalBarChart.tsx'), 'utf8',
  )

  it('bars are flush: category gap zeroed AND no fixed bar size', () => {
    // Both are load-bearing — measurement showed the fixed barSize was ~88% of
    // the whitespace and the category gap the remainder, so either alone leaves
    // a visible gutter.
    expect(src).toMatch(/barCategoryGap=\{histogram \? 0 : undefined\}/)
    expect(src).toMatch(/barSize=\{histogram \? undefined : fmt\.barSize\}/)
  })

  it('one distribution is one colour, not one colour per bin', () => {
    expect(src).toMatch(/fill: histogram \? histogramFill :/)
    expect(src).toMatch(/const histogramFill = resolveColorPalette/)
  })

  it('flush bars carry a separator so adjacent bins stay distinguishable', () => {
    expect(src).toMatch(/stroke=\{histogram \? colors\.grid : undefined\}/)
  })

  /**
   * The runtime error the first attempt shipped: `histogramFill` was declared
   * AFTER the `chartData` map that reads it — a temporal-dead-zone throw that
   * tsc and the whole unit suite passed, and the chart replaced itself with
   * "Chart failed to render". Only the live re-check caught it.
   */
  it('histogramFill is declared BEFORE the chartData map that reads it', () => {
    const decl = src.indexOf('const histogramFill =')
    const use = src.indexOf('fill: histogram ? histogramFill')
    expect(decl).toBeGreaterThan(-1)
    expect(use).toBeGreaterThan(-1)
    expect(decl).toBeLessThan(use)
  })
})
