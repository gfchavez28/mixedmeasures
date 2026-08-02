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

vi.mock('@/lib/api', () => ({
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

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
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
