/**
 * #591 — a cross-tab shows declared levels nobody chose, and says so when the
 * statistic could not use them.
 *
 * The table and the chi-square legitimately differ in dimension: a structural
 * zero is exactly what a declared scale exists to express, while scipy refuses
 * the all-zero row it produces. Leaving the reader to reverse-engineer that from
 * df is the kind of quiet mismatch this project keeps finding (#506, #746) — so
 * the payload carries `omitted_levels` and the caveat renders beside the number
 * it qualifies.
 *
 * ⚠️ The caveat is deliberately OUTSIDE the APA string, which stays quotable.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// The real ThemeProvider reads localStorage and `window.matchMedia`, which jsdom
// does not provide (the AllNotesPanel.test stub, one level down). Mock the hook
// the component actually calls — stubbing `useTheme` alone does not help,
// because `useChartColors` resolves it inside the module's own closure.
vi.mock('@/lib/theme-context', async (orig) => {
  const { CHART_COLORS } = await import('@/lib/chart-data')
  return {
    ...(await orig<typeof import('@/lib/theme-context')>()),
    useChartColors: () => CHART_COLORS,
  }
})

import AnalysisCrossTabTable from './AnalysisCrossTabTable'
import type { AnalysisCrossTabResponse } from '@/lib/api'

const cell = (count: number) => ({ count, row_pct: 0, col_pct: 0, total_pct: 0 })

/** Low / Neutral / High × A / B, where "Neutral" was declared and never chosen. */
const data = (over: Partial<AnalysisCrossTabResponse> = {}): AnalysisCrossTabResponse => ({
  row_values: ['Low', 'Neutral', 'High'],
  col_values: ['A', 'B'],
  matrix: [
    [cell(2), cell(1)],
    [cell(0), cell(0)],
    [cell(1), cell(2)],
  ],
  row_totals: [3, 0, 3],
  col_totals: [3, 3],
  n_shared: 6,
  row_column_label: 'Satisfaction',
  col_column_label: 'Group',
  chi_square: {
    statistic: 0.667,
    p_value: 0.414,
    df: 1,
    cramers_v: 0.333,
    undefined_reason: null,
    omitted_levels: 1,
  },
  ...over,
}) as AnalysisCrossTabResponse

afterEach(cleanup)

const show = (d: AnalysisCrossTabResponse) => render(<AnalysisCrossTabTable data={d} />)

describe('AnalysisCrossTabTable — #591', () => {
  it('renders the declared level nobody chose as a row of zeros', () => {
    show(data())
    expect(screen.getByRole('row', { name: /^Neutral\b/ })).toBeInTheDocument()
  })

  it('says how many levels the statistic could not use', () => {
    show(data())
    expect(screen.getByText(/1 empty level excluded/)).toBeInTheDocument()
  })

  it('pluralises, because two empty levels is the same defect twice', () => {
    show(data({ chi_square: { ...data().chi_square!, omitted_levels: 2 } }))
    expect(screen.getByText(/2 empty levels excluded/)).toBeInTheDocument()
  })

  it('stays silent on an ordinary table', () => {
    // Two-sided: a caveat on every cross-tab is noise that trains the reader to
    // skip it — the #726 "standing banner" failure mode.
    show(data({ chi_square: { ...data().chi_square!, omitted_levels: 0 } }))
    expect(screen.queryByText(/excluded/)).not.toBeInTheDocument()
  })

  it('treats an older payload with no field as nothing omitted', () => {
    const older = data()
    delete (older.chi_square as { omitted_levels?: number }).omitted_levels
    show(older)
    expect(screen.queryByText(/excluded/)).not.toBeInTheDocument()
  })

  it('keeps the APA string itself quotable', () => {
    show(data())
    // The caveat is a sibling span, so the statistic reads cleanly on its own.
    expect(screen.getByText(/χ²\(1\) = 0\.67/)).toBeInTheDocument()
  })
})

/**
 * #709 — the sparsity disclosure.
 *
 * `chi2_contingency` was already computing the expected-frequency table and
 * discarding it, so chi-square shipped with no statement that it is a
 * large-sample approximation. The figures render beside the statistic and, like
 * #591's caveat, deliberately OUTSIDE the quotable APA string.
 */
describe('AnalysisCrossTabTable — #709 expected counts', () => {
  const sparse = (over: Record<string, unknown> = {}) =>
    data({
      chi_square: {
        ...data().chi_square!,
        omitted_levels: 0,
        low_expected_warning: true,
        cells_below_5: 3,
        cell_count: 4,
        min_expected: 0.75,
        fisher_exact_p: 1,
        ...over,
      },
    } as Partial<AnalysisCrossTabResponse>)

  it('shows the figures, not just a verdict', () => {
    show(sparse())
    // "3 of 4 cells" is what lets a reader judge the warning; a bare
    // "counts may be too small" is what readers learn to dismiss.
    expect(screen.getByText(/3 of 4 cells below 5/)).toBeInTheDocument()
    expect(screen.getByText(/smallest 0\.75/)).toBeInTheDocument()
  })

  it("offers Fisher's exact on a 2x2 and names it as a different test", () => {
    show(sparse())
    // Twice, deliberately: the p-value sits beside chi-square's own so the two
    // can be compared, and the caveat points back at it rather than repeating
    // the number. Neither replaces the chi-square result.
    expect(screen.getByText(/; Fisher's exact p = 1\.000/)).toBeInTheDocument()
    expect(screen.getByText(/Fisher's exact, shown above, makes no such assumption/))
      .toBeInTheDocument()
  })

  it('omits Fisher entirely when the shape does not support it', () => {
    // scipy has no r × c Fisher. Absent must read as absent — never as a silent
    // reuse of chi-square's own p under another test's name.
    show(sparse({ fisher_exact_p: null }))
    expect(screen.queryByText(/Fisher's exact/)).not.toBeInTheDocument()
    expect(screen.getByText(/the chi-square approximation is unreliable/)).toBeInTheDocument()
  })

  it('stays silent on a well-powered table', () => {
    show(sparse({ low_expected_warning: false }))
    expect(screen.queryByText(/Small expected counts/)).not.toBeInTheDocument()
  })

  it('treats an older payload with no field as no warning', () => {
    const older = data()
    show(older)
    expect(screen.queryByText(/Small expected counts/)).not.toBeInTheDocument()
  })

  it('degrades to the short form when the flag arrives without its figures', () => {
    // Defensive rather than hypothetical: the flag and the figures are separate
    // payload fields, and "0 of 0 cells" would be a worse statement than none.
    show(sparse({ cells_below_5: undefined, cell_count: undefined, min_expected: null }))
    expect(screen.getByText(/Small expected counts \(below 5\)/)).toBeInTheDocument()
    expect(screen.queryByText(/of 0 cells/)).not.toBeInTheDocument()
  })

  it('keeps the APA string quotable', () => {
    show(sparse())
    expect(screen.getByText(/χ²\(1\) = 0\.67/)).toBeInTheDocument()
  })
})
