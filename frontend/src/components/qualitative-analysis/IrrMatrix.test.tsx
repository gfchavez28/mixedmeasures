/**
 * Track J · J2-5 — IrrMatrix: the κ/α/% reliability table + the tab-visibility gate.
 * Asserts rows + summary, κ-column hidden for n>2, dual-encoded bands (word as text,
 * not color-only), the per-row aria-label, and the unavailable state.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

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
