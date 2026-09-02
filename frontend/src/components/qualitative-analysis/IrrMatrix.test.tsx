/**
 * Track J · J2-5 — IrrMatrix: the κ/α/% reliability table + the tab-visibility gate.
 * Asserts rows + summary, κ-column hidden for n>2, dual-encoded bands (word as text,
 * not color-only), the per-row aria-label, and the unavailable state.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
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

/**
 * #43 — confidence intervals on the coefficients.
 *
 * What these pin is not the arithmetic (that is
 * `backend/tests/test_reliability_intervals.py`) but the three DISPLAY claims:
 * the interval reaches the cell it belongs to, it is announced as a range
 * rather than as punctuation, and the straddle warning fires exactly when the
 * data cannot settle the band.
 */
describe('#43 — reliability intervals', () => {
  const withCi = {
    ...TWO_CODER,
    sources: [], source: null,
    per_code: [{
      ...TWO_CODER.per_code[0],
      undefined_reason: null,
      kappa_ci: {
        lower: 0.58, upper: 0.86, level: 0.95,
        method: 'kappa_analytic_se', n_resamples: null, unavailable_reason: null,
      },
      alpha_ci: {
        lower: 0.55, upper: 0.83, level: 0.95,
        method: 'alpha_bootstrap_units', n_resamples: 2000, unavailable_reason: null,
      },
    }],
    interpretation_thresholds: { kappa: {}, alpha: { tentative: 0.667, reliable: 0.8 } },
    overall_alpha_ci: {
      lower: 0.55, upper: 0.85, level: 0.95,
      method: 'alpha_bootstrap_units', n_resamples: 2000, unavailable_reason: null,
    },
  }

  beforeEach(() => irr.mockReset())

  it('puts each interval in its own coefficient cell, adding no columns', async () => {
    irr.mockResolvedValue(withCi)
    const { container } = renderMatrix()
    await screen.findByText('Empathy')

    // The header row is unchanged: this table already scrolls horizontally, and
    // two more columns would push content off a 640×360 viewport (#717/#718).
    const headers = container.querySelectorAll('thead th')
    expect(headers).toHaveLength(6)

    const row = screen.getByText('Empathy').closest('tr')!
    expect(row.textContent).toContain('[0.58, 0.86]')
    expect(row.textContent).toContain('[0.55, 0.83]')
  })

  it('announces a range, never the bracket punctuation', async () => {
    irr.mockResolvedValue(withCi)
    renderMatrix()
    await screen.findByText('Empathy')

    // A reader renders "[0.55, 0.83]" as "left bracket … comma …", so the
    // bracket form is aria-hidden and the spoken form spells the range out.
    const spoken = screen.getAllByText(/95% confidence interval 0\.55 to 0\.83/)
    expect(spoken.length).toBeGreaterThan(0)
    const visual = screen.getAllByText('[0.55, 0.83]')[0]
    expect(visual).toHaveAttribute('aria-hidden', 'true')
  })

  it('carries the interval into the row summary a browse-mode reader hears', async () => {
    irr.mockResolvedValue(withCi)
    renderMatrix()
    await screen.findByText('Empathy')

    const aria = screen.getByText('Empathy').closest('tr')!.getAttribute('aria-label') ?? ''
    expect(aria).toContain('κ=0.72 substantial, 95% confidence interval 0.58 to 0.86')
    expect(aria).toContain('α=0.70 tentative, 95% confidence interval 0.55 to 0.83 over units')
  })

  it('warns when the headline interval spans a cutoff the band word claims to settle', async () => {
    irr.mockResolvedValue(withCi)   // overall α 0.68, interval [0.55, 0.85]
    renderMatrix()
    await screen.findByText('Empathy')

    // The whole point of the feature: "tentative" is not a fact about the study
    // when the interval also contains "unreliable" and "reliable".
    const note = screen.getByText(/spans the .* cutoffs/)
    expect(note.textContent).toContain('0.667 (tentative) and 0.8 (reliable)')
    expect(note.textContent).toContain('cannot tell those readings apart')
  })

  it('stays silent when the interval settles the band', async () => {
    irr.mockResolvedValue({
      ...withCi,
      overall_alpha: 0.9, overall_alpha_interpretation: 'reliable',
      overall_alpha_ci: { ...withCi.overall_alpha_ci, lower: 0.85, upper: 0.95 },
    })
    renderMatrix()
    await screen.findByText('Empathy')
    expect(screen.queryByText(/spans the/)).not.toBeInTheDocument()
  })

  it('states how the intervals were made, once, as visible content', async () => {
    irr.mockResolvedValue(withCi)
    const { container } = renderMatrix()
    await screen.findByText('Empathy')
    const text = container.textContent ?? ''

    // The basis is the dangerous half — a reader who thinks the α interval
    // narrows by adding coders has misread the number entirely.
    expect(text).toContain('Resampled from the coded UNITS, not from the coders')
    expect(text).toContain('2,000 resamples')
    expect(text).toContain('fixed starting point')
  })

  it('renders no interval for a coefficient that is undefined', async () => {
    // #829's rider: the statistic's own reason explains the blank, and a second
    // explanation on one empty cell is noise rather than disclosure.
    irr.mockResolvedValue({
      ...withCi,
      per_code: [{
        ...withCi.per_code[0],
        cohens_kappa: null, kappa_interpretation: null,
        krippendorff_alpha: null, alpha_interpretation: null,
        undefined_reason: 'no_variance', kappa_ci: null, alpha_ci: null,
      }],
    })
    renderMatrix()
    await screen.findByText('Empathy')
    const row = screen.getByText('Empathy').closest('tr')!
    expect(row.textContent).not.toContain('[')
  })
})

