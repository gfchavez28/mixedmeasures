/**
 * 1.5.9 session A's client half (#1329 D51, #1326 STAT-12 D58).
 *
 * - A group with one value: its SD cell says why it is empty (the title read
 *   "SD = null"), and the table says — once per row — that the group is shown
 *   and left out of the tests. The server names the groups (`untested_groups`);
 *   nothing here re-derives them from the sizes.
 * - Mann–Whitney's p states the method the data chose (`p_method`), in the
 *   cell's title AND as text a screen reader reaches, and the footer says it.
 * - A payload that predates both fields says neither.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

import GroupComparisonTable from './GroupComparisonTable'
import ComparisonTestStrip from '@/components/analysis/ComparisonTestStrip'
import type { ComparisonRow, TestResult } from '@/lib/api'
import { SINGLE_VALUE_SD_NOTE } from '@/lib/untested-groups'

afterEach(cleanup)

const SIG = { show_05: true, show_01: true, show_001: true }

function anova(): TestResult {
  return {
    test_type: 'one_way_anova', statistic: 104.4298, df: 1, df2: 9, p: 0.000003,
    effect_size: 0.92, effect_size_type: 'eta_squared', effect_size_label: 'large',
    omega_squared: 0.91, omega_squared_label: 'large', post_hoc: null,
    effect_size_ci_lower: null, effect_size_ci_upper: null,
  }
}

function mw(method: string | undefined): TestResult {
  return {
    test_type: 'mann_whitney_u', statistic: 22, df: 18, df2: null, p: 0.035463,
    effect_size: 0.56, effect_size_type: 'rank_biserial_r', effect_size_label: 'large',
    omega_squared: null, omega_squared_label: null, post_hoc: null,
    effect_size_ci_lower: null, effect_size_ci_upper: null,
    ...(method === undefined ? {} : { p_method: method }),
  }
}

function abcRow(untested: string[] | undefined): ComparisonRow {
  return {
    label: 'Score', full_label: 'Score', source_id: 1, source_type: 'column',
    group_stats: [
      { group: 'A', n: 6, mean: 3.2, sd: 0.25, median: 3.15, ci_lower: 2.9, ci_upper: 3.5, undefined_reason: null },
      { group: 'B', n: 5, mean: 4.76, sd: 0.23, median: 4.7, ci_lower: 4.5, ci_upper: 5.0, undefined_reason: null },
      { group: 'C', n: 1, mean: 3.9, sd: null, median: 3.9, ci_lower: null, ci_upper: null, undefined_reason: 'insufficient_n' },
    ],
    test: anova(),
    test_omitted_reason: null,
    ...(untested === undefined ? {} : { untested_groups: untested }),
  }
}

function mwRow(method: string | undefined): ComparisonRow {
  return {
    label: 'v', full_label: 'v', source_id: 2, source_type: 'column',
    group_stats: [
      { group: 'x', n: 10, mean: 10, sd: 6, median: 10, ci_lower: null, ci_upper: null, undefined_reason: null },
      { group: 'y', n: 10, mean: 16, sd: 5, median: 17, ci_lower: null, ci_upper: null, undefined_reason: null },
    ],
    test: mw(method), test_omitted_reason: null, untested_groups: [],
  }
}

describe('#1329 — a one-value group is shown and said to be left out', () => {
  it('the table says which group its tests left out', () => {
    render(<GroupComparisonTable groups={['A', 'B', 'C']} rows={[abcRow(['C'])]} sigLevels={SIG} />)
    expect(screen.getByTestId('untested-groups-notes')).toHaveTextContent(
      'C has only one value, so it is shown without an SD and left out of the tests.')
  })

  it('the empty SD cell says why, never "SD = null"', () => {
    render(<GroupComparisonTable groups={['A', 'B', 'C']} rows={[abcRow(['C'])]} sigLevels={SIG} />)
    const table = screen.getByRole('table', { name: 'Group comparison statistics' })
    expect(within(table).getByTitle(SINGLE_VALUE_SD_NOTE)).toHaveTextContent('—')
    expect(within(table).queryByTitle('SD = null')).toBeNull()
    // Positive control: a real SD still titles itself.
    expect(within(table).getByTitle('SD = 0.25')).toBeInTheDocument()
  })

  it('several rows name their variable', () => {
    const second = { ...abcRow(['C']), label: 'Other', source_id: 9 }
    render(<GroupComparisonTable groups={['A', 'B', 'C']} rows={[abcRow(['C']), second]} sigLevels={SIG} />)
    const notes = screen.getByTestId('untested-groups-notes')
    expect(notes).toHaveTextContent('Score: C has only one value')
    expect(notes).toHaveTextContent('Other: C has only one value')
  })

  it('an older payload, or a row that leaves nobody out, says nothing', () => {
    render(<GroupComparisonTable groups={['A', 'B', 'C']} rows={[abcRow(undefined)]} sigLevels={SIG} />)
    expect(screen.queryByTestId('untested-groups-notes')).toBeNull()
    cleanup()
    render(<GroupComparisonTable groups={['A', 'B', 'C']} rows={[abcRow([])]} sigLevels={SIG} />)
    expect(screen.queryByTestId('untested-groups-notes')).toBeNull()
  })

  it('the chart strip says it too', () => {
    render(<ComparisonTestStrip rows={[abcRow(['C'])]} sigLevels={SIG} />)
    expect(screen.getByText(/C has only one value/)).toBeInTheDocument()
  })
})

describe('#1326 STAT-12 — a Mann–Whitney p says how it was computed', () => {
  it('the cell names its method in text a screen reader reaches, and the footer says it', () => {
    render(<GroupComparisonTable groups={['x', 'y']} rows={[mwRow('exact')]} sigLevels={SIG} nonparametric />)
    const table = screen.getByRole('table', { name: 'Group comparison statistics' })
    const pCell = within(table).getByText(/\(exact p\)/).closest('td')!
    expect(pCell).toHaveAttribute('title', expect.stringContaining('(exact p)'))
    expect(screen.getByText(/Mann-Whitney U test — exact p/)).toBeInTheDocument()
  })

  it('the strip carries the method beside the p', () => {
    render(<ComparisonTestStrip rows={[mwRow('normal_approximation')]} sigLevels={SIG} nonparametric />)
    expect(screen.getByText(/normal approximation, continuity-corrected/)).toBeInTheDocument()
  })

  it('a payload with no method says none', () => {
    render(<GroupComparisonTable groups={['x', 'y']} rows={[mwRow(undefined)]} sigLevels={SIG} nonparametric />)
    expect(screen.queryByText(/exact p/)).toBeNull()
    expect(screen.getByText('Mann-Whitney U test')).toBeInTheDocument()
  })
})
