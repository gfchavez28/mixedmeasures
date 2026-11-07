/**
 * #1531 D99 (1.5.9) — Text Coding's Cross-analysis follows blind mode.
 *
 * Measured before (one install, 2026-11-05): with colleagues hidden on the same toolbar, the
 * panel's coder filter opened on *"Show all · Just me · Researcher · Alice (you) · Bob"* — a
 * colleague BY NAME — and its counts were every coder's (*"Bob theme 2w n=1"*). Now, while blind
 * mode WITHHOLDS: the filter is not rendered (DEC-G), every request (and so the CSV) asks for the
 * viewer's own coding, each key carries that scope (#454 — a reveal must refetch), the reads wait
 * for the scope to settle (#964), and one notice says so with the logged reveal.
 *
 * The no-leak test has its NEGATIVE-OF-NEGATIVE twin: the same probe, on the same render with
 * nothing withheld, FINDS the colleague's name — so a probe that cannot see names (the #770
 * trap: an absence asserted in the wrong channel) fails the pair.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { TextCodingColumn } from '@/lib/api'

const h = vi.hoisted(() => ({
  blind: { blind: true, withholding: true, settled: true },
  consensusExists: false,
  toggleReveal: (() => {}) as (surface?: string) => void,
  coders: [
    { id: 2, username: 'Alice', color: null, coder_type: 'human' },
    { id: 3, username: 'Bob', color: null, coder_type: 'human' },
  ],
}))

const responseLength = vi.fn((..._a: unknown[]) => new Promise(() => {}))
const codeDensity = vi.fn((..._a: unknown[]) => new Promise(() => {}))
const exportCrossAnalysis = vi.fn((..._a: unknown[]) => Promise.resolve())

vi.mock('@/lib/api', () => ({
  textAnalysisApi: {
    filteredFrequencies: vi.fn(() => new Promise(() => {})),
    crossTabulation: vi.fn(() => new Promise(() => {})),
    codeDensity: (...a: unknown[]) => codeDensity(...a),
    responseLength: (...a: unknown[]) => responseLength(...a),
    exportCrossAnalysis: (...a: unknown[]) => exportCrossAnalysis(...a),
  },
  datasetsApi: { allColumns: vi.fn(() => Promise.resolve({ columns: [] })) },
  recodeApi: { getFrequencies: vi.fn(() => new Promise(() => {})) },
}))
vi.mock('@/hooks/useBlindMode', () => ({
  useBlindMode: () => ({ ...h.blind, blindLens: new Set<number>(), toggleReveal: h.toggleReveal }),
}))
vi.mock('@/hooks/useCoders', () => ({ useCoders: () => ({ coders: h.coders, multiCoder: true }) }))
vi.mock('@/hooks/useConsensusStatus', () => ({
  useConsensusStatus: () => ({ data: { exists: h.consensusExists, stale_count: 0 } }),
}))
vi.mock('@/hooks/useCoderCoverage', () => ({ useProjectCoderKinds: () => ({ hasMachine: false }) }))
vi.mock('@/lib/auth-context', () => ({ useAuth: () => ({ user: { id: 2, username: 'Alice' } }) }))

import CrossAnalysisPanel from './CrossAnalysisPanel'

const COLUMN: TextCodingColumn = {
  column_id: 10, dataset_id: 5, dataset_name: 'Survey', column_name: 'q1', column_text: 'What did you think?',
  column_type: 'open_text', sequence_order: 0, total_rows: 2, non_empty_rows: 2, coded_rows: 2,
}
const BLIND = { blind: true, withholding: true, settled: true }
const NOTHING_WITHHELD = { blind: false, withholding: false, settled: true }

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  h.blind = { ...BLIND }
  h.consensusExists = false
  h.toggleReveal = () => {}
})

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const ui = () => (
    <QueryClientProvider client={client}>
      <CrossAnalysisPanel projectId={1} focalColumnIds={[10]} textColumns={[COLUMN]} />
    </QueryClientProvider>
  )
  const result = render(ui())
  return { ...result, rerenderPanel: () => result.rerender(ui()) }
}

/** Every channel a name is published on: rendered text, and the naming/describing attributes —
 *  including inside portals (a popover's content renders at the end of `<body>`). */
