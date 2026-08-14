/**
 * Slab 6c surface pins. The load-bearing behaviors:
 * - the table shows the UNION airtime (the compute's don't-double-count core,
 *   asserted through the rendered surface so a wiring regression is caught);
 * - the codeline is aria-hidden and the TABLE is its accessible equivalent —
 *   the two must render together (§8q DEC-6c-4);
 * - the extent fallback is LABELLED, never presented as the recording's length
 *   (#622's rule one surface over);
 * - the disclosures render: don't-sum always, instant-marks and coder-pooling
 *   conditionally;
 * - the by-coder mode is multiCoder-gated and dual-encodes attribution.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { listSegments } = vi.hoisted(() => ({ listSegments: vi.fn() }))
vi.mock('@/lib/api', () => ({ observationsApi: { listSegments } }))

import TimedAnalytics from './TimedAnalytics'

afterEach(() => { cleanup(); listSegments.mockReset() })

const seg = (id: number, start: number, end: number, details: Array<[number, number | null]>) => ({
  id, sequence_order: id, start_time: start, end_time: end, text: '',
  applied_codes: details.map(d => d[0]),
  applied_code_details: details.map(([code_id, user_id]) => ({ code_id, user_id, is_universal: false })),
  attached_notes: [], created_at: '2026-07-19T00:00:00+00:00',
})

// Code 10: [0,30]+[20,50] overlap (union 50, sum 60) + a point event at 100.
const CLIPS = [
  seg(1, 0, 30, [[10, 1]]),
  seg(2, 20, 50, [[10, 2]]),
  seg(3, 100, 100, [[10, 1]]),
]

const OBS = { id: 7, name: 'Playground', media_duration_seconds: null, segmentation_frozen_at: null }
const CODES = [{ id: 10, name: 'Off-task', color: '#e05d5d', category_id: null, category_color: null }]
const CODERS = new Map([[1, { id: 1, username: 'Ada' }], [2, { id: 2, username: 'Blake' }]])

function renderTimed(over: Partial<React.ComponentProps<typeof TimedAnalytics>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <TimedAnalytics
        projectId={1}
        observations={[OBS]}
        codes={CODES}
        categories={[]}
        include={null}
        multiCoder
        coderMap={CODERS}
        {...over}
      />
    </QueryClientProvider>,
  )
}

describe('TimedAnalytics', () => {
  it('shows the UNION airtime, the marked-extent label, and every due disclosure', async () => {
    listSegments.mockResolvedValue(CLIPS)
    renderTimed()
    await waitFor(() => expect(screen.getByRole('row', { name: /Off-task/ })).toBeInTheDocument())

    // Union 0-50 of a 100s marked extent (the point event sets the extent's
    // far edge): airtime 0:50.0 at 50% — a summed implementation would say 60.
    const row = screen.getByRole('row', { name: /Off-task/ })
    expect(row).toHaveTextContent('0:50.0')
    expect(row).toHaveTextContent('50%')
    expect(row).toHaveTextContent('3') // marks incl. the point event

    // #622's rule: the fallback denominator is labelled, never stated as fact.
    expect(screen.getByTitle(/Recording length unknown/)).toHaveTextContent('1:40.0 marked')

    const note = screen.getByText(/don’t sum to the covered total/)
    expect(note).toHaveTextContent('1 instant mark count')
    expect(note).toHaveTextContent('pools all visible coders’ marks')
  })

  it('keeps the codeline decorative and the table semantic — they render together', async () => {
    listSegments.mockResolvedValue(CLIPS)
    const { container } = renderTimed()
    await waitFor(() => expect(screen.getByRole('row', { name: /Off-task/ })).toBeInTheDocument())
    const hidden = container.querySelectorAll('[aria-hidden="true"] table')
    expect(hidden).toHaveLength(0) // the table is NEVER inside the hidden layer
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull() // the codeline is
    expect(screen.getByRole('table', { name: /Timed analytics for Playground/ })).toBeInTheDocument()
  })

  it('splits into dual-encoded per-coder rows in by-coder mode', async () => {
    listSegments.mockResolvedValue(CLIPS)
    renderTimed()
    await waitFor(() => expect(screen.getByRole('row', { name: /Off-task/ })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('tab', { name: 'By code × coder' }))
    await waitFor(() => expect(screen.getByText('Ada')).toBeInTheDocument())
    expect(screen.getByText('Blake')).toBeInTheDocument()
    expect(screen.getByText('AD')).toBeInTheDocument() // initials badge, not color-only
    const ada = screen.getByRole('row', { name: /Ada/ })
    expect(ada).toHaveTextContent('0:30.0') // Ada's own union: 0-30 (point adds nothing)
  })

  it('hides the by-coder toggle on single-coder installs', async () => {
    listSegments.mockResolvedValue(CLIPS)
    renderTimed({ multiCoder: false })
    await waitFor(() => expect(screen.getByRole('row', { name: /Off-task/ })).toBeInTheDocument())
    expect(screen.queryByRole('tab', { name: 'By code × coder' })).not.toBeInTheDocument()
  })

  it('says so when an observation has no clips', async () => {
    listSegments.mockResolvedValue([])
    renderTimed()
    await waitFor(() =>
      expect(screen.getByText('No clips in this observation yet.')).toBeInTheDocument())
  })

  it('prompts for a source when no observation is selected', () => {
    renderTimed({ observations: [] })
    expect(screen.getByText(/No observations selected/)).toBeInTheDocument()
  })

  it('refuses the consensus layer scope instead of showing human numbers under it', () => {
    // Live-drive find: the toolbar disables the TYPE under consensus, but a
    // timeline already active when the layer switched kept rendering human-
    // layer numbers under a consensus banner (the DEC-6c-7 case).
    listSegments.mockResolvedValue(CLIPS)
    renderTimed({ consensusScope: true })
    expect(screen.getByText(/reads the human coding layer/)).toBeInTheDocument()
    expect(screen.queryByText('Share of session')).not.toBeInTheDocument()
    expect(listSegments).not.toHaveBeenCalled() // the queries stay off too
  })
})

describe('chart formatting reaches the codeline (#686)', () => {
  it('scales the lane labels with labelFontSize, keeping the ruler recessive', async () => {
    // Every sibling qualitative component honours the material's
    // `labelFontSize`; this one hardcoded 10px/11px, so the researcher's choice
    // silently did nothing — on the analysis view as much as on the canvas.
    // The two sizes stay DISTINCT (a recessive ruler under larger lane labels),
    // so they scale relative rather than both snapping to one value.
    listSegments.mockResolvedValue(CLIPS)
    renderTimed({ labelFontSize: 20 })

    // 'Off-task' renders twice — the codeline lane label (first in DOM order)
    // and the table's row header. The lane label is the one that scales.
    await screen.findByRole('table')
    expect(screen.getAllByText('Off-task')[0]).toHaveStyle({ fontSize: '19px' })

    // The ruler renders the extent's tick labels; 0:00.0 is the first.
    const tick = screen.getAllByText('0:00.0')[0]
    expect(tick.parentElement).toHaveStyle({ fontSize: '18px' })
  })

  it('reproduces the original hardcoded sizes when no formatting is given', async () => {
    listSegments.mockResolvedValue(CLIPS)
    renderTimed()

    await screen.findByRole('table')
    expect(screen.getAllByText('Off-task')[0]).toHaveStyle({ fontSize: '11px' })
    expect(screen.getAllByText('0:00.0')[0].parentElement).toHaveStyle({ fontSize: '10px' })
  })
})
