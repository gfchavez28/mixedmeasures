/**
 * Track J · J2-5 — IrrMatrix: the κ/α/% reliability table + the tab-visibility gate.
 * Asserts rows + summary, κ-column hidden for n>2, dual-encoded bands (word as text,
 * not color-only), the per-row aria-label, and the unavailable state.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const irr = vi.fn()
vi.mock('@/lib/api', () => ({
  codeAnalysisApi: { irr: (...a: unknown[]) => irr(...a) },
}))

import IrrMatrix from './IrrMatrix'
import { isIrrTabVisible } from '@/lib/qual-analysis-types'

afterEach(cleanup)

function renderMatrix() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <IrrMatrix projectId={1} />
    </QueryClientProvider>,
  )
}

const TWO_CODER = {
  available: true, reason: null, n_coders: 2,
  coders: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }],
  metric_label: 'kappa+alpha',
  per_code: [
    {
      code_id: 10, code_name: 'Empathy', n_units: 25, percent_agreement: 0.88, prevalence: 0.34,
      cohens_kappa: 0.72, kappa_interpretation: 'substantial',
      krippendorff_alpha: 0.70, alpha_interpretation: 'tentative',
    },
  ],
  overall_alpha: 0.68, overall_alpha_interpretation: 'tentative',
  interpretation_thresholds: { kappa: {}, alpha: {} },
}

describe('isIrrTabVisible', () => {
  it('is visible only for multi-coder projects', () => {
    expect(isIrrTabVisible(true)).toBe(true)
    expect(isIrrTabVisible(false)).toBe(false)
  })
  it('is hidden while blind (DEC-G — IRR names coders + shows agreement)', () => {
    expect(isIrrTabVisible(true, true)).toBe(false)
    expect(isIrrTabVisible(true, false)).toBe(true)
  })
})

describe('IrrMatrix', () => {
  beforeEach(() => irr.mockReset())

  it('renders per-code rows, the overall-α summary, and dual-encoded band words (not color-only)', async () => {
    irr.mockResolvedValue(TWO_CODER)
    renderMatrix()

    expect(await screen.findByText('Empathy')).toBeInTheDocument()
    expect(screen.getByText(/Overall α/)).toBeInTheDocument()
    // The band is conveyed as a WORD (text channel), not only by color.
    expect(screen.getAllByText(/tentative/).length).toBeGreaterThan(0)
    expect(screen.getByText('substantial')).toBeInTheDocument()
    // κ column present for exactly 2 coders.
    expect(screen.getByText("Cohen's κ")).toBeInTheDocument()

    // Per-row aria-label encodes κ/α + bands + % + prevalence.
    const row = screen.getByText('Empathy').closest('tr')!
    const aria = row.getAttribute('aria-label') ?? ''
    expect(aria).toContain('Empathy:')
    expect(aria).toContain('κ=0.72 substantial')
    expect(aria).toContain('α=0.70 tentative')
    expect(aria).toContain('88% agreement')
    expect(aria).toContain('prevalence 0.34')

    // The per-cell text itself separates the value from its band word (#445) —
    // the α cell must read "0.70 tentative", not the run-on "0.70tentative".
    expect(row.textContent).toContain('0.70 tentative')
  })

  it('hides the κ column for n>2 coders (α-only) and drops κ from the aria-label', async () => {
    irr.mockResolvedValue({
      ...TWO_CODER, n_coders: 3, metric_label: 'alpha',
      coders: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 3, name: 'C' }],
      per_code: [{ ...TWO_CODER.per_code[0], cohens_kappa: null, kappa_interpretation: null }],
    })
    renderMatrix()

    expect(await screen.findByText('Empathy')).toBeInTheDocument()
    expect(screen.queryByText("Cohen's κ")).not.toBeInTheDocument()
    const aria = screen.getByText('Empathy').closest('tr')!.getAttribute('aria-label') ?? ''
    expect(aria).not.toContain('κ=')
    expect(aria).toContain('α=0.70')
  })

  it('surfaces the α cutoffs (from the payload), the α formula, and the roster legend (#473)', async () => {
    irr.mockResolvedValue({
      ...TWO_CODER,
      interpretation_thresholds: { kappa: {}, alpha: { tentative: 0.667, reliable: 0.8 } },
    })
    const { container } = renderMatrix()
    await screen.findByText('Empathy')
    const text = container.textContent ?? ''
    // Cutoffs rendered from the payload (single source of truth with the backend).
    expect(text).toContain('reliable')
    expect(text).toContain('≥ 0.80')
    expect(text).toContain('0.667–0.80')
    expect(text).toContain('Krippendorff (2004)')
    // Formula a user can verify by hand + the roster/engagement legend.
    expect(text).toContain('observed ÷ expected disagreement')
    expect(text).toContain('only coders who coded in it count toward')
  })

  it('falls back to the documented α cutoffs when the payload omits thresholds', async () => {
    irr.mockResolvedValue({ ...TWO_CODER, interpretation_thresholds: {} })
    const { container } = renderMatrix()
    await screen.findByText('Empathy')
    expect(container.textContent ?? '').toContain('≥ 0.80')
  })

  it('shows the backend reason when unavailable', async () => {
    irr.mockResolvedValue({
      available: false, reason: 'Reliability needs at least 2 coders with coding on a shared source.',
      n_coders: 1, coders: [], metric_label: null, per_code: [],
      overall_alpha: null, overall_alpha_interpretation: null, interpretation_thresholds: {},
    })
    renderMatrix()
    expect(await screen.findByText(/needs at least 2 coders/)).toBeInTheDocument()
  })
})

/**
 * #829/#828 — the source picker, and an undefined statistic that says why.
 *
 * The pooled table averaged every multi-coder source into one headline: a
 * deliberate two-coder study of one column pooled with seven other people's
 * transcript work, under *"Overall α 0.62 · unreliable"* as the largest text on
 * the screen.
 */