function colleagueNamedAnywhere(name: string): boolean {
  if (document.body.textContent?.includes(name)) return true
  for (const el of document.body.querySelectorAll('*')) {
    for (const attr of ['aria-label', 'title', 'aria-description', 'aria-valuetext', 'placeholder']) {
      if (el.getAttribute(attr)?.includes(name)) return true
    }
  }
  return false
}

describe('Cross-analysis while blind (#1531 D99)', () => {
  it('names no colleague — not in text, aria-label or title — and renders no coder filter', async () => {
    renderPanel()
    await waitFor(() => expect(responseLength).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: /Filter codes by coder/ })).toBeNull()
    expect(colleagueNamedAnywhere('Bob')).toBe(false)
  })

  it('NEGATIVE-OF-NEGATIVE: with nothing withheld the same probe FINDS the colleague (the filter lists him)', async () => {
    h.blind = { ...NOTHING_WITHHELD }
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /Filter codes by coder/ }))
    await waitFor(() => expect(colleagueNamedAnywhere('Bob')).toBe(true))
  })

  it('asks every read for the viewer alone while withholding, and for every coder otherwise', async () => {
    renderPanel()
    await waitFor(() => expect(responseLength).toHaveBeenCalled())
    expect(responseLength.mock.calls[0][1]).toMatchObject({ coder_ids: '2' })
    expect(codeDensity.mock.calls[0][1]).toMatchObject({ coder_ids: '2' })
    cleanup()
    vi.clearAllMocks()
    h.blind = { ...NOTHING_WITHHELD }
    renderPanel()
    await waitFor(() => expect(responseLength).toHaveBeenCalled())
    expect((responseLength.mock.calls[0][1] as { coder_ids?: string }).coder_ids).toBeUndefined()
  })

  it('a reveal is a NEW key — the reads are asked again for every coder (#454)', async () => {
    const { rerenderPanel } = renderPanel()
    await waitFor(() => expect(responseLength).toHaveBeenCalledTimes(1))
    h.blind = { ...NOTHING_WITHHELD }
    rerenderPanel()
    await waitFor(() => expect(responseLength).toHaveBeenCalledTimes(2))
    expect((responseLength.mock.calls[1][1] as { coder_ids?: string }).coder_ids).toBeUndefined()
  })

  it('waits for the scope to settle before asking anything (#964)', async () => {
    h.blind = { blind: false, withholding: true, settled: false }
    renderPanel()
    await new Promise(r => setTimeout(r, 50))
    expect(responseLength).not.toHaveBeenCalled()
    expect(codeDensity).not.toHaveBeenCalled()
  })

  it('says so once, with the logged reveal (surface "cross_analysis")', async () => {
    const reveals: (string | undefined)[] = []
    h.toggleReveal = s => { reveals.push(s) }
    renderPanel()
    expect(screen.getByText(/Blind mode is on — these counts and the CSV hold only your own coding/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Colleagues hidden' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Reveal' }))
    expect(reveals).toEqual(['cross_analysis'])
  })

  it('says nothing under the consensus layer (one synthetic coder — DEC-H) — positive control: it does under Coders', () => {
    h.consensusExists = true
    renderPanel()
    expect(screen.getByText(/Blind mode is on/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Consensus' }))
    expect(screen.queryByText(/Blind mode is on/)).toBeNull()
  })

  it('the CSV follows the panel, and waits for the scope like the reads', async () => {
    renderPanel()
    const button = screen.getByRole('button', { name: /Export Cross-Analysis/ })
    expect(button).not.toHaveAttribute('aria-disabled')
    fireEvent.click(button)
    expect(exportCrossAnalysis.mock.calls[0][1]).toMatchObject({ coder_ids: '2' })
    cleanup()
    vi.clearAllMocks()
    h.blind = { blind: false, withholding: true, settled: false }
    renderPanel()
    const waiting = screen.getByRole('button', { name: /Export Cross-Analysis/ })
    expect(waiting).toHaveAttribute('aria-disabled', 'true')
    expect(waiting).not.toBeDisabled()
    fireEvent.click(waiting)
    expect(exportCrossAnalysis).not.toHaveBeenCalled()
  })
})
