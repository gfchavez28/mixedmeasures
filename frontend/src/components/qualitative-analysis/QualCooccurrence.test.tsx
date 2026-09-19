/**
 * #963 Tier 3 — the co-occurrence matrix, which fetches for itself.
 *
 * 🔴 **MEASURED in Chrome on 2026-09-18**, on a canvas holding three embeds,
 * with `/code-analysis/cooccurrence` failing:
 *
 *   t = 2.5 s   "Loading co-occurrence matrix..."
 *   t = 10 s    "No coded units found with current filters."
 *
 * — sitting between two figures that had drawn fine, one of them printing
 * *"5 sources analyzed. 5 unique codes found."* So inside a written document
 * one figure stated, as a finding, that nothing matched, beside two proving the
 * project is coded; and it blamed the researcher's FILTERS for a request that
 * never arrived.
 *
 * ⚠️ `InlineChartRenderer` carries `notice('Chart unavailable')` for every
 * embed kind EXCEPT this one and the timeline, and says why in its own
 * comments: those two own their queries, so they render their own states. The
 * canvas delegated; the children never implemented. That is the whole
 * explanation for both canvas rows of this tier.
 *
 * The first suite for this component — it is an ordinary table, so it is
 * RENDERED rather than scanned.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { cooccurrence } = vi.hoisted(() => ({ cooccurrence: vi.fn() }))
vi.mock('@/lib/api', () => ({ codeAnalysisApi: { cooccurrence } }))
vi.mock('@/lib/theme-context', () => ({ useTheme: () => ({ isDark: false }) }))

import QualCooccurrence from './QualCooccurrence'
import type { CodeAnalysisFilterParams } from '@/lib/api'

const FILTERS = { source: 'all', exclude_facilitator: true } as CodeAnalysisFilterParams

/** Two codes that co-occur — the ANSWERED, non-empty payload. */
const MATRIX = {
  codes: [
    { id: 10, name: 'Pacing', color: '#3b82f6' },
    { id: 11, name: 'Rapport', color: '#ef4444' },
  ],
  matrix: [[4, 2], [2, 6]],
  max_cooccurrence: 4,
  total_coded_segments: 9,
  total_coded_texts: 0,
  source: 'all',
}

/** An ANSWERED refusal — duck-typed on `status`, like the real predicates. */
const answered500 = () => Object.assign(new Error('boom'), { status: 500 })

function renderMatrix(over: { noticeSize?: 'page' | 'panel' } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <QualCooccurrence
        projectId={1}
        filterParams={FILTERS}
        cooccurrenceLevel="segment"
        showProportion={false}
        {...over}
      />
    </QueryClientProvider>,
  )
}

afterEach(cleanup)
beforeEach(() => {
  cooccurrence.mockReset()
  cooccurrence.mockResolvedValue(MATRIX)
})

describe('#963 Tier 3 — what the co-occurrence matrix says before, and instead of, an answer', () => {
  it('READY with a matrix: it draws, and says nothing about filters (positive control)', async () => {
    renderMatrix()
    // Twice, deliberately: a co-occurrence matrix names each code on BOTH axes.
    expect(await screen.findAllByText('Pacing')).toHaveLength(2)
    expect(screen.queryByText(/No coded/)).toBeNull()
  })

  it('READY and genuinely empty: the filter sentence is TRUE, and is said', async () => {
    // The guard has to fail when the fix is over-applied — this claim is correct
    // about an answered payload and must survive. "units" rather than
    // "segments" because the fixture's source is `all`; that is the exact
    // sentence the canvas drive measured.
    cooccurrence.mockResolvedValue({ ...MATRIX, codes: [], matrix: [] })
    renderMatrix()
    expect(await screen.findByText('No coded units found with current filters.'))
      .toBeInTheDocument()
  })

  it('LOADING: says it is loading, and blames nobody', async () => {
    cooccurrence.mockReturnValue(new Promise(() => {}))
    renderMatrix()
    expect(await screen.findByText('Loading co-occurrence matrix…')).toBeInTheDocument()
    expect(screen.queryByText(/with current filters/)).toBeNull()
  })

  it('FAILED: says the LOAD failed, with a Retry, and never blames the filters', async () => {
    cooccurrence.mockRejectedValue(answered500())
    renderMatrix()
    expect(await screen.findByText('The co-occurrence matrix could not be loaded.'))
      .toBeInTheDocument()
    expect(screen.queryByText(/with current filters/)).toBeNull()
    expect(screen.getByText(/Nothing in your project has changed\./)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('the loading line carries the spinner the canvas export polls for', async () => {
    // ⚠️ `lib/canvas-export.ts::waitForChartsReady` holds a rasterization while
    // an embed shows `.animate-spin` OR the words "Loading chart". The old line
    // here was a bare `<div>Loading co-occurrence matrix...</div>` with NEITHER,
    // so an export could capture a half-drawn embed. `LoadingNotice` carries the
    // spin class, so the poll now holds for this one too.
    cooccurrence.mockReturnValue(new Promise(() => {}))
    const { container } = renderMatrix()
    await screen.findByText('Loading co-occurrence matrix…')
    expect(container.querySelector('.animate-spin')).not.toBeNull()
  })

  it('a FAILURE does NOT carry it — an export must not wait out its deadline', async () => {
    cooccurrence.mockRejectedValue(answered500())
    const { container } = renderMatrix()
    await screen.findByText('The co-occurrence matrix could not be loaded.')
    expect(container.querySelector('.animate-spin')).toBeNull()
    expect(screen.queryByText(/Loading chart/)).toBeNull()
  })

  it('takes the compact notice inside a canvas embed, the full one on the tab', async () => {
    // A full-height notice would open a hole in the researcher's prose; the
    // analysis tab is a whole screen and keeps the default.
    cooccurrence.mockReturnValue(new Promise(() => {}))
    const { container: panel } = renderMatrix({ noticeSize: 'panel' })
    const compact = await screen.findByText('Loading co-occurrence matrix…')
    expect(compact.closest('[role="status"]')?.className).toContain('py-4')
    expect(panel.querySelector('.py-16')).toBeNull()

    cleanup()
    renderMatrix()
    const full = await screen.findByText('Loading co-occurrence matrix…')
    expect(full.closest('[role="status"]')?.className).toContain('py-16')
  })
})
