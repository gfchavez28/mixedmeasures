/**
 * #1466 — a grouped frequency table is NAMED for its group (D131).
 *
 * Name-sweep run 15 (2026-10-29) measured, in Chrome's tree, `table "f1412-na: q1"`
 * twice — group A's table and group B's — because each `<caption>` held the
 * variable label alone and the group's name sat in a styled span above it. A
 * reader moving table to table could not tell them apart. The caption now ends
 * with the group as `sr-only` text, in the form the Canvas export already prints
 * for the same row (`shapeHeatmapRows`: "q1 (A)"), so nothing visible changes.
 */
import { describe, it, expect, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, cleanup } from '@testing-library/react'
import DetailedFrequencyTable from './DetailedFrequencyTable'
import { shapeHeatmapRows } from '@/lib/chart-data'
import type { MetricDefinitionResponse } from '@/lib/api'

afterEach(cleanup)

const res = (group_value: string | null, valid_n: number, counts: Record<string, number>) => {
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  const percentages = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, total ? (v / total) * 100 : null]))
  return { id: 0, group_value, valid_n, total_n: valid_n, computed_at: '', result_data: { percentages, counts, scale_order: L } }
}
const metric = (id: number, name: string, results: ReturnType<typeof res>[], grouped = true) =>
  ({ id, name, metric_type: 'frequency_distribution', input_source_id: id, input_source_type: 'dataset_column',
    grouping_column_id: grouped ? 4 : null, results } as unknown as MetricDefinitionResponse)
const L = ['Poor', 'Fair', 'Good']

const q1 = metric(1, 'q1', [
  res('A', 2, { Poor: 1, Fair: 0, Good: 1 }),
  res('B', 2, { Poor: 0, Fair: 2, Good: 0 }),
  res('C', 0, { Poor: 0, Fair: 0, Good: 0 }),
])
const q2 = metric(2, 'q2', [
  res('A', 1, { Poor: 0, Fair: 0, Good: 1 }),
  res('B', 1, { Poor: 1, Fair: 0, Good: 0 }),
])

describe('#1466 — DetailedFrequencyTable names each grouped table for its group', () => {
  it('group A\'s and group B\'s tables have different names, each ending in its group', () => {
    render(<DetailedFrequencyTable metrics={[q1]} />)
    const tables = screen.getAllByRole('table')
    expect(tables).toHaveLength(3)
    expect(tables[0]).toHaveAccessibleName('q1 (A)')
    expect(tables[1]).toHaveAccessibleName('q1 (B)')
    // C has no valid answer: #1412's sentence still follows, after the group.
    expect(tables[2]).toHaveAccessibleName('q1 (C) Valid %: — Not computable for this data.')
  })

  it('the group is for the ear only — the drawn caption is the variable, as before', () => {
    const { container } = render(<DetailedFrequencyTable metrics={[q1]} />)
    const caption = container.querySelector('caption')!
    const drawn = caption.cloneNode(true) as HTMLElement
    drawn.querySelectorAll('.sr-only').forEach(e => e.remove())
    expect(drawn.textContent?.trim()).toBe('q1')
    expect(caption.querySelector('.sr-only')!.textContent).toBe('(A)')
    // A positioned caption: the absolutely positioned sr-only text cannot escape it (#1156).
    expect(caption.className).toContain('relative')
  })

  it('several variables in a group: each table names its variable AND its group', () => {
    render(<DetailedFrequencyTable metrics={[q1, q2]} />)
    expect(screen.getByRole('table', { name: 'q2 (A)' })).toBeInTheDocument()
    expect(screen.getByRole('table', { name: 'q2 (B)' })).toBeInTheDocument()
    expect(screen.getByRole('table', { name: 'q1 (A)' })).toBeInTheDocument()
  })

  it('the name is the export\'s own label for the same row', () => {
    const rows = shapeHeatmapRows([q1])
    expect(rows.rows.map(r => r.label).slice(0, 2)).toEqual(['q1 (A)', 'q1 (B)'])
  })

  it('an ungrouped table is named by its variable alone (positive control)', () => {
    const solo = metric(3, 'q3', [res(null, 2, { Poor: 1, Fair: 1, Good: 0 })], false)
    render(<DetailedFrequencyTable metrics={[solo]} />)
    expect(screen.getByRole('table')).toHaveAccessibleName('q3')
  })
})
