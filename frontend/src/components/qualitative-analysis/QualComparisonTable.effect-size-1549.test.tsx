/**
 * #1549 (a) — the comparison table's effect cell.
 *
 * On `59a4fe25` the cell read `if (!test?.effect_size …)`, so a real Cramér's V of 0
 * printed "–" like a missing one; an odds ratio below 1 was sized as `|OR|`, so a
 * strong association against the first group (OR 0.1, as large as OR 10) got no badge
 * and sorted as negligible; and a row with no effect sorted as an effect of 0.
 */
import { describe, it, expect, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import QualComparisonTable from './QualComparisonTable'
import type { DemographicComparisonResponse, StatTestResult } from '@/lib/api'
import { NO_VALUE, describeUndefined } from '@/lib/stat-format'

afterEach(cleanup)

const test_ = (over: Partial<StatTestResult>): StatTestResult => ({
  method: 'fisher_exact', statistic: null, p_value: 0.2, p_adjusted: 0.2, significant: false,
  effect_size: null, effect_size_label: 'odds_ratio', min_attainable_p: 0.01,
  can_reach_significance: true, ...over,
})

function twoGroups(rows: [string, StatTestResult | null][]): DemographicComparisonResponse {
  const cell = (count: number) => ({ count, proportion: count / 8, undefined_reason: null, passages: count })
  return {
    groups: ['Board', 'Staff'],
    group_totals: {
      Board: { n: 8, participants: 8, total_segments: 8, total_word_count: 0, without_coding: 0 },
      Staff: { n: 8, participants: 8, total_segments: 8, total_word_count: 0, without_coding: 0 },
    },
    codes: rows.map(([name, t], i) => ({
      code_id: i + 1, code_name: name, category_name: null,
      by_group: { Board: cell(3), Staff: cell(2) }, delta_proportion: 0.125, test: t,
    })),
    basis: { unit: 'participant', correction: 'discrete_holm', family_size: rows.length, family_reachable: 1,
             tarone_family_size: 1, alpha: 0.05, tested_groups: ['Board', 'Staff'], test_omitted_reason: null },
    scope: { conversations: 1, documents: 0, text_columns: 0, observations_left_out: 0,
             unassigned_passages: 0, participants_without_group: 0, no_coding_scope: 'every' },
  }
}

function threeGroupsV(v: number): DemographicComparisonResponse {
  const cell = (count: number) => ({ count, proportion: count / 2, undefined_reason: null, passages: count })
  return {
    groups: ['A', 'B', 'C'],
    group_totals: Object.fromEntries(['A', 'B', 'C'].map(g =>
      [g, { n: 2, participants: 2, total_segments: 2, total_word_count: 0, without_coding: 0 }])),
    codes: [{
      code_id: 1, code_name: 'Even', category_name: null,
      by_group: { A: cell(1), B: cell(1), C: cell(1) }, delta_proportion: null,
      test: { method: 'freeman_halton', statistic: null, p_value: 1, p_adjusted: 1, significant: false,
              effect_size: v, effect_size_label: 'cramers_v', min_attainable_p: 0.1, can_reach_significance: false },
    }],
    basis: { unit: 'participant', correction: 'discrete_holm', family_size: 1, family_reachable: 0,
             tarone_family_size: 0, alpha: 0.05, tested_groups: ['A', 'B', 'C'], test_omitted_reason: null },
    scope: { conversations: 1, documents: 0, text_columns: 0, observations_left_out: 0,
             unassigned_passages: 0, participants_without_group: 0, no_coding_scope: 'every' },
  }
}

const effectCell = (code: string) => {
  const cells = screen.getByText(code).closest('tr')!.querySelectorAll('td')
  return cells[cells.length - 1] as HTMLElement
}
const codeOrder = () => screen.getAllByRole('row').slice(1)
  .map(r => r.querySelector('td')?.textContent?.trim()).filter(Boolean)

describe('QualComparisonTable — the effect cell (#1549 a)', () => {
  it("shows a real Cramér's V of 0 as a number", () => {
    render(<QualComparisonTable data={threeGroupsV(0)} />)
    expect(effectCell('Even')).toHaveTextContent('0.00')
  })

  it('shows an undefined odds ratio as the missing mark, with the reason said once', () => {
    render(<QualComparisonTable data={twoGroups([
      ['OnlyStaff', test_({ effect_size: null, effect_size_undefined_reason: 'zero_cell' })],
      ['AlsoZero', test_({ effect_size: null, effect_size_undefined_reason: 'zero_cell' })],
      ['Ordinary', test_({ effect_size: 2.0 })],
    ])} />)
    const cell = effectCell('OnlyStaff')
    expect(cell).toHaveTextContent(NO_VALUE)
    const sentence = describeUndefined('zero_cell')!
    expect(sentence).toMatch(/0 or infinite/)
    expect(cell).toHaveAttribute('title', sentence)
    // Visible text, ONCE — not per row, and not left to a title.
    const notes = screen.getAllByText(new RegExp(sentence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    expect(notes).toHaveLength(1)
    expect(notes[0]).toHaveTextContent(`OR ${NO_VALUE}:`)
  })

  it('says nothing below the table when every effect has a value (control)', () => {
    const { container } = render(<QualComparisonTable data={twoGroups([['Ordinary', test_({ effect_size: 2 })]])} />)
    expect(container.querySelector('[data-undefined-statistic]')).toBeNull()
  })

  it('keeps "–" for a row with no test at all', () => {
    render(<QualComparisonTable data={twoGroups([['NoTest', null], ['Ordinary', test_({ effect_size: 2 })]])} />)
    expect(effectCell('NoTest')).toHaveTextContent('–')
  })

  it('sizes an odds ratio below 1 as its reciprocal', () => {
    render(<QualComparisonTable data={twoGroups([
      ['Against', test_({ effect_size: 0.2 })],   // as large as OR 5
      ['For', test_({ effect_size: 5 })],
    ])} />)
    const badge = (code: string) => within(effectCell(code)).getByText(/\d/)
    expect(badge('Against').className).toBe(badge('For').className)
    expect(badge('Against').className).toMatch(/red/)
  })

  it('sorts by size on the odds-ratio scale, and a row with no effect last both ways', () => {
    render(<QualComparisonTable data={twoGroups([
      ['Small', test_({ effect_size: 1.6 })],
      ['None', test_({ effect_size: null, effect_size_undefined_reason: 'zero_cell' })],
      ['Against', test_({ effect_size: 0.1 })],     // |ln| 2.30 — the largest
      ['Medium', test_({ effect_size: 3 })],
    ])} />)
    const sortBy = () => fireEvent.click(screen.getByRole('button', { name: /Effect/ }))
    sortBy()   // a new key sorts descending first
    expect(codeOrder()).toEqual(['Against', 'Medium', 'Small', 'None'])
    sortBy()   // ascending
    expect(codeOrder()).toEqual(['Small', 'Medium', 'Against', 'None'])
  })
})
