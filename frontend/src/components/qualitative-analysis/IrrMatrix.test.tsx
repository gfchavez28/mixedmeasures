/**
 * Track J · J2-5 — IrrMatrix: the κ/α/% reliability table + the tab-visibility gate.
 * Asserts rows + summary, κ-column hidden for n>2, dual-encoded bands (word as text,
 * not color-only), the per-row aria-label, and the unavailable state.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, within, act, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ApiError } from '@/lib/api/client'

const irr = vi.fn()
vi.mock('@/lib/api', async () => {
  // The REAL failure predicates and budget (#957) — only the network is faked.
  const errors = await vi.importActual<typeof import('@/lib/api/error-utils')>('@/lib/api/error-utils')
  const download = await vi.importActual<typeof import('@/lib/api/download')>('@/lib/api/download')
  return {
    ...errors,
    EXPORT_TIMEOUT_MS: download.EXPORT_TIMEOUT_MS,
    codeAnalysisApi: { irr: (...a: unknown[]) => irr(...a) },
  }
})

import IrrMatrix from './IrrMatrix'
import { SLOW_HINT_MS } from '@/components/LoadStatus'
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
 * #957 — a failed REQUEST is not an unavailable STATISTIC.
 *
 * Measured on a 1.2M-application project: pooled reliability takes 46 s, the
 * client gave up at 30 s, and with `data` undefined the `!data?.available`
 * branch told the researcher *"Reliability is unavailable for this project."*
 * — a claim about their data, made because the client stopped waiting.
 */
