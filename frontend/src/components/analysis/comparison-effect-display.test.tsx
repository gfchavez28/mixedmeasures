/**
 * The effect size on a comparison SCREEN: the number, the word beside it, and
 * the header above it must all describe the same statistic.
 *
 * Two defects live here, one fixed and previously unguarded on this side:
 *
 * #742 — both surfaces display ω² for a one-way ANOVA and printed
 *   `effect_size_label` next to it, a word classified from η². ω² ≤ η² always,
 *   so any pair straddling a Cohen boundary showed one statistic's number under
 *   the other's verdict. The backend half is pinned in `test_comparisons.py`;
 *   the DISPLAY half had no test at all — neither component was mounted
 *   anywhere in the suite, so reverting the fix kept every gate green.
 *
 * #746 — the table chose its effect-size header and tooltip from the GROUP
 *   COUNT while the number came from the TEST. The sidebar lets a researcher
 *   pick either test at any group count, so both combinations are reachable.
 *
 * The fixture is the one from `test_comparisons.py::test_omega_squared_carries_
 * its_own_label` — three tight groups where η² = .3017 ("large") and
 * ω² = .1359 ("medium"), straddling the .14 boundary. A fixture where the two
 * statistics agree (mtcars: .73 vs .71, both "large") cannot see this defect at
 * all, which is why it survived.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

import ComparisonTestStrip from './ComparisonTestStrip'
import GroupComparisonTable from '@/components/charts/GroupComparisonTable'
import type { ComparisonRow, TestResult } from '@/lib/api'

afterEach(cleanup)

const SIG = { show_05: true, show_01: true, show_001: true }

function test_(overrides: Partial<TestResult> = {}): TestResult {
  return {
    test_type: 'one_way_anova',
    statistic: 3.8945,
    df: 2,
    df2: 9,
    p: 0.0602,
    // η² is "large" (≥ .14) …
    effect_size: 0.3017,
    effect_size_type: 'eta_squared',
    effect_size_label: 'large',
    // … while the ω² actually on screen is "medium".
    omega_squared: 0.1359,
    omega_squared_label: 'medium',
    post_hoc: null,
    effect_size_ci_lower: null,
    effect_size_ci_upper: null,
    ...overrides,
  }
}

function row(t: TestResult | null, groups: string[]): ComparisonRow {
  return {
    label: 'Wellbeing',
    full_label: 'Wellbeing (baseline)',
    source_id: 1,
    source_type: 'column',
    group_stats: groups.map((g, i) => ({
      group: g, n: 4, mean: 10 + i, sd: 1.29, median: 10 + i,
      ci_lower: null, ci_upper: null,
    })),
    test: t,
    test_omitted_reason: null,
  } as unknown as ComparisonRow
}

/** A row whose test did not run, carrying the reason the server gave. */
function omittedRow(reason: string, groups: string[]): ComparisonRow {
  return { ...row(null, groups), test_omitted_reason: reason } as ComparisonRow
}

const GROUPS_3 = ['a', 'b', 'c']
const GROUPS_2 = ['a', 'b']

describe('#742 — the word beside the number describes that number', () => {
  it('the strip labels ω² from ω², not from η²', () => {
    render(<ComparisonTestStrip rows={[row(test_(), GROUPS_3)]} sigLevels={SIG} />)
    const line = screen.getByText(/ω²/).textContent ?? ''
    expect(line).toContain('ω² = 0.14')
    expect(line).toContain('(medium)')
    // The defect: η²'s verdict printed beside ω²'s value.
    expect(line).not.toContain('(large)')
  })

  it('the table badges ω² from ω², not from η²', () => {
    render(<GroupComparisonTable groups={GROUPS_3} rows={[row(test_(), GROUPS_3)]} sigLevels={SIG} />)
    // `effectSizeBadge` ignores the value entirely when a label is supplied, so
    // this badge was purely eta-driven — the worse of the two surfaces.
    const cell = screen.getByTitle(/ω² = 0\.136/)
    expect(within(cell).getByText('0.14')).toBeInTheDocument()
    expect(cell.querySelector('span')?.className).toContain('amber')  // medium
    expect(cell.querySelector('span')?.className).not.toContain('red') // not large
  })

  it('falls back to η² and η²’s own label when the server sends no ω²', () => {
    const t = test_({ omega_squared: null, omega_squared_label: null })
    render(<ComparisonTestStrip rows={[row(t, GROUPS_3)]} sigLevels={SIG} />)
    const line = screen.getByText(/η²|ω²/).textContent ?? ''
    // Both halves move together: η²'s number gets η²'s word.
    expect(line).toContain('0.30')
    expect(line).toContain('(large)')
  })
})

