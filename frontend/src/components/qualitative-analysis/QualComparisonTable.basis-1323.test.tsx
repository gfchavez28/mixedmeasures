/**
 * #1323 — the comparison table reads its unit, its p and its stars from the basis.
 *
 * On `9dd1cd1b` the header said "n=60" (segments), the stars read the RAW p, and the
 * note said "Test: Chi-square test." whether or not a test ran (the 10-26 rider).
 */
import { describe, it, expect, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import QualComparisonTable from './QualComparisonTable'
import type { DemographicComparisonResponse } from '@/lib/api'
import { COMPARISON_RESTRAINT_SENTENCE } from '@/lib/comparison-basis'

afterEach(cleanup)

function payload(): DemographicComparisonResponse {
  const cell = (count: number, n: number, passages: number) =>
    ({ count, proportion: count / n, undefined_reason: null, passages })
  return {
    groups: ['Board', 'Staff'],
    group_totals: {
      Board: { n: 8, participants: 8, total_segments: 40, total_word_count: 0, without_coding: 0 },
      Staff: { n: 8, participants: 8, total_segments: 40, total_word_count: 0, without_coding: 0 },
    },
    codes: [
      { code_id: 1, code_name: 'Strong', category_name: null,
        by_group: { Board: cell(8, 8, 30), Staff: cell(0, 8, 0) }, delta_proportion: 1,
        test: { method: 'fisher_exact', statistic: null, p_value: 0.000155, p_adjusted: 0.000466,
                significant: true, effect_size: null, effect_size_label: null,
                min_attainable_p: 0.000155, can_reach_significance: true } },
      // Raw p under .05, adjusted over it: NO star (HEAD starred the raw p).
      { code_id: 2, code_name: 'Moderate', category_name: null,
        by_group: { Board: cell(6, 8, 9), Staff: cell(1, 8, 1) }, delta_proportion: 0.625,
        test: { method: 'fisher_exact', statistic: null, p_value: 0.040559, p_adjusted: 0.081119,
                significant: false, effect_size: 15, effect_size_label: 'odds_ratio',
                min_attainable_p: 0.000155, can_reach_significance: true } },
      // One user in all: p can only be 1 — the marker.
      { code_id: 3, code_name: 'Rare', category_name: null,
        by_group: { Board: cell(1, 8, 1), Staff: cell(0, 8, 0) }, delta_proportion: 0.125,
        test: { method: 'fisher_exact', statistic: null, p_value: 1, p_adjusted: 1,
                significant: false, effect_size: null, effect_size_label: null,
                min_attainable_p: 1, can_reach_significance: false } },
    ],
    basis: { unit: 'participant', correction: 'holm', family_size: 3, family_reachable: 2,
             tarone_family_size: 2, alpha: 0.05, tested_groups: ['Board', 'Staff'], test_omitted_reason: null },
    scope: { conversations: 1, documents: 0, text_columns: 0, observations_left_out: 0,
             unassigned_passages: 0, participants_without_group: 0, no_coding_scope: 'every' },
  }
}

/** Three groups, one code: Freeman–Halton (no statistic) unless `statistic` is given. */
function threeGroups(statistic: number | null): DemographicComparisonResponse {
  const cell = (count: number) => ({ count, proportion: count / 4, undefined_reason: null, passages: count })
  return {
    groups: ['Board', 'Staff', 'Volunteer'],
    group_totals: Object.fromEntries(['Board', 'Staff', 'Volunteer'].map(g =>
      [g, { n: 4, participants: 4, total_segments: 4, total_word_count: 0, without_coding: 0 }])),
    codes: [{
      code_id: 1, code_name: 'X', category_name: null,
      by_group: { Board: cell(3), Staff: cell(1), Volunteer: cell(0) }, delta_proportion: null,
      test: { method: statistic == null ? 'freeman_halton' : 'chi2', statistic, p_value: 0.1, p_adjusted: 0.1,
              significant: false, effect_size: 0.55, effect_size_label: 'cramers_v',
              min_attainable_p: 0.004, can_reach_significance: true },
    }],
    basis: { unit: 'participant', correction: 'discrete_holm', family_size: 1, family_reachable: 1,
             tarone_family_size: 1, alpha: 0.05, tested_groups: ['Board', 'Staff', 'Volunteer'],
             test_omitted_reason: null },
    scope: { conversations: 1, documents: 0, text_columns: 0, observations_left_out: 0,
             unassigned_passages: 0, participants_without_group: 0, no_coding_scope: 'every' },
  }
}

function cellsOf(code: string) {
  const row = screen.getByText(code).closest('tr')!
  return Array.from(row.querySelectorAll('td'))
}

describe('QualComparisonTable — the stated basis (#1323)', () => {
  it('names the unit in each group header', () => {
    render(<QualComparisonTable data={payload()} />)
    expect(screen.getAllByText('(n=8 participants)')).toHaveLength(2)
  })

  it('shows and stars the ADJUSTED p; the raw p is the cell description', () => {
    render(<QualComparisonTable data={payload()} />)
    // [code, category, B n, B %, S n, S %, Δ, p, sig, effect]
    const moderate = cellsOf('Moderate')
    expect(moderate[7].textContent).toBe('.081')    // HEAD: .041
    expect(moderate[8].textContent).toBe('')        // HEAD: "*"
    expect(moderate[7]).toHaveAttribute('title', expect.stringMatching(/before adjustment/))
    // Control: a code that survives the adjustment keeps its stars.
    expect(cellsOf('Strong')[8].textContent).toBe('***')
  })

  it('marks a code that cannot reach significance at these group sizes', () => {
    render(<QualComparisonTable data={payload()} />)
    expect(cellsOf('Rare')[8].textContent).toMatch(/can’t reach/)
    expect(cellsOf('Moderate')[8].textContent).not.toMatch(/can’t reach/)
  })

  it('writes the method note from the basis, never "Chi-square" by default', () => {
    render(<QualComparisonTable data={payload()} />)
    expect(screen.getByText(/adjusted across the 3 codes tested \(Holm\)/)).toBeInTheDocument()
    expect(screen.getByText(/1 of the 3 codes cannot reach p < \.05/)).toBeInTheDocument()
    expect(screen.queryByText(/Chi-square/)).not.toBeInTheDocument()
  })

  it('says the tests are exploratory (D13)', () => {
    render(<QualComparisonTable data={payload()} />)
    expect(screen.getByText(new RegExp(COMPARISON_RESTRAINT_SENTENCE.slice(0, 40)))).toBeInTheDocument()
  })
})

describe('QualComparisonTable — Δ carries its interval (#1323 D3)', () => {
  function withInterval(): DemographicComparisonResponse {
    const p = payload()
    p.codes[1] = { ...p.codes[1],
      delta_ci: { lower: 0.1704, upper: 0.8231, level: 0.95, method: 'newcombe_hybrid_score' } }
    return p
  }

  it('shows the interval under Δ, in the same cell, for the eye — and says it to a reader', () => {
    render(<QualComparisonTable data={withInterval()} />)
    const delta = cellsOf('Moderate')[6]
    expect(delta.textContent).toContain('+62.5pp')
    const visual = Array.from(delta.querySelectorAll('[aria-hidden="true"]')).map(e => e.textContent)
    expect(visual).toEqual(['[17.0, 82.3]'])
    expect(delta.querySelector('.sr-only')?.textContent)
      .toBe(' 95% confidence interval 17.0 to 82.3 percentage points (unadjusted)')
    // No new column: the row keeps its ten cells (640×360, IrrMatrix's rule).
    expect(cellsOf('Moderate')).toHaveLength(10)
  })

  it('titles the cell with what the interval is — not adjusted for the codes compared', () => {
    render(<QualComparisonTable data={withInterval()} />)
    expect(cellsOf('Moderate')[6]).toHaveAttribute('title', expect.stringMatching(/^95% CI \(unadjusted\).*not adjusted for the number of codes/))
  })

  it('control: a Δ the server sent no interval for shows none and claims none', () => {
    render(<QualComparisonTable data={withInterval()} />)
    const strong = cellsOf('Strong')[6]
    expect(strong.textContent).toBe('+100.0pp')
    expect(strong).not.toHaveAttribute('title')
  })
})

describe('QualComparisonTable — three groups take an exact test with no χ² (#1323 D8)', () => {
  it('draws no χ² column when no result carries a statistic', () => {
    render(<QualComparisonTable data={threeGroups(null)} />)
    expect(screen.queryByRole('columnheader', { name: 'χ²' })).not.toBeInTheDocument()
    // [code, category, B n, B %, S n, S %, V n, V %, p, sig, effect]
    expect(cellsOf('X')).toHaveLength(11)
    expect(screen.getByText(/Freeman–Halton exact test/)).toBeInTheDocument()
  })

  it('control: a result that carries a statistic still gets its χ² column', () => {
    render(<QualComparisonTable data={threeGroups(4.2)} />)
    expect(screen.getByRole('columnheader', { name: 'χ²' })).toBeInTheDocument()
    expect(cellsOf('X')).toHaveLength(12)
    expect(cellsOf('X')[8].textContent).toBe('4.20')
  })
})