describe('#35 — rating agreement', () => {
  const RATED = {
    ...TWO_CODER,
    sources: [], source: null,
    reliability_facet: 'coders',
    per_code: [{
      ...TWO_CODER.per_code[0],
      undefined_reason: null, kappa_ci: null, alpha_ci: null, alpha_metric: 'nominal',
    }],
    magnitude_per_code: [
      {
        code_id: 20, code_name: 'District support',
        scale: {
          min: -1, max: 1, step: 0.5,
          anchors: [{ value: -1, label: 'strongly negative' }, { value: 1, label: 'strongly positive' }],
        },
        n_units: 5, n_applications: 13, n_rated: 12, mean_abs_difference: 0.2,
        krippendorff_alpha: 0.74, alpha_interpretation: 'tentative', alpha_metric: 'interval',
        undefined_reason: null,
        alpha_ci: {
          lower: 0.41, upper: 0.92, level: 0.95,
          method: 'alpha_bootstrap_units', n_resamples: 2000, unavailable_reason: null,
        },
      },
      {
        code_id: 21, code_name: 'Enthusiasm',
        scale: { min: 0, max: 10, step: 1, anchors: [] },
        n_units: 0, n_applications: 3, n_rated: 3, mean_abs_difference: null,
        krippendorff_alpha: null, alpha_interpretation: null, alpha_metric: 'interval',
        undefined_reason: 'insufficient_n', alpha_ci: null,
      },
    ],
  }

  beforeEach(() => irr.mockReset())

  it('renders a SECOND table for rated codes and leaves the first one its six columns', async () => {
    irr.mockResolvedValue(RATED)
    renderMatrix()
    await screen.findByText('District support')

    const section = screen.getByRole('heading', { name: 'Rating agreement' }).closest('section')!
    const headers = [...section.querySelectorAll('thead th')].map(th => th.textContent)
    expect(headers).toEqual([
      'Code', 'Scale', 'Units', 'Rated', 'Mean difference', "Krippendorff's α (interval)",
    ])
    // The presence/absence table is untouched: at 640×360 it is at capacity,
    // and a rating α is a different coefficient over a different unit set.
    const first = screen.getByText('Empathy').closest('table')!
    expect(first.querySelectorAll('thead th')).toHaveLength(6)
    expect(first.textContent).not.toContain('District support')
  })

  it('states the facet and each table’s metric from the payload, never from the screen', async () => {
    irr.mockResolvedValue(RATED)
    const { container } = renderMatrix()
    await screen.findByText('District support')
    const text = container.textContent ?? ''
    expect(text).toContain("Krippendorff's α over coders")
    expect(text).toContain('agreement between the people who coded')
    expect(text).toContain('a 3 and a 4 disagree less than a 3 and a 9')
    expect(text).toContain('match or they do not')
  })

  it('shows the scale, the coverage and the mean difference beside α — and announces the whole row', async () => {
    irr.mockResolvedValue(RATED)
    renderMatrix()
    const row = (await screen.findByText('District support')).closest('tr')!
    expect(row.textContent).toContain('−1 to 1')
    expect(row.textContent).toContain('12/13')
    expect(row.textContent).toContain('12 of 13')
    expect(row.textContent).toContain('0.20')
    expect(row.textContent).toContain('[0.41, 0.92]')

    // A browse-mode reader hears the row, not the cells (`rowAriaLabel`'s rule).
    const label = row.getAttribute('aria-label')!
    expect(label).toContain('scale −1 to 1')
    expect(label).toContain('α=0.74 tentative')
    expect(label).toContain('0.41 to 0.92 over units')
    expect(label).toContain('12 of 13 applications rated')
    expect(label).toContain('coders differ by 0.20 on average')
  })

  it('says once, as visible content, how many applications carry no rating', async () => {
    irr.mockResolvedValue(RATED)
    const { container } = renderMatrix()
    await screen.findByText('District support')
    expect(container.textContent).toContain(
      '1 of 16 applications of these codes carry no rating',
    )
  })

  it('explains a code only one coder rated instead of printing a bare dash', async () => {
    irr.mockResolvedValue(RATED)
    renderMatrix()
    const row = (await screen.findByText('Enthusiasm')).closest('tr')!
    expect(row.getAttribute('aria-label')).toContain('Too few values to compute this')
    expect(row.textContent).toContain('3/3')
    expect(row.textContent).toContain('0 to 10')
  })

  it('renders no rating section when the payload has none — or predates the field', async () => {
    irr.mockResolvedValue({ ...RATED, magnitude_per_code: [] })
    renderMatrix()
    await screen.findByText('Empathy')
    expect(screen.queryByRole('heading', { name: 'Rating agreement' })).toBeNull()
    expect(screen.queryByText(/carry no rating/)).toBeNull()

    cleanup()
    irr.mockResolvedValue(TWO_CODER)   // no `magnitude_per_code`, no `reliability_facet`
    const { container } = renderMatrix()
    await screen.findByText('Empathy')
    expect(screen.queryByRole('heading', { name: 'Rating agreement' })).toBeNull()
    // An older payload is not relabelled with a facet it never stated.
    expect(container.textContent).not.toContain('over coders')
  })
})

