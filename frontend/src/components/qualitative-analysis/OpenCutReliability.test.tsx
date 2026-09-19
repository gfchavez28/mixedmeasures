/**
 * Observations slab 6b-A — the open-cut reliability panel.
 *
 * The behaviour worth pinning is DISCLOSURE: the parameters and modelling
 * choices must be visible content, because a reliability number whose bin width
 * and merge/drop decisions are hidden is not reproducible.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// vi.hoisted: vi.mock is lifted above plain const declarations, so a fixture the
// factory closes over has to be hoisted with it.
const { DISCLOSURE } = vi.hoisted(() => ({
  DISCLOSURE: {
    tick_ms: 100,
    continuum_seconds: 600,
    extent_source: 'recording',
    n_merged_overlaps: 0,
    n_zero_length_dropped: 0,
    n_clips_without_times: 0,
    engaged_coder_ids: [1, 2],
    excluded_coder_ids: [] as number[],
  },
}))

vi.mock('@/lib/api', async () => ({
  // #963 Tier 3 — both queries name a retry policy now, and this factory
  // replaces the whole module: without handing the real predicate back,
  // `retry` becomes `undefined` and the policy case would pass vacuously.
  retryUnanswered: (await vi.importActual<typeof import('@/lib/api/error-utils')>(
    '@/lib/api/error-utils',
  )).retryUnanswered,
  codeAnalysisApi: {
    binnedKappa: vi.fn().mockResolvedValue({
      available: true, reason: null, n_coders: 2, coders: [1, 2],
      bin_seconds: 1, n_bins: 600,
      per_code: [{
        code_id: 10, code_name: 'Off-task', n_bins: 600,
        percent_agreement: 0.994, cohens_kappa: 0.61,
        krippendorff_alpha: 0.61, prevalence: 0.03,
        interpretation: 'substantial',
      }],
      disclosure: DISCLOSURE, interpretation_thresholds: {},
    }),
    unitizingAlpha: vi.fn().mockResolvedValue({
      available: true, reason: null, n_coders: 2, coders: [1, 2],
      overall: { alpha: 0.71, interpretation: 'tentative' },
      per_category: [{
        code_id: 10, code_name: 'Off-task', n_units: 4,
        alpha: 0.71, interpretation: 'tentative', coverage_fraction: 0.2,
      }],
      disclosure: DISCLOSURE, interpretation_thresholds: {},
    }),
  },
}))

import OpenCutReliability from './OpenCutReliability'

afterEach(cleanup)

function renderPanel(opts: { clientRetry?: boolean | number } = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: opts.clientRetry ?? false, retryDelay: 0 } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <OpenCutReliability projectId={1} observationId={7} observationName="Playground" />
    </QueryClientProvider>,
  )
}

describe('OpenCutReliability', () => {
  it('shows the base rate beside the coefficient', async () => {
    // The sparse-clip trap: 99% agreement with κ = 0.61 is not a contradiction,
    // it is what a rare behaviour looks like. Without the base rate on screen a
    // reader cannot tell a good number from an empty one.
    renderPanel()
    await waitFor(() => expect(screen.getByText('Off-task')).toBeInTheDocument())
    expect(screen.getByText('99%')).toBeInTheDocument()
    expect(screen.getByText('0.610')).toBeInTheDocument()
    expect(screen.getByText('3%')).toBeInTheDocument()
  })

  it('states the bin size and resolution as visible content, not a tooltip', async () => {
    renderPanel()
    await waitFor(() => expect(screen.getByText('Off-task')).toBeInTheDocument())
    const note = screen.getByText(/How this was measured/)
    expect(note).toHaveTextContent('1s bins')
    expect(note).toHaveTextContent('0.1s resolution')
    expect(note).toHaveTextContent('600s of recording')
  })

  it('says so when the denominator is the marked extent, not the recording', async () => {
    // #622's lesson one surface over: a fallback denominator must never be
    // presented as if it were the recording's true length.
    const { codeAnalysisApi } = await import('@/lib/api')
    ;(codeAnalysisApi.binnedKappa as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      available: true, reason: null, n_coders: 2, coders: [1, 2],
      bin_seconds: 1, n_bins: 60, per_code: [],
      disclosure: { ...DISCLOSURE, extent_source: 'marked_extent', continuum_seconds: 60 },
      interpretation_thresholds: {},
    })
    renderPanel()
    await waitFor(() => expect(screen.getByText(/How this was measured/))
      .toHaveTextContent('recording length unknown'))
  })

  it('discloses merged and dropped marks, which move the result', async () => {
    const { codeAnalysisApi } = await import('@/lib/api')
    ;(codeAnalysisApi.binnedKappa as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      available: true, reason: null, n_coders: 2, coders: [1, 2],
      bin_seconds: 1, n_bins: 600, per_code: [],
      disclosure: {
        ...DISCLOSURE, n_merged_overlaps: 3, n_zero_length_dropped: 2,
        excluded_coder_ids: [5],
      },
      interpretation_thresholds: {},
    })
    renderPanel()
    await waitFor(() => {
      const note = screen.getByText(/How this was measured/)
      expect(note).toHaveTextContent('3 overlapping marks merged')
      expect(note).toHaveTextContent('2 instant marks not counted')
      expect(note).toHaveTextContent('1 coder marked nothing here')
    })
  })

  it('names the bin-size tabs by their width, not the group label', async () => {
    // Live-drive find (2026-07-19): wrapping the SegmentedControl in a <label>
    // made the FIRST tab announce as "Bin size Bin size in seconds" instead of
    // "1s" — a label names its first labelable descendant, and a button is one.
    renderPanel()
    await waitFor(() => expect(screen.getByText('Off-task')).toBeInTheDocument())
    expect(screen.getByRole('tab', { name: '1s' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '5s' })).toBeInTheDocument()
  })

  it('acknowledges the missing event-matched half — on the binned view only', async () => {
    // The BQG report-both obligation (plan §8o): event-matched κ (6b-A-3) is
    // specified but unbuilt, and a binned-only table must say so rather than
    // stand as "the" number. When A-3 ships, this pin flips into an assertion
    // that BOTH tables render.
    renderPanel()
    await waitFor(() => expect(screen.getByText('Off-task')).toBeInTheDocument())
    expect(screen.getByText(/event-matched/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'How it was carved up' }))
    await waitFor(() => expect(screen.getByText('Marks')).toBeInTheDocument())
    expect(screen.queryByText(/event-matched/i)).not.toBeInTheDocument()
  })

  it('explains an unavailable result instead of showing an empty table', async () => {
    const { codeAnalysisApi } = await import('@/lib/api')
    ;(codeAnalysisApi.binnedKappa as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      available: false,
      reason: 'Time-binned agreement needs at least 2 coders who marked clips here.',
      n_coders: 1, coders: [1], bin_seconds: 1, n_bins: 0, per_code: [],
      disclosure: { ...DISCLOSURE, engaged_coder_ids: [1] },
      interpretation_thresholds: {},
    })
    renderPanel()
    await waitFor(() => expect(screen.getByText(/at least 2 coders/)).toBeInTheDocument())
  })
})

/**
 * #963 Tier 3 — this panel WAITED and then said nothing at all.
 *
 * Every block below the loading line is gated on `data?.available`, so a
 * settled failure left the explainer paragraph sitting above empty space, for
 * the life of the page. Silence there reads as "still thinking" or as a
 * reliability figure that does not exist; neither is what happened. `IrrMatrix`
 * got this treatment in #957 and its sibling on the same tab did not.
 */
