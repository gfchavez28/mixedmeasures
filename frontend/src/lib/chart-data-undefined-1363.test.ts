/**
 * #1363 — a statistic the server could not compute is NOT a zero.
 *
 * `compute_proportion` / `compute_mean` / `compute_domain_aggregate` send `None`
 * for `percentage` / `mean` / `aggregate_value` when no value survives
 * missing-data exclusion (valid_n 0). Every scalar shaper read that through
 * `?? 0`, so the chart drew — and the canvas export TABLED — a measured zero.
 *
 * Each case pairs the undefined result with a REAL zero, which must survive as 0
 * (the falsy-zero rule, `statistics.md` §1).
 */
import { describe, it, expect } from 'vitest'
import type { MetricDefinitionResponse } from './api'
import {
  shapeScalarBars, shapeGroupedScalarBars, shapeDumbbellRows, shapeLineChart,
  computeDumbbellAxis,
} from './chart-data'

type R = { group_value: string | null; valid_n: number; result_data: Record<string, unknown> }
const metric = (id: number, type: string, results: R[]): MetricDefinitionResponse =>
  ({ id, name: `m${id}`, metric_type: type, input_source_id: id, input_source_type: 'dataset_column', results } as unknown as MetricDefinitionResponse)

const UNDEF_PROP = { count_meeting: 0, proportion: null, percentage: null, ci_lower: null, ci_upper: null }
const ZERO_PROP = { count_meeting: 0, proportion: 0, percentage: 0, ci_lower: 0, ci_upper: 12.3 }
const UNDEF_MEAN = { mean: null, median: null, std_dev: null, min: null, max: null, ci_lower: null, ci_upper: null }

describe('#1363 — the shapers carry "no value" as null, never 0', () => {
  it('shapeScalarBars: an undefined proportion is null; a real 0% stays 0', () => {
    const bars = shapeScalarBars([
      metric(1, 'proportion', [{ group_value: null, valid_n: 0, result_data: UNDEF_PROP }]),
      metric(2, 'proportion', [{ group_value: null, valid_n: 40, result_data: ZERO_PROP }]),
    ])
    expect(bars.map(b => b.value)).toEqual([null, 0])
  })

  it('shapeScalarBars: an undefined variable-group score is null', () => {
    const bars = shapeScalarBars([
      metric(3, 'domain_aggregate', [{ group_value: null, valid_n: 0, result_data: { aggregate_value: null, child_results: {} } }]),
    ])
    expect(bars[0].value).toBeNull()
  })

  it('shapeScalarBars: carries the server reason when one is sent', () => {
    const bars = shapeScalarBars([
      metric(1, 'mean', [{ group_value: null, valid_n: 0, result_data: { ...UNDEF_MEAN, undefined_reason: 'insufficient_n' } }]),
    ])
    expect(bars[0].undefinedReason).toBe('insufficient_n')
  })

  it('shapeGroupedScalarBars: an empty group is null, a real zero mean is 0', () => {
    const [section] = shapeGroupedScalarBars([
      metric(1, 'mean', [
        { group_value: 'A', valid_n: 0, result_data: UNDEF_MEAN },
        { group_value: 'B', valid_n: 5, result_data: { mean: 0, std_dev: 1 } },
      ]),
    ], ['A', 'B'])
    expect(section.groups.map(g => [g.groupValue, g.value])).toEqual([['A', null], ['B', 0]])
  })

  it('shapeDumbbellRows: an empty group is a null dot, never a dot at 0', () => {
    const data = shapeDumbbellRows([
      metric(1, 'proportion', [
        { group_value: 'A', valid_n: 0, result_data: UNDEF_PROP },
        { group_value: 'B', valid_n: 9, result_data: { percentage: 0 } },
        { group_value: 'C', valid_n: 9, result_data: { percentage: 55.5 } },
      ]),
    ])
    expect(data.rows[0].dots.map(d => [d.groupValue, d.value])).toEqual([['A', null], ['B', 0], ['C', 55.5]])
  })

  it('computeDumbbellAxis: an undefined dot does not pull the axis to 0', () => {
    const data = shapeDumbbellRows([
      metric(1, 'mean', [
        { group_value: 'A', valid_n: 0, result_data: UNDEF_MEAN },
        { group_value: 'B', valid_n: 9, result_data: { mean: 50 } },
        { group_value: 'C', valid_n: 9, result_data: { mean: 60 } },
      ]),
    ])
    expect(computeDumbbellAxis(data.rows, { showCI: false }).xMin).toBeGreaterThan(0)
  })

  it('shapeLineChart: an undefined point, and a group a metric has no result for, are gaps', () => {
    const ungrouped = shapeLineChart([
      metric(1, 'mean', [{ group_value: null, valid_n: 0, result_data: UNDEF_MEAN }]),
      metric(2, 'mean', [{ group_value: null, valid_n: 3, result_data: { mean: 0 } }]),
    ])
    expect(ungrouped.series[0].points.map(p => p.value)).toEqual([null, 0])

    const grouped = shapeLineChart([
      metric(1, 'mean', [
        { group_value: 'A', valid_n: 3, result_data: { mean: 2 } },
        { group_value: 'B', valid_n: 3, result_data: { mean: 4 } },
      ]),
      metric(2, 'mean', [{ group_value: 'A', valid_n: 3, result_data: { mean: 5 } }]),
    ])
    const b = grouped.series.find(s => s.groupValue === 'B')!
    expect(b.points.map(p => p.value)).toEqual([4, null])
  })
})