describe('#746 — the header names the statistic printed under it', () => {
  it('a 3-group t-test is headed d, not ω²', () => {
    // Reachable: "Welch's t-test" is selectable at any group count, and the
    // service runs it on the first two groups. Cohen's d is what comes back.
    const t = test_({
      test_type: 'independent_t_test',
      effect_size: -0.6971,
      effect_size_type: 'cohens_d',
      effect_size_label: 'medium',
      omega_squared: null,
      omega_squared_label: null,
    })
    render(<GroupComparisonTable groups={GROUPS_3} rows={[row(t, GROUPS_3)]} sigLevels={SIG} />)

    const headers = screen.getAllByRole('columnheader').map(h => h.textContent?.trim())
    expect(headers).toContain('d')
    expect(headers).not.toContain('ω²')
    // …and the tooltip called it η², a number that cannot be negative.
    expect(screen.getByTitle(/Cohen's d = -0\.697/)).toBeInTheDocument()
    expect(screen.queryByTitle(/η² = -0\.697/)).toBeNull()
  })

  it('a 2-group ANOVA is headed ω², not d', () => {
    render(<GroupComparisonTable groups={GROUPS_2} rows={[row(test_(), GROUPS_2)]} sigLevels={SIG} />)

    const headers = screen.getAllByRole('columnheader').map(h => h.textContent?.trim())
    expect(headers).toContain('ω²')
    expect(headers).not.toContain('d')
    // Same convention as the 3-group branch: ANOVA shows ω², labelled from ω².
    const cell = screen.getByTitle(/ω² = 0\.136/)
    expect(within(cell).getByText('0.14')).toBeInTheDocument()
  })

  it('heads the column for the test `auto` would pick when no row computed one', () => {
    // Every row failing to compute is not a reason to mislabel the column.
    render(<GroupComparisonTable groups={GROUPS_3} rows={[row(null, GROUPS_3)]} sigLevels={SIG} />)
    expect(screen.getAllByRole('columnheader').map(h => h.textContent?.trim())).toContain('ω²')
  })

  it('keeps the non-parametric headers keyed to their own tests', () => {
    const mw = test_({
      test_type: 'mann_whitney_u', effect_size: 0.42, effect_size_type: 'rank_biserial_r',
      effect_size_label: 'medium', omega_squared: null, omega_squared_label: null,
    })
    render(
      <GroupComparisonTable
        groups={GROUPS_2} rows={[row(mw, GROUPS_2)]} sigLevels={SIG} nonparametric
      />,
    )
    expect(screen.getAllByRole('columnheader').map(h => h.textContent?.trim())).toContain('r')
  })
})

describe('#566 — a row that could not be tested says why', () => {
  it('replaces the blank test cells with the server\u2019s reason', () => {
    // The reported symptom: `satisfied` and `score` rendered blank delta/p/d
    // cells while `support` computed fully, and nothing on screen distinguished
    // an honest refusal from a broken tool. The commonest cause is a group left
    // with fewer than two usable values after missing-data exclusion.
    render(
      <GroupComparisonTable
        groups={GROUPS_2}
        rows={[omittedRow('insufficient_n', GROUPS_2)]}
        sigLevels={SIG}
      />,
    )
    expect(screen.getByText(/Too few values to compute this/)).toBeInTheDocument()
  })

  it('distinguishes an empty group from a group of one', () => {
    render(
      <GroupComparisonTable
        groups={GROUPS_2}
        rows={[omittedRow('empty_group', GROUPS_2)]}
        sigLevels={SIG}
      />,
    )
    // Different facts, different next actions — so different sentences.
    expect(screen.getByText(/No values in this group/)).toBeInTheDocument()
    expect(screen.queryByText(/Too few values/)).toBeNull()
  })

  it('says nothing rather than guessing when the reason is unrecognised', () => {
    render(
      <GroupComparisonTable
        groups={GROUPS_2}
        rows={[omittedRow('reason_from_a_newer_backend', GROUPS_2)]}
        sigLevels={SIG}
      />,
    )
    // Still renders (no crash), still shows the em dashes, invents no sentence.
    expect(screen.getAllByText('\u2014').length).toBeGreaterThan(0)
  })
})

describe('#689 — an empty group has no mean to show', () => {
  it('renders an em dash rather than a fabricated 0.00', () => {
    const r = row(null, GROUPS_2) as ComparisonRow
    r.group_stats[1] = {
      group: 'b', n: 0, mean: null, sd: null, median: null,
      ci_lower: null, ci_upper: null, undefined_reason: 'empty_group',
    }
    render(<GroupComparisonTable groups={GROUPS_2} rows={[r]} sigLevels={SIG} />)
    const cells = screen.getAllByRole('cell').map(c => c.textContent?.trim())
    // A mean of 0.00 with n = 0 is a measurement claim about people who are
    // not there — and it sorts and scales like a real value.
    expect(cells).not.toContain('0.00')
    expect(cells.filter(c => c === '\u2014').length).toBeGreaterThan(0)
  })
})