describe('#963 Tier 3 — a failed measurement says so, per method', () => {
  const api = async () => (await import('@/lib/api')).codeAnalysisApi as unknown as {
    binnedKappa: ReturnType<typeof vi.fn>
    unitizingAlpha: ReturnType<typeof vi.fn>
  }
  /** An ANSWERED refusal — duck-typed on `status`, like the real predicates. */
  const answered500 = () => Object.assign(new Error('boom'), { status: 500 })

  it('READY: the coefficients render and no notice appears (positive control)', async () => {
    renderPanel()
    await waitFor(() => expect(screen.getByText('Off-task')).toBeInTheDocument())
    expect(screen.queryByText(/could not be measured/)).toBeNull()
  })

  it('LOADING: says it is measuring', async () => {
    ;(await api()).binnedKappa.mockReturnValueOnce(new Promise(() => {}))
    renderPanel()
    expect(await screen.findByText('Measuring agreement…')).toBeInTheDocument()
    expect(screen.queryByText(/could not be measured/)).toBeNull()
  })

  it('FAILED: names WHICH measurement failed, and offers a Retry', async () => {
    ;(await api()).binnedKappa.mockRejectedValueOnce(answered500())
    renderPanel()
    // The picker above offers two different measurements, so "agreement could
    // not be measured" alone would not say which one the researcher is looking
    // at. The bin-size control is still on screen beside it.
    expect(await screen.findByText('Moment-by-moment agreement could not be measured.'))
      .toBeInTheDocument()
    expect(screen.getByText(/Nothing in your project has changed\./)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.queryByText('Off-task')).toBeNull()
  })

  it('the OTHER method has its OWN failure sentence', async () => {
    ;(await api()).unitizingAlpha.mockRejectedValueOnce(answered500())
    renderPanel()
    await waitFor(() => expect(screen.getByText('Off-task')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('tab', { name: 'How it was carved up' }))
    expect(await screen.findByText(
      'Agreement about how the recording was carved up could not be measured.',
    )).toBeInTheDocument()
  })

  it('a FAILED method does not make the OTHER one look failed', async () => {
    // ⚠️ The disabled-query case, which is what makes a combined load wrong:
    // the inactive query is `enabled: false` with nothing cached, and
    // `listStatus` reports `loading` for exactly that shape — so a single load
    // over both would hold this panel on a notice whichever method is showing.
    ;(await api()).unitizingAlpha.mockRejectedValue(answered500())
    renderPanel()
    // Binned is the default and answers fine; the unitizing failure is not its.
    await waitFor(() => expect(screen.getByText('Off-task')).toBeInTheDocument())
    expect(screen.queryByText(/could not be measured/)).toBeNull()
    // ⚠️ …and NO non-ready notice at all. Without this line the case survived a
    // mutant that read the INACTIVE query's load: that query is disabled, so it
    // reports `loading`, and the panel rendered a "Measuring agreement…" line
    // ABOVE a fully drawn table while every other assertion here still passed.
    // #941's third meaning — the mutated line ran and the test could not see it.
    expect(screen.queryByText('Measuring agreement…')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    ;(await api()).unitizingAlpha.mockResolvedValue(undefined)
  })

  it('does NOT re-ask on its own when the server ANSWERED the refusal', async () => {
    const a = await api()
    a.binnedKappa.mockClear()
    a.binnedKappa.mockRejectedValue(answered500())
    renderPanel({ clientRetry: 1 })
    await screen.findByText('Moment-by-moment agreement could not be measured.')
    await new Promise(r => setTimeout(r, 30))
    expect(a.binnedKappa).toHaveBeenCalledTimes(1)
  })
})