describe('#43 rider — a band colour is withdrawn when the interval spans its cutoff', () => {
  // κ = 0.72 "substantial" with [0.62, 0.79]: no Landis & Koch cutoff inside,
  // so the band is SETTLED. α = 0.70 "tentative" with [0.55, 0.83]: spans both
  // 0.667 and 0.8, so the band is NOT — green or amber there would assert a
  // certainty the interval denies.
  const payload = {
    ...TWO_CODER,
    sources: [], source: null,
    per_code: [{
      ...TWO_CODER.per_code[0],
      undefined_reason: null,
      kappa_ci: {
        lower: 0.62, upper: 0.79, level: 0.95,
        method: 'kappa_analytic_se', n_resamples: null, unavailable_reason: null,
      },
      alpha_ci: {
        lower: 0.55, upper: 0.83, level: 0.95,
        method: 'alpha_bootstrap_units', n_resamples: 2000, unavailable_reason: null,
      },
    }],
    interpretation_thresholds: {
      kappa: { slight: 0, fair: 0.2, moderate: 0.4, substantial: 0.6, almost_perfect: 0.8 },
      alpha: { tentative: 0.667, reliable: 0.8 },
    },
    overall_alpha_ci: null,
  }

  beforeEach(() => irr.mockReset())

  it('mutes the unsettled band and keeps the settled one coloured — and says so in text', async () => {
    irr.mockResolvedValue(payload)
    renderMatrix()
    const row = (await screen.findByText('Empathy')).closest('tr')!

    const alphaValue = within(row).getByText('0.70').closest('span')!
    expect(alphaValue.className).toContain('text-mm-text-muted')
    expect(alphaValue.className).not.toContain('text-amber-600')
    // The word itself stays: it is still what the estimate says.
    expect(alphaValue.textContent).toContain('tentative')
    // Never colour alone, in either direction: the withdrawal is also text.
    expect(alphaValue.textContent).toContain('(the interval spans a cutoff)')

    const kappaValue = within(row).getByText('0.72').closest('span')!
    expect(kappaValue.className).toContain('text-emerald-600')
    expect(kappaValue.textContent).not.toContain('spans a cutoff')

    // And the row summary a browse-mode reader hears carries it once — for α.
    const label = row.getAttribute('aria-label')!
    expect(label.split('spans a cutoff').length - 1).toBe(1)
    expect(label).toMatch(/α=0\.70 tentative.*spans a cutoff/)
  })

  it('does not mute when the payload carries no cutoffs to judge against', async () => {
    irr.mockResolvedValue({ ...payload, interpretation_thresholds: {} })
    renderMatrix()
    const row = (await screen.findByText('Empathy')).closest('tr')!
    const alphaValue = within(row).getByText('0.70').closest('span')!
    expect(alphaValue.className).toContain('text-amber-600')
    expect(row.textContent).not.toContain('spans a cutoff')
  })
})
