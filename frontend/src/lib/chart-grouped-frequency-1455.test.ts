/**
 * #1455 — a grouped vertical frequency chart drew only the FIRST group's categories.
 *
 * Each group's result carries its own `scale_order` (`services/metrics.py::
 * compute_frequency_distribution`): with no declared labels, only the values THAT
 * group saw. `VerticalBarChart` takes its x-axis from the first group's bars, so a
 * value only a later group gave was never drawn — EXECUTED at the re-check: A {3, 6},
 * B {4, 6} drew "3" and "6", and B's bars summed to 50%. The shaper now gives every
 * visible group the union, zero-filled, in the server's own order.
 *
 * Ordering cases use values ≥ 10 (#406: string order equals numeric order for 1–9).
 */
import { describe, it, expect } from 'vitest'
import type { MetricDefinitionResponse } from '@/lib/api'
import { shapeFrequencyBarFigure, shapeGroupedFrequencyBars, type GroupedFrequencySection } from './chart-data'

type Answer = Record<string, number>

/** One group's frequency result as the server sends it: percentages over the group's own n. */
const result = (group_value: string | null, scale_order: string[], counts: Answer, extra: Record<string, unknown> = {}) => {
  const n = Object.values(counts).reduce((s, c) => s + c, 0)
  return {
    group_value,
    valid_n: n,
    result_data: {
      scale_order,
      counts,
      percentages: Object.fromEntries(Object.entries(counts).map(([k, c]) => [k, (c / n) * 100])),
      ...extra,
    },
  }
}

const metric = (results: unknown[]) =>
  ({ id: 1, name: 'score', input_source_label: 'score', metric_type: 'frequency_distribution', grouping_column_id: 9, results }) as unknown as MetricDefinitionResponse

function section(results: unknown[], options?: Parameters<typeof shapeFrequencyBarFigure>[1]): GroupedFrequencySection {
  const fig = shapeFrequencyBarFigure([metric(results)], options)
  if (fig.kind !== 'grouped') throw new Error('expected a grouped figure')
  return fig.section
}

const labels = (s: GroupedFrequencySection) => s.groups.map(g => g.bars.map(b => b.label))
const bar = (s: GroupedFrequencySection, group: string, label: string) =>
  s.groups.find(g => g.groupValue === group)!.bars.find(b => b.label === label)

/** The re-check's fixture: a numeric variable with no value labels. */
const r2 = () => [
  result('A', ['3', '6'], { 3: 1, 6: 1 }),
  result('B', ['4', '6'], { 4: 1, 6: 1 }),
]

describe('#1455 — every visible group is drawn over the same categories', () => {
  it('the re-check fixture: both groups get 3, 4, 6, and every answer is drawn', () => {
    const s = section(r2())
    expect(labels(s)).toEqual([['3', '4', '6'], ['3', '4', '6']])
    // B's 50% at "4" is the bar that was never drawn; each group's bars now sum to 100%.
    expect(s.groups.map(g => g.bars.map(b => b.value))).toEqual([[50, 0, 50], [0, 50, 50]])
  })

  it('a category a group never gave is a zero bar over that group’s own n, with no invented interval', () => {
    const s = section(r2())
    expect(bar(s, 'A', '4')).toMatchObject({ value: 0, count: 0, percentage: 0, n: 2 })
    expect(bar(s, 'A', '4')!.ciLower).toBeUndefined()
    expect(bar(s, 'B', '3')).toMatchObject({ value: 0, count: 0, percentage: 0, n: 2 })
  })

  it('the drawn numbers of the answers each group DID give are unchanged', () => {
    const s = section(r2())
    expect(bar(s, 'A', '3')).toMatchObject({ value: 50, count: 1, n: 2 })
    expect(bar(s, 'A', '6')).toMatchObject({ value: 50, count: 1, n: 2 })
    expect(bar(s, 'B', '6')).toMatchObject({ value: 50, count: 1, n: 2 })
  })

  it('undeclared values come out in VALUE order, not string order or first-seen order', () => {
    // First seen: 12, 30, 2, 9. As strings: 12, 2, 30, 9.
    const s = section([
      result('A', ['12', '30'], { 12: 1, 30: 1 }),
      result('B', ['2', '9'], { 2: 1, 9: 1 }),
    ])
    expect(labels(s)).toEqual([['2', '9', '12', '30'], ['2', '9', '12', '30']])
  })

  it('a declared scale keeps its order, with the values it never named after it in value order', () => {
    const scale = ['Strongly disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly agree']
    const zero = Object.fromEntries(scale.map(l => [l, 0]))
    const s = section([
      result('A', [...scale, '10'], { ...zero, Agree: 3, 10: 1 }),
      result('B', [...scale, '9'], { ...zero, Disagree: 2, 9: 1 }),
    ])
    expect(labels(s)[0]).toEqual([...scale, '9', '10'])
    expect(labels(s)[1]).toEqual(labels(s)[0])
  })

  it('identical lists are drawn exactly as they were', () => {
    const scale = ['Never', 'Sometimes', 'Often', 'Always']
    const zero = Object.fromEntries(scale.map(l => [l, 0]))
    const s = section([
      result('A', scale, { ...zero, Often: 2 }),
      result('B', scale, { ...zero, Never: 1 }),
    ])
    expect(labels(s)).toEqual([scale, scale])
  })

  it('hidden labels and the reversed scale apply to the union', () => {
    expect(labels(section(r2(), { hiddenLabels: ['3'] }))).toEqual([['4', '6'], ['4', '6']])
    expect(labels(section(r2(), { reverseScale: true }))).toEqual([['6', '4', '3'], ['6', '4', '3']])
  })

  it('the missing-group bucket is not a visible group and adds no category', () => {
    const s = section([result(null, ['99'], { 99: 1 }), ...r2()])
    expect(s.groups.map(g => g.groupValue)).toEqual(['A', 'B'])
    expect(labels(s)).toEqual([['3', '4', '6'], ['3', '4', '6']])
  })

  it('a hidden group adds no category either', () => {
    const s = section(r2(), { hiddenGroupValues: ['B'] })
    expect(labels(s)).toEqual([['3', '6']])
  })

  it('a group with no result keeps no bars', () => {
    const s = shapeGroupedFrequencyBars(metric(r2()), ['A', 'missing', 'B'])
    expect(s.groups.map(g => g.bars.length)).toEqual([3, 0, 3])
  })

  it('orders that disagree (an old or edited result) still merge, each label once', () => {
    const s = section([
      result('A', ['x', 'y'], { x: 1, y: 1 }),
      result('B', ['y', 'x'], { x: 1, y: 1 }),
    ])
    expect(labels(s)).toEqual([['x', 'y'], ['x', 'y']])
  })
})