describe('#957 — a failed request is not an unavailable statistic', () => {
  // ⚠️ A BLOCK, not `() => irr.mockReset()`: a `beforeEach` that RETURNS a
  // function has it called as the test's teardown, and `mockReset` returns the
  // mock — so the expression form calls `irr()` after every test. Harmless while
  // the mock resolves; with a rejection or a never-settling promise it fails the
  // test with that rejection, or hangs the hook.
  beforeEach(() => { irr.mockReset() })
  afterEach(() => vi.useRealTimers())

  it('a timeout says it timed out, offers no retry, and is not asked again', async () => {
    irr.mockRejectedValue(new DOMException('signal timed out', 'TimeoutError'))
    renderMatrix()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Reliability took longer than 15 minutes to compute.')
    expect(alert).toHaveTextContent(/may still be running/)
    // A retry gets the same budget and stops in the same place (#820).
    expect(alert).not.toHaveTextContent(/try again/i)
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/unavailable for this project/)).not.toBeInTheDocument()
    expect(irr).toHaveBeenCalledTimes(1)
  })

  it('a server error says the calculation failed — without its raw body — and offers Retry', async () => {
    irr.mockRejectedValue(new ApiError(500, { detail: 'Internal Server Error' }, {}))
    renderMatrix()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Reliability could not be computed.')
    expect(alert).not.toHaveTextContent('Internal Server Error')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.queryByText(/unavailable for this project/)).not.toBeInTheDocument()
    // Not re-asked on its own: the server answered, and would answer the same.
    expect(irr).toHaveBeenCalledTimes(1)
  })

  it('a refusal carries the server’s own reason', async () => {
    irr.mockRejectedValue(new ApiError(404, { detail: 'Project not found' }, {}))
    renderMatrix()
    expect(await screen.findByRole('alert')).toHaveTextContent('Project not found')
  })

  it('a dropped connection IS retried once on its own', async () => {
    // Pins the query's `retry` wiring: this harness's client default is
    // `retry: false`, so only the component's own option can produce call 2.
    irr.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(TWO_CODER)
    renderMatrix()
    // React Query waits 1 s before its first retry.
    expect(await screen.findByText('Empathy', {}, { timeout: 4000 })).toBeInTheDocument()
    expect(irr).toHaveBeenCalledTimes(2)
  })

  it('Retry never leaves focus on <body>: the loading line while it runs, then the headline', async () => {
    let settleRetry!: (v: unknown) => void
    irr
      .mockRejectedValueOnce(new ApiError(500, { detail: 'Internal Server Error' }, {}))
      .mockReturnValueOnce(new Promise(resolve => { settleRetry = resolve }))
    renderMatrix()

    const retry = await screen.findByRole('button', { name: 'Retry' })
    retry.focus()  // a real click focuses the button; fireEvent does not
    fireEvent.click(retry)

    // MEASURED, and the reason this test exists: with no data cached, React
    // Query v5 resets the errored query to `pending`, so the press unmounts the
    // button it was made on. The loading line is where the keyboard user is.
    const status = await screen.findByRole('status')
    expect(retry).not.toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).toBe(status))

    await act(async () => { settleRetry(TWO_CODER) })
    expect(await screen.findByText('Empathy')).toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).toHaveTextContent(/Overall α/))
    expect(irr).toHaveBeenCalledTimes(2)
  })

  it('a Retry that fails again lands on the new failure message, not <body>', async () => {
    irr.mockRejectedValue(new ApiError(500, { detail: 'Internal Server Error' }, {}))
    renderMatrix()

    const retry = await screen.findByRole('button', { name: 'Retry' })
    retry.focus()
    fireEvent.click(retry)

    await waitFor(() => expect(irr).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('alert')))
    expect(screen.getByRole('alert')).toHaveTextContent('Reliability could not be computed.')
  })

  it('a researcher who moved on during the retry keeps their place', async () => {
    let settleRetry!: (v: unknown) => void
    irr
      .mockRejectedValueOnce(new ApiError(500, { detail: 'Internal Server Error' }, {}))
      .mockReturnValueOnce(new Promise(resolve => { settleRetry = resolve }))
    const elsewhere = document.createElement('button')
    document.body.appendChild(elsewhere)
    try {
      renderMatrix()
      const retry = await screen.findByRole('button', { name: 'Retry' })
      retry.focus()
      fireEvent.click(retry)
      await screen.findByRole('status')

      elsewhere.focus()
      await act(async () => { settleRetry(TWO_CODER) })
      await screen.findByText('Empathy')
      await act(async () => {})
      expect(document.activeElement).toBe(elsewhere)
    } finally {
      elsewhere.remove()
    }
  })

  it('a first load never pulls focus into the table', async () => {
    irr.mockResolvedValue(TWO_CODER)
    renderMatrix()
    await screen.findByText('Empathy')
    await act(async () => {})
    expect(document.activeElement).toBe(document.body)
  })

  it('the loading line says a long wait is expected, once the wait is long', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    irr.mockReturnValue(new Promise(() => {}))
    renderMatrix()

    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent('Computing reliability…')
    expect(status).not.toHaveTextContent(/minute or more/)

    act(() => { vi.advanceTimersByTime(SLOW_HINT_MS) })
    expect(screen.getByRole('status')).toHaveTextContent(/minute or more/)
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

describe('#1333 / #1334 — the stated unit basis', () => {
  beforeEach(() => irr.mockReset())

  it('says what a unit is, from the payload, beside the table', async () => {
    irr.mockResolvedValue({ ...TWO_CODER, unit_basis: 'participant_passages' })
    renderMatrix()
    const line = await screen.findByTestId('irr-unit-basis')
    expect(line).toHaveTextContent(/turns are left out/)
    expect(line).toHaveTextContent(/a group of turns counts once/)
    const units = screen.getByRole('columnheader', { name: 'Units' })
    expect(units.getAttribute('title')).toMatch(/turns are left out/)
  })

  it('says nothing for a payload from before the field', async () => {
    irr.mockResolvedValue(TWO_CODER)
    renderMatrix()
    await screen.findByText('Empathy')
    expect(screen.queryByTestId('irr-unit-basis')).not.toBeInTheDocument()
  })
})

describe('#1333 / D18 — what the facilitator exclusion left out, and whose turns they were', () => {
  beforeEach(() => irr.mockReset())

  it('counts the turns left out, names their speakers and a code a coder applied to one', async () => {
    irr.mockResolvedValue({
      ...TWO_CODER, unit_basis: 'participant_passages', facilitator_turns_excluded: 6,
      facilitator_speakers: ['Interviewer'],
      per_code: [{ ...TWO_CODER.per_code[0], facilitator_turns_coded: 2 }],
    })
    renderMatrix()
    const line = await screen.findByTestId('irr-unit-basis')
    expect(line).toHaveTextContent(
      '6 facilitator turns (Interviewer) are left out here; coded anyway: Empathy on 2.',
    )
    // #1067 c — ONE text node, so Chrome cannot drop the space between sentences.
    expect(line.childNodes).toHaveLength(1)
    // …and the row carries its own share, in its name and on the Units cell.
    const row = screen.getByRole('row', { name: /^Empathy:/ })
    expect(row).toHaveAccessibleName(/prevalence 0\.34; 2 facilitator turns carrying it are left out$/)
    expect(within(row).getByText('25')).toHaveAttribute('title', '2 facilitator turns carrying it are left out')
  })

  it('says when no coder coded a facilitator turn', async () => {
    irr.mockResolvedValue({
      ...TWO_CODER, unit_basis: 'participant_passages', facilitator_turns_excluded: 6,
      facilitator_speakers: ['Interviewer'],
      per_code: [{ ...TWO_CODER.per_code[0], facilitator_turns_coded: 0 }],
    })
    renderMatrix()
    expect(await screen.findByTestId('irr-unit-basis')).toHaveTextContent('and no coder coded one.')
  })
})

describe('#1505 (D43) — below the floor a coefficient keeps its number and loses its verdict', () => {
  // `Rare` is compared on 7 units, under the payload's floor of 18: the server
  // keeps κ and α and sends no band, with the reason on the row. `Empathy` (25)
  // keeps its bands — the positive control for every absence asserted below.
  const RARE = {
    ...TWO_CODER.per_code[0],
    code_id: 11, code_name: 'Rare', n_units: 7, percent_agreement: 0.86, prevalence: 0.21,
    cohens_kappa: 0.4, kappa_interpretation: null,
    krippendorff_alpha: 0.38, alpha_interpretation: null,
    verdict_withheld_reason: 'too_few_units',
    undefined_reason: null, kappa_ci: null, alpha_ci: null,
  }
  const BELOW = {
    ...TWO_CODER,
    sources: [], source: null,
    per_code: [
      { ...TWO_CODER.per_code[0], undefined_reason: null, kappa_ci: null, alpha_ci: null, verdict_withheld_reason: null },
      RARE,
    ],
    interpretation_thresholds: { kappa: {}, alpha: { tentative: 0.667, reliable: 0.8 } },
    overall_alpha_ci: null,
    verdict_min_units: 18,
  }

  beforeEach(() => irr.mockReset())

  it('says "too few to judge" where the band word would be, in no band colour, and the row says its count against the floor', async () => {
    irr.mockResolvedValue(BELOW)
    renderMatrix()
    const row = await screen.findByRole('row', { name: /^Rare:/ })

    const alpha = within(row).getByText('0.38').closest('span')!
    expect(alpha.textContent).toBe('0.38 too few to judge')
    for (const colour of ['text-emerald-600', 'text-amber-600', 'text-rose-600']) {
      expect(alpha.className).not.toContain(colour)
    }
    expect(alpha).toHaveAttribute('title', '7 of the 18 units a verdict needs')
    expect(within(row).getByText('0.40').closest('span')!.textContent).toBe('0.40 too few to judge')

    // The whole fact in the name a browse-mode reader hears — the count ONCE,
    // at the end, because κ and α rest on the same units.
    expect(row).toHaveAccessibleName(
      'Rare: κ=0.40 too few to judge; α=0.38 too few to judge; 86% agreement; '
      + 'prevalence 0.21; 7 of the 18 units a verdict needs',
    )

    // The control: a row over the floor keeps its band and says no count.
    const kept = screen.getByRole('row', { name: /^Empathy:/ })
    expect(kept).toHaveAccessibleName(/κ=0\.72 substantial; α=0\.70 tentative;/)
    expect(kept).not.toHaveAccessibleName(/verdict needs/)
    expect(within(kept).getByText('0.72').closest('span')!.className).toContain('text-emerald-600')
  })

  it('explains the floor ONCE below the tables, however many rows in however many tables it applies to', async () => {
    irr.mockResolvedValue({
      ...BELOW,
      per_code: [...BELOW.per_code, { ...RARE, code_id: 12, code_name: 'Rarer', n_units: 3 }],
      magnitude_per_code: [{
        code_id: 20, code_name: 'District support',
        scale: { min: -1, max: 1, step: 0.5, anchors: [] },
        n_units: 5, n_applications: 13, n_rated: 12, mean_abs_difference: 0.2,
        krippendorff_alpha: 0.74, alpha_interpretation: null, alpha_metric: 'interval',
        verdict_withheld_reason: 'too_few_units', undefined_reason: null, alpha_ci: null,
      }],
    })
    renderMatrix()
    await screen.findByRole('row', { name: /^Rare:/ })
    const notes = screen.getAllByTestId('irr-verdict-withheld-note')
    expect(notes).toHaveLength(1)
    expect(notes[0]).toHaveTextContent(/^Too few to judge: a coefficient over fewer than 18 units judged by two or more coders is shown without a verdict\./)
  })

  it('takes the floor from the payload, never from a constant of its own', async () => {
    irr.mockResolvedValue({ ...BELOW, verdict_min_units: 25 })
    renderMatrix()
    const row = await screen.findByRole('row', { name: /^Rare:/ })
    expect(row).toHaveAccessibleName(/7 of the 25 units a verdict needs$/)
    expect(screen.getByTestId('irr-verdict-withheld-note')).toHaveTextContent('fewer than 25 units')
  })

  it('says nothing new when no row is below the floor — or the payload predates the fields', async () => {
    // Over the floor: the field is present and null.
    irr.mockResolvedValue({ ...BELOW, per_code: [BELOW.per_code[0]] })
    renderMatrix()
    await screen.findByRole('row', { name: /^Empathy:/ })
    expect(screen.queryByTestId('irr-verdict-withheld-note')).not.toBeInTheDocument()
    expect(screen.queryByText(/too few to judge/)).not.toBeInTheDocument()
    cleanup()

    // An older payload: no verdict fields at all.
    irr.mockResolvedValue(TWO_CODER)
    renderMatrix()
    await screen.findByRole('row', { name: /^Empathy:/ })
    expect(screen.queryByTestId('irr-verdict-withheld-note')).not.toBeInTheDocument()
    expect(screen.queryByTestId('irr-overall-verdict-withheld')).not.toBeInTheDocument()
  })

  it('withholds the HEADLINE verdict in words beside it, and the icon is not a failed band’s X', async () => {
    irr.mockResolvedValue({
      ...BELOW,
      per_code: [RARE],
      overall_alpha: 0.38, overall_alpha_interpretation: null,
      overall_verdict_withheld_reason: 'too_few_units',
    })
    const { container } = renderMatrix()
    await screen.findByRole('row', { name: /^Rare:/ })
    expect(screen.getByText(/Overall α 0\.38/).textContent).toBe('Overall α 0.38 · too few to judge')
    expect(screen.getByTestId('irr-overall-verdict-withheld')).toHaveTextContent(
      'Too few to judge: the overall α rests on fewer than 18 units judged by two or more coders, so it is shown without a verdict.',
    )
    expect(container.querySelector('svg.lucide-circle-dashed')).not.toBeNull()
    expect(container.querySelector('svg.lucide-circle-x')).toBeNull()
  })

  it('a headline that keeps its band keeps its icon and says nothing about a floor', async () => {
    irr.mockResolvedValue({ ...BELOW, overall_verdict_withheld_reason: null })
    const { container } = renderMatrix()
    await screen.findByRole('row', { name: /^Empathy:/ })
    expect(screen.getByText(/Overall α 0\.68/).textContent).toBe('Overall α 0.68 · tentative')
    expect(screen.queryByTestId('irr-overall-verdict-withheld')).not.toBeInTheDocument()
    expect(container.querySelector('svg.lucide-circle-alert')).not.toBeNull()
  })

  it('a rating row below the floor says it in its cell and its name — and alone, brings the note', async () => {
    irr.mockResolvedValue({
      ...BELOW,
      // Only the RATING row is below the floor, so the note below can come from it alone.
      per_code: [BELOW.per_code[0]],
      magnitude_per_code: [{
        code_id: 20, code_name: 'District support',
        scale: { min: -1, max: 1, step: 0.5, anchors: [] },
        n_units: 5, n_applications: 13, n_rated: 12, mean_abs_difference: 0.2,
        krippendorff_alpha: 0.74, alpha_interpretation: null, alpha_metric: 'interval',
        verdict_withheld_reason: 'too_few_units', undefined_reason: null, alpha_ci: null,
      }],
    })
    renderMatrix()
    const row = await screen.findByRole('row', { name: /^District support:/ })
    expect(within(row).getByText('0.74').closest('span')!.textContent).toBe('0.74 too few to judge')
    expect(row).toHaveAccessibleName(
      'District support: scale −1 to 1; α=0.74 too few to judge; 12 of 13 applications rated; '
      + 'coders differ by 0.20 on average; 5 of the 18 units a verdict needs',
    )
    expect(screen.getByTestId('irr-verdict-withheld-note')).toHaveTextContent(/fewer than 18 units/)
  })
})

describe('#1505 (D42) — one comparable unit is not a measurement, and the tab says why', () => {
  const ONE = {
    ...TWO_CODER,
    sources: [], source: null,
    per_code: [{
      ...TWO_CODER.per_code[0], n_units: 1, percent_agreement: 0, prevalence: 0.5,
      cohens_kappa: null, kappa_interpretation: null, krippendorff_alpha: null, alpha_interpretation: null,
      undefined_reason: 'insufficient_n', kappa_ci: null, alpha_ci: null,
    }],
    overall_alpha: null, overall_alpha_interpretation: null, overall_alpha_ci: null,
    verdict_min_units: 18,
  }

  beforeEach(() => irr.mockReset())

  it('explains a single unit once below the table — not with the app-wide "missing data" sentence alone', async () => {
    irr.mockResolvedValue(ONE)
    renderMatrix()
    await screen.findByRole('row', { name: /^Empathy:/ })
    expect(screen.getByTestId('irr-one-unit-note')).toHaveTextContent(
      /^No coefficient over a single unit: where only one passage was coded by two or more coders, α is 0 whenever they differ/,
    )
    // No verdict words where there is no number.
    expect(screen.queryByText(/too few to judge/)).not.toBeInTheDocument()
  })

  it('says nothing about a single unit for a rating row over NO unit, or a row over two', async () => {
    irr.mockResolvedValue({
      ...ONE,
      per_code: [{ ...ONE.per_code[0], n_units: 2, undefined_reason: 'no_variance' }],
      magnitude_per_code: [{
        code_id: 21, code_name: 'Enthusiasm',
        scale: { min: 0, max: 10, step: 1, anchors: [] },
        n_units: 0, n_applications: 3, n_rated: 3, mean_abs_difference: null,
        krippendorff_alpha: null, alpha_interpretation: null, alpha_metric: 'interval',
        undefined_reason: 'insufficient_n', alpha_ci: null,
      }],
    })
    renderMatrix()
    await screen.findByRole('row', { name: /^Enthusiasm:/ })
    expect(screen.queryByTestId('irr-one-unit-note')).not.toBeInTheDocument()
  })

  it('a rating row, or a set row, over one unit brings the note on its own', async () => {
    const overTwo = [{ ...ONE.per_code[0], n_units: 2, undefined_reason: 'no_variance' }]
    irr.mockResolvedValue({
      ...ONE, per_code: overTwo,
      magnitude_per_code: [{
        code_id: 21, code_name: 'Enthusiasm',
        scale: { min: 0, max: 10, step: 1, anchors: [] },
        n_units: 1, n_applications: 3, n_rated: 3, mean_abs_difference: 2,
        krippendorff_alpha: null, alpha_interpretation: null, alpha_metric: 'interval',
        undefined_reason: 'insufficient_n', alpha_ci: null,
      }],
    })
    renderMatrix()
    await screen.findByRole('row', { name: /^Enthusiasm:/ })
    expect(screen.getByTestId('irr-one-unit-note')).toBeInTheDocument()
    cleanup()

    irr.mockResolvedValue({
      ...ONE, per_code: overTwo,
      set_agreement: [{
        set_id: 4, label: 'Stance', exhaustive: false, set_basis: 'missing', alpha_metric: 'nominal',
        n_units: 1, n_values: 2, n_multiple_selection: 0, axis: [31, 32], value_names: { 31: 'For', 32: 'Against' },
        percent_agreement: 0, cohens_kappa: null, kappa_interpretation: null,
        krippendorff_alpha: null, alpha_interpretation: null, undefined_reason: 'insufficient_n',
        kappa_ci: null, alpha_ci: null, members: [], confusion: [],
      }],
    })
    renderMatrix()
    await screen.findByRole('row', { name: /^Stance:/ })
    expect(screen.getByTestId('irr-one-unit-note')).toBeInTheDocument()
  })
})

describe('Row 48 — the set table (#1505: a verdict withheld, an interval with no spread)', () => {
  // The set table had no client test at all before 1.5.9's session B.
  const NO_SPREAD = {
    lower: null, upper: null, level: 0.95,
    method: 'alpha_bootstrap_units', n_resamples: 2000, unavailable_reason: 'no_spread',
  }
  const SET = {
    set_id: 4, label: 'Stance', exhaustive: false, set_basis: 'missing',
    alpha_metric: 'nominal', n_units: 10, n_values: 3, n_multiple_selection: 0,
    axis: [31, 32, 33], value_names: { 31: 'For', 32: 'Against', 33: 'Mixed' },
    percent_agreement: 1, cohens_kappa: 1, kappa_interpretation: null,
    krippendorff_alpha: 1, alpha_interpretation: null,
    verdict_withheld_reason: 'too_few_units', undefined_reason: null,
    kappa_ci: null, alpha_ci: NO_SPREAD, members: [], confusion: [],
  }
  const WITH_SET = {
    ...TWO_CODER,
    sources: [], source: null,
    per_code: [{ ...TWO_CODER.per_code[0], undefined_reason: null, kappa_ci: null, alpha_ci: null }],
    overall_alpha_ci: null,
    interpretation_thresholds: { kappa: {}, alpha: { tentative: 0.667, reliable: 0.8 } },
    verdict_min_units: 18,
    set_agreement: [SET],
  }

  beforeEach(() => irr.mockReset())

  it('says "too few to judge", marks the refused interval, and explains both once below the tables', async () => {
    irr.mockResolvedValue(WITH_SET)
    renderMatrix()
    const row = await screen.findByRole('row', { name: /^Stance:/ })
    // κ and α each keep their number (perfect agreement over ten passages) and lose the verdict.
    const cells = within(row).getAllByText('1.00').map(el => el.closest('span')!.textContent)
    expect(cells).toEqual(['1.00 too few to judge', '1.00 too few to judge'])
    // [1.00, 1.00] is not drawn: the marker, and the sentence for it.
    expect(within(row).getByText('no interval')).toBeInTheDocument()
    expect(screen.getByText(/^No confidence interval: on these passages it comes out with no width/)).toBeInTheDocument()
    expect(row).toHaveAccessibleName(
      'Stance: 3 values; α=1.00 too few to judge, no confidence interval; 100% agreement over 10 passages; '
      + '10 of the 18 units a verdict needs',
    )
    expect(screen.getByTestId('irr-verdict-withheld-note')).toHaveTextContent(/fewer than 18 units/)
  })
})