describe('#829 — reliability source scope', () => {
  const SOURCES = [
    { key: 'col:16', kind: 'col' as const, label: 'Observer notes' },
    { key: 'conv:3', kind: 'conv' as const, label: 'Interview 1' },
  ]
  const base = {
    available: true, reason: null, n_coders: 3,
    coders: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }, { id: 3, name: 'Carol' }],
    metric_label: 'alpha',
    overall_alpha: 0.62, overall_alpha_interpretation: 'unreliable',
    interpretation_thresholds: {},
    per_code: [{
      code_id: 10, code_name: 'Fidelity', n_units: 40, percent_agreement: 0.9, prevalence: 0.3,
      cohens_kappa: null, kappa_interpretation: null,
      krippendorff_alpha: 0.6, alpha_interpretation: 'unreliable',
      undefined_reason: null,
    }],
  }

  beforeEach(() => irr.mockReset())

  it('offers every selectable source, grouped, plus pooled', async () => {
    irr.mockResolvedValue({ ...base, sources: SOURCES, source: null })
    renderMatrix()
    expect(await screen.findByLabelText('Reliability source')).toBeInTheDocument()
    expect(screen.getByText('Pooled across 2 sources')).toBeInTheDocument()
  })

  it('does NOT render a picker when there is nothing to choose between', async () => {
    // An inert control beside the tab's own scope selector is two things to read.
    irr.mockResolvedValue({ ...base, sources: [SOURCES[0]], source: null })
    renderMatrix()
    await screen.findByText(/Overall/)
    expect(screen.queryByLabelText('Reliability source')).not.toBeInTheDocument()
  })

  it('names the scope when the payload is source-scoped', async () => {
    irr.mockResolvedValue({ ...base, sources: SOURCES, source: 'col:16' })
    renderMatrix()
    expect(await screen.findByText('Agreement on Observer notes alone')).toBeInTheDocument()
  })

  it('asks for the pooled view by default — the old behaviour is the default', async () => {
    irr.mockResolvedValue({ ...base, sources: SOURCES, source: null })
    renderMatrix()
    await screen.findByText(/Overall/)
    // `undefined`, never a source: the R export and every existing caller rely
    // on the pooled default.
    expect(irr).toHaveBeenCalledWith(1, undefined)
  })

  it('explains an undefined statistic instead of printing a bare dash', async () => {
    // The rider: a code nobody applied in scope has no variance to agree about,
    // and the arithmetic returns κ = 1.0 "almost perfect" if you let it.
    irr.mockResolvedValue({
      ...base, sources: SOURCES, source: 'col:16', metric_label: 'kappa+alpha',
      per_code: [{
        code_id: 11, code_name: 'District support', n_units: 40,
        percent_agreement: 1.0, prevalence: 0.0,
        cohens_kappa: null, kappa_interpretation: null,
        krippendorff_alpha: null, alpha_interpretation: null,
        undefined_reason: 'no_variance',
      }],
    })
    renderMatrix()
    await screen.findByText('District support')
    // Positive assertion, not "does not say almost perfect": a negative here
    // passes when the row fails to render at all.
    //
    // ⚠️ ARITY, not `>= 1`. BOTH undefined cells must explain themselves — κ and
    // α — and the `>= 1` form let a mutant that stripped the reason from the κ
    // column survive, because the α column still carried it. Mutation-found.
    expect(
      screen.getAllByText(/Every value here is identical/),
    ).toHaveLength(2)
  })

  it('puts the scope in the QUERY KEY, not only in the request', () => {
    // #454's class: a scope that rides the request but not the key serves the
    // previous source's numbers from cache. jsdom cannot drive a Radix select
    // reliably, so this is asserted structurally against the source.
    const src = readFileSync(join(__dirname, 'IrrMatrix.tsx'), 'utf8')
    const key = src.match(/queryKey:\s*\[([^\]]*)\]/)?.[1]
    expect(key, 'no queryKey found — the scan is reading the wrong shape').toBeTruthy()
    expect(key).toMatch(/\bsource\b/)
  })
})
