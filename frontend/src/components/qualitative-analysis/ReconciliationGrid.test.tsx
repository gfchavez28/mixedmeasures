/**
 * Track J · J2-5 M-1 — ReconciliationGrid: tab-visibility gate (pure) + a render
 * test (rows, dual-encoded needs-review/agree, own-cell-only editing, read-only
 * consensus column) + the #471(b) chip-navigation flows.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, within, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }))

vi.mock('@/lib/api', () => ({
  codeAnalysisApi: {
    reconciliation: vi.fn().mockResolvedValue({
      available: true,
      reason: null,
      n_coders: 2,
      coders: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }],
      codes: [
        { id: 10, name: 'Positive', color: null },
        { id: 20, name: 'Negative', color: null },
      ],
      units: [
        {
          unit_type: 'segment', unit_id: 100, source_type: 'conversation', source_id: 5,
          source_label: 'Interview 1', text: 'I really liked the program.',
          by_coder: { '1': [10], '2': [20] }, engaged: [1, 2],
          consensus: [], consensus_context: {}, has_disagreement: true,
        },
        {
          unit_type: 'segment', unit_id: 101, source_type: 'conversation', source_id: 5,
          source_label: 'Interview 1', text: 'It was helpful overall.',
          by_coder: { '1': [10], '2': [10] }, engaged: [1, 2],
          consensus: [10], consensus_context: { '10': { rule: 'unanimous', agree: 2, voters: 2 } },
          has_disagreement: false,
        },
      ],
      total: 2,
      has_more: false,
    }),
    recomputeConsensus: vi.fn().mockResolvedValue({ recomputed: 0, remaining: 0 }),
  },
  codingApi: { applyCode: vi.fn(), removeCode: vi.fn() },
  textCodingApi: { applyCode: vi.fn(), removeCode: vi.fn() },
  codesApi: { create: vi.fn() },
  authApi: { switchCoder: vi.fn().mockResolvedValue({ id: 2, username: 'Bob' }) },
  // The source picker's option lists. The observation is FROZEN — an open clip
  // set is never gathered for reliability, so offering it would narrow to an
  // empty grid with no explanation.
  conversationsApi: {
    list: vi.fn().mockResolvedValue({ conversations: [{ id: 5, name: 'Interview 1' }], total: 1 }),
  },
  documentsApi: { list: vi.fn().mockResolvedValue([]) },
  observationsApi: {
    list: vi.fn().mockResolvedValue([
      { id: 7, name: 'Playground', segmentation_frozen_at: '2026-07-19T12:00:00+00:00' },
      { id: 8, name: 'Still cutting', segmentation_frozen_at: null },
    ]),
  },
}))

// useNavigate (#471b chip navigation) — spy so the deep-link target is assertable without
// a router. useCoderSwitch needs the active coder (Alice) from auth-context.
vi.mock('react-router', async (orig) => ({
  ...(await orig() as object),
  useNavigate: () => navigateMock,
}))
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 1, username: 'Alice' }, refreshAuth: vi.fn() }),
}))

import ReconciliationGrid from './ReconciliationGrid'
import {
  selectableObservations, sourceParams, sourceQueryKey,
} from '@/lib/reconciliation-source'
import { isReconciliationTabVisible } from '@/lib/qual-analysis-types'
import type { Code } from '@/lib/api'

afterEach(() => { cleanup(); navigateMock.mockClear() })

const CODES = [
  { id: 10, name: 'Positive', color: '#10b981', is_active: true, is_universal: false },
  { id: 20, name: 'Negative', color: '#ef4444', is_active: true, is_universal: false },
] as unknown as Code[]

function renderGrid(currentUserId: number | null = 1) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ReconciliationGrid
        projectId={42}
        codes={CODES}
        currentUserId={currentUserId}
        staleCount={3}
        setSrAnnouncement={() => {}}
      />
    </QueryClientProvider>,
  )
}

describe('isReconciliationTabVisible', () => {
  it('requires both multi-coder AND an existing consensus layer', () => {
    expect(isReconciliationTabVisible(true, true)).toBe(true)
    expect(isReconciliationTabVisible(false, true)).toBe(false)
    expect(isReconciliationTabVisible(true, false)).toBe(false)
    expect(isReconciliationTabVisible(false, false)).toBe(false)
  })
  it('is hidden while blind (DEC-G — reconciliation reveals every coder)', () => {
    expect(isReconciliationTabVisible(true, true, true)).toBe(false)
    expect(isReconciliationTabVisible(true, true, false)).toBe(true)
  })
})

describe('ReconciliationGrid', () => {
  it('renders coder + consensus columns and one row per unit', async () => {
    renderGrid()
    await waitFor(() => expect(screen.getByRole('grid', { name: /reconciliation/i })).toBeInTheDocument())
    expect(screen.getByRole('columnheader', { name: /Alice/ })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Bob' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Consensus' })).toBeInTheDocument()
    // 2 data units rendered.
    expect(screen.getAllByRole('row')).toHaveLength(3) // header + 2 units
  })

  it('#470: dual-encodes needs-review/agree with text (not color-only) + a source-level tooltip', async () => {
    renderGrid()
    await waitFor(() => screen.getByRole('grid', { name: /reconciliation/i }))
    // "Needs review" also names the filter toggle now — target the badge by its title.
    const needsReview = screen.getByTitle(/Flagged for review/)
    expect(needsReview).toHaveTextContent('Needs review') // unit 100
    expect(screen.getByText('Agree')).toBeInTheDocument()  // unit 101
  })

  it('#471(c): marks the active coder column header with a "(you)" label', async () => {
    renderGrid(1) // Alice is active
    await waitFor(() => screen.getByRole('grid', { name: /reconciliation/i }))
    const alice = screen.getByRole('columnheader', { name: /Alice/ })
    expect(within(alice).getByText('(you)')).toBeInTheDocument()
    const bob = screen.getByRole('columnheader', { name: 'Bob' })
    expect(within(bob).queryByText('(you)')).toBeNull()
  })

  it('#477: defines "blank (reviewed)" vs "not reviewed" in the footnote legend', async () => {
    renderGrid()
    await waitFor(() => screen.getByRole('grid', { name: /reconciliation/i }))
    expect(screen.getByText(/excluded from reliability/i)).toBeInTheDocument()
  })

  it('makes ONLY the current coder cell editable (InlineCodeActions add button)', async () => {
    renderGrid(1) // Alice is the active coder
    await waitFor(() => screen.getByRole('grid', { name: /reconciliation/i }))
    // One "Add code" affordance per row's OWN (Alice) cell → 2 units → 2 buttons.
    expect(screen.getAllByRole('button', { name: 'Add code' })).toHaveLength(2)
  })

  it('renders the consensus column read-only with the rule badge', async () => {
    renderGrid()
    await waitFor(() => screen.getByRole('grid', { name: /reconciliation/i }))
    // Unit 100 has no consensus.
    expect(screen.getByText('No consensus')).toBeInTheDocument()
    // Unit 101 consensus = Positive, unanimous → a consensus gridcell announces the rule.
    const consensusCell = screen.getByRole('gridcell', { name: /Consensus: Positive \(unanimous/ })
    expect(consensusCell).toBeInTheDocument()
    // No editable add affordance inside the consensus cell.
    expect(within(consensusCell).queryByRole('button', { name: 'Add code' })).toBeNull()
  })

  it('#471(b): a consensus chip jumps to the source segment (read-only, no switch)', async () => {
    renderGrid()
    await waitFor(() => screen.getByRole('grid', { name: /reconciliation/i }))
    const consensusCell = screen.getByRole('gridcell', { name: /Consensus: Positive \(unanimous/ })
    fireEvent.click(within(consensusCell).getByRole('button'))
    expect(navigateMock).toHaveBeenCalledWith('/projects/42/conversations/5?segment=101')
  })

  it('#471(b): a colleague chip routes through the coder-switch confirm (does not navigate yet)', async () => {
    renderGrid(1) // Alice active; Bob is the colleague
    await waitFor(() => screen.getByRole('grid', { name: /reconciliation/i }))
    // Bob's only chip is "Negative" (unit 100) — unique across the grid.
    fireEvent.click(screen.getByText('Negative'))
    expect(await screen.findByText('Code as Bob?')).toBeInTheDocument()
    expect(navigateMock).not.toHaveBeenCalled() // navigation happens only after confirm
  })

  it('shows the recompute control and the stale-layer note', async () => {
    renderGrid()
    await waitFor(() => screen.getByRole('grid', { name: /reconciliation/i }))
    expect(screen.getByRole('button', { name: /recompute consensus/i })).toBeInTheDocument()
    expect(screen.getByText(/3 updates behind/i)).toBeInTheDocument()
  })

  it('arrow-navigates even when the keydown originates inside a cell (A11y-1)', async () => {
    // After the add-code popover closes, focus sits on a control INSIDE the cell.
    // Arrow keys must still move the roving tab-stop (the pre-fix exact-match guard
    // stranded it). Fire ArrowDown from the in-cell "Needs review" badge, not the cell div.
    renderGrid()
    await waitFor(() => screen.getByRole('grid', { name: /reconciliation/i }))
    expect(screen.getAllByRole('rowheader')[0]).toHaveAttribute('tabindex', '0')
    expect(screen.getAllByRole('rowheader')[1]).toHaveAttribute('tabindex', '-1')

    fireEvent.keyDown(screen.getByTitle(/Flagged for review/), { key: 'ArrowDown' })

    expect(screen.getAllByRole('rowheader')[1]).toHaveAttribute('tabindex', '0')
    expect(screen.getAllByRole('rowheader')[0]).toHaveAttribute('tabindex', '-1')
  })

  it('renders a clip row by its TIME RANGE and deep-links with ?clip=', async () => {
    // A clip's `text` is only its label and is routinely empty, so the range is
    // the identity. The deep-link param is ?clip=, not ?segment= — without that
    // arm the jump affordance was dead, and fixColleague was worse than dead
    // (it switched the active coder, then navigated nowhere).
    const { codeAnalysisApi } = await import('@/lib/api')
    ;(codeAnalysisApi.reconciliation as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      available: true, reason: null, n_coders: 2,
      coders: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }],
      codes: [{ id: 10, name: 'Positive', color: null }],
      units: [{
        unit_type: 'segment', unit_id: 300, source_type: 'observation', source_id: 7,
        source_label: 'Playground', text: '',
        start_time: 62.5, end_time: 91,
        by_coder: { '1': [10], '2': [] }, engaged: [1, 2],
        consensus: [], consensus_context: {}, has_disagreement: true,
      }],
      total: 1, has_more: false,
    })
    renderGrid()
    await waitFor(() => screen.getByRole('grid', { name: /reconciliation/i }))

    expect(screen.getByText('1:02.5 – 1:31.0')).toBeInTheDocument()
    // An unlabelled clip is normal, not a defect — no "(no text)" placeholder.
    expect(screen.queryByText('(no text)')).not.toBeInTheDocument()
    expect(screen.getAllByRole('rowheader')[0]).toHaveAttribute(
      'aria-label', expect.stringContaining('Clip · Playground'))
  })

  it('omits source params until a source is chosen', async () => {
    const { codeAnalysisApi } = await import('@/lib/api')
    const spy = codeAnalysisApi.reconciliation as ReturnType<typeof vi.fn>
    spy.mockClear()
    renderGrid()
    await waitFor(() => screen.getByRole('grid', { name: /reconciliation/i }))
    expect(spy).toHaveBeenCalledWith(
      42, expect.not.objectContaining({ source_type: expect.anything() }))
  })

  it('exposes the source picker as a labelled control', async () => {
    renderGrid()
    await waitFor(() => screen.getByRole('grid', { name: /reconciliation/i }))
    expect(screen.getByRole('combobox', { name: /narrow reconciliation to one source/i }))
      .toBeInTheDocument()
  })
})

// The picker's mapping is unit-tested rather than driven through the UI: Radix
// Select does not open under synthetic events in jsdom, and the behavior that
// actually matters here is the key/params pair, not the menu mechanics.
describe('ReconciliationSourcePicker mapping', () => {
  it('keys the query on the chosen source, and on nothing when showing all', () => {
    expect(sourceQueryKey(null)).toBeNull()
    expect(sourceQueryKey({ type: 'observation', id: 7 })).toBe('observation:7')
    // Distinct kinds sharing an id must not collide — the four id sequences are
    // independent, so the tag is the only thing keeping them apart.
    expect(sourceQueryKey({ type: 'document', id: 7 }))
      .not.toBe(sourceQueryKey({ type: 'observation', id: 7 }))
  })

  it('sends no source params when showing all sources', () => {
    expect(sourceParams(null)).toEqual({})
    expect(sourceParams({ type: 'conversation', id: 5 }))
      .toEqual({ source_type: 'conversation', source_id: 5 })
  })

  it('offers only FROZEN observations', () => {
    const rows = [
      { id: 7, segmentation_frozen_at: '2026-07-19T12:00:00+00:00' },
      { id: 8, segmentation_frozen_at: null },
    ]
    expect(selectableObservations(rows).map(o => o.id)).toEqual([7])
  })
})
