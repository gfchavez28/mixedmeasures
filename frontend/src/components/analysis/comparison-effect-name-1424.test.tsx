/**
 * #1424 — the comparison table and strip NAME the effect size from the wire's
 * `effect_size_type`, never from the test type or the group count (the stated-basis rule:
 * the server says which statistic it sent; the client displays that and never infers it).
 *
 * Every real payload today pairs one test with one effect size, so a fixture that agrees
 * cannot tell the two sources apart. These hand the components a payload where the test
 * and the effect-size type DISAGREE, or where the type is one this client does not know,
 * and ask which one the name follows. ANOVA's ω² stays the deliberate override (the UI
 * displays ω², the primary field is η² — `statistics.md` §3).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

import ComparisonTestStrip from './ComparisonTestStrip'
import GroupComparisonTable from '@/components/charts/GroupComparisonTable'
import type { ComparisonRow, TestResult } from '@/lib/api'

afterEach(cleanup)

const SIG = { show_05: true, show_01: true, show_001: true }
const GROUPS_2 = ['a', 'b']
const GROUPS_3 = ['a', 'b', 'c']

function t(overrides: Partial<TestResult>): TestResult {
  return {
    test_type: 'independent_t_test', statistic: 2.5, df: 14.2, df2: null, p: 0.024,
    effect_size: 0.62, effect_size_type: 'cohens_d', effect_size_label: 'medium',
    omega_squared: null, omega_squared_label: null, post_hoc: null,
    effect_size_ci_lower: null, effect_size_ci_upper: null,
    ...overrides,
  }
}

function row(test: TestResult, groups: string[]): ComparisonRow {
  return {
    label: 'Wellbeing', full_label: 'Wellbeing', source_id: 1, source_type: 'column',
    group_stats: groups.map((g, i) => ({
      group: g, n: 8, mean: 3 + i, sd: 1, median: 3 + i, ci_lower: null, ci_upper: null, undefined_reason: null,
    })),
    test, test_omitted_reason: null,
  } as ComparisonRow
}

const headers = () => screen.getAllByRole('columnheader').map(h => h.textContent?.trim())

describe('#1424 — an effect-size type this client does not know is never called d', () => {
  const unknown = t({ effect_size_type: 'hedges_g', effect_size: 0.6, effect_size_label: null })

  it('the strip calls it "ES", not d', () => {
    const { container } = render(<ComparisonTestStrip rows={[row(unknown, GROUPS_2)]} sigLevels={SIG} />)
    expect(container.textContent).toContain('ES = 0.60')
    expect(container.textContent).not.toContain('d = 0.60')
  })

  it('the table heads it "ES" and titles it "effect size", not d / Cohen’s d', () => {
    render(<GroupComparisonTable groups={GROUPS_2} rows={[row(unknown, GROUPS_2)]} sigLevels={SIG} />)
    expect(headers()).toContain('ES')
    expect(headers()).not.toContain('d')
    expect(screen.getByTitle(/^effect size = 0\.600/)).toBeInTheDocument()
  })

  it('the rank-test cells name it from the wire too, not from the group count', () => {
    const mw = t({ test_type: 'mann_whitney_u', statistic: 18, df: 8, effect_size_type: 'cliffs_delta', effect_size: 0.3 })
    render(<GroupComparisonTable groups={GROUPS_2} rows={[row(mw, GROUPS_2)]} sigLevels={SIG} nonparametric />)
    expect(screen.getByTitle(/^effect size = 0\.300/)).toBeInTheDocument()
    expect(screen.queryByTitle(/^r = 0\.300/)).toBeNull()
  })
})

describe('#1424 — the name follows effect_size_type when it and the test disagree', () => {
  it('an ANOVA whose effect size is d is headed d, not ω²', () => {
    const odd = t({ test_type: 'one_way_anova', df: 2, df2: 21, effect_size_type: 'cohens_d' })
    render(<GroupComparisonTable groups={GROUPS_3} rows={[row(odd, GROUPS_3)]} sigLevels={SIG} />)
    expect(headers()).toContain('d')
    expect(headers()).not.toContain('ω²')
  })

  it('an ANOVA with no ω² beside it names η² as η² (the strip printed η²’s number as ω²)', () => {
    const anova = t({
      test_type: 'one_way_anova', df: 2, df2: 9, effect_size: 0.3017, effect_size_type: 'eta_squared',
      effect_size_label: 'large',
    })
    const { container } = render(<ComparisonTestStrip rows={[row(anova, GROUPS_3)]} sigLevels={SIG} />)
    expect(container.textContent).toContain('η² = 0.30 (large)')
    expect(container.textContent).not.toContain('ω²')
  })
})

describe('#1424 rider — the two-group statistic is the test the server ran', () => {
  it('an ANOVA chosen over two groups is titled F(1, 15), not "t(1.0)"', () => {
    const anova2 = t({
      test_type: 'one_way_anova', statistic: 15.1441, df: 1, df2: 15, p: 0.001446,
      effect_size: 0.5024, effect_size_type: 'eta_squared', effect_size_label: 'large',
      omega_squared: 0.4541, omega_squared_label: 'large',
    })
    render(<GroupComparisonTable groups={GROUPS_2} rows={[row(anova2, GROUPS_2)]} sigLevels={SIG} />)
    expect(screen.getByTitle('F(1, 15) = 15.14, p = .001')).toBeInTheDocument()
    expect(screen.queryByTitle(/^t\(1\.0\)/)).toBeNull()
  })
})

describe('r3-9 — the two-group header names what its columns hold', () => {
  const groupHeaders = () => screen.getAllByRole('columnheader')
    .filter(h => h.getAttribute('scope') === 'colgroup').map(h => h.textContent?.trim())

  it('a rank test’s U, p and r sit under "Test", not "Difference"', () => {
    const mw = t({ test_type: 'mann_whitney_u', statistic: 18, df: 8, effect_size: -0.44,
      effect_size_type: 'rank_biserial_r', effect_size_label: 'medium', p_method: 'exact' })
    render(<GroupComparisonTable groups={GROUPS_2} rows={[row(mw, GROUPS_2)]} sigLevels={SIG} nonparametric />)
    expect(groupHeaders()).toEqual(['a', 'b', 'Test'])
  })

  it('positive control (passes before and after): Δ, p and d still sit under "Difference"', () => {
    render(<GroupComparisonTable groups={GROUPS_2} rows={[row(t({}), GROUPS_2)]} sigLevels={SIG} />)
    expect(groupHeaders()).toEqual(['a', 'b', 'Difference'])
  })
})

describe('positive controls (pass before and after): the real pairings are unchanged', () => {
  it('a real ANOVA still displays ω² with ω²’s word (the deliberate override)', () => {
    const anova = t({
      test_type: 'one_way_anova', df: 2, df2: 9, effect_size: 0.3017, effect_size_type: 'eta_squared',
      effect_size_label: 'large', omega_squared: 0.1359, omega_squared_label: 'medium',
    })
    const { container } = render(<ComparisonTestStrip rows={[row(anova, GROUPS_3)]} sigLevels={SIG} />)
    expect(container.textContent).toContain('ω² = 0.14 (medium)')
  })

  it('a real Kruskal–Wallis is headed ε² and a real Welch t carries d’s interval', () => {
    const kw = t({ test_type: 'kruskal_wallis', df: 2, effect_size: 0.82, effect_size_type: 'epsilon_squared', effect_size_label: 'large' })
    render(<GroupComparisonTable groups={GROUPS_3} rows={[row(kw, GROUPS_3)]} sigLevels={SIG} nonparametric />)
    expect(headers()).toContain('ε²')
    cleanup()
    const welch = t({ effect_size_ci_lower: 0.12, effect_size_ci_upper: 1.18 })
    const { container } = render(<ComparisonTestStrip rows={[row(welch, GROUPS_2)]} sigLevels={SIG} />)
    expect(container.textContent).toContain('d = 0.62 [0.12, 1.18] (medium)')
  })
})
