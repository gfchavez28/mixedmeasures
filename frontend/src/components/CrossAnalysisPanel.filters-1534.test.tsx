/**
 * #1534 D103/D107/D108 (1.5.9) — the Cross-analysis CSV asks for the comparison on screen.
 *
 * Before: the export sent `filters=` (the route reads `filters_json`, and FastAPI dropped the
 * other without a word), so no release's file held the comparison; and it sent the raw list
 * whenever it was non-empty, finished or not. Now ONE decision (`readyFilters`) feeds the
 * comparison's request and the export, the export sends `filters_json`, and it waits — with
 * its reason — while a filter is unfinished. The route's own name is pinned across the
 * boundary by `lib/api/request-contract.test.ts`.
 *
 * `SubgroupFilterPanel` is replaced by a button that hands the panel an exact filter list, so
 * these tests drive the PANEL's decisions, not the filter editor.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SubgroupFilter, TextCodingColumn } from '@/lib/api'
import { FILTERS_REACH_NOTE, UNFINISHED_FILTER_REASON } from '@/lib/subgroup-filters'

const h = vi.hoisted(() => ({
  next: [] as unknown[],
  unfiltered: [] as string[],
}))

const filteredFrequencies = vi.fn((..._a: unknown[]) => Promise.resolve({
  filtered: { row_count: 3, text_count: 3, frequencies: [
    { code_id: 1, code_name: 'A theme', code_color: '#888888', count: 2, percentage: 66.7 },
  ] },
  overall: { row_count: 6, text_count: 6, frequencies: [
    { code_id: 1, code_name: 'A theme', code_color: '#888888', count: 3, percentage: 50 },
  ] },
  filter_description: 'region is one of North',
  filter_scope: { filtered_datasets: ['Wave 1'], unfiltered_datasets: h.unfiltered },
}))
const exportCrossAnalysis = vi.fn((..._a: unknown[]) => Promise.resolve())

vi.mock('@/lib/api', () => ({
  textAnalysisApi: {
    filteredFrequencies: (...a: unknown[]) => filteredFrequencies(...a),
    crossTabulation: vi.fn(() => new Promise(() => {})),
    codeDensity: vi.fn(() => new Promise(() => {})),
    responseLength: vi.fn(() => new Promise(() => {})),
    exportCrossAnalysis: (...a: unknown[]) => exportCrossAnalysis(...a),
  },
  datasetsApi: { allColumns: vi.fn(() => Promise.resolve({ columns: [] })) },
}))
vi.mock('./SubgroupFilterPanel', () => ({
  default: (p: { onFiltersChange: (f: unknown[]) => void }) => (
    <button type="button" onClick={() => p.onFiltersChange(h.next)}>set filters</button>
  ),
}))
vi.mock('@/hooks/useBlindMode', () => ({
  useBlindMode: () => ({ blind: false, withholding: false, settled: true, blindLens: new Set<number>(), toggleReveal: () => {} }),
}))
vi.mock('@/hooks/useCoders', () => ({ useCoders: () => ({ coders: [], multiCoder: false }) }))
vi.mock('@/hooks/useConsensusStatus', () => ({ useConsensusStatus: () => ({ data: { exists: false, stale_count: 0 } }) }))
vi.mock('@/hooks/useCoderCoverage', () => ({ useProjectCoderKinds: () => ({ hasMachine: false }) }))
vi.mock('@/lib/auth-context', () => ({ useAuth: () => ({ user: { id: 2, username: 'Alice' } }) }))

import CrossAnalysisPanel from './CrossAnalysisPanel'

const COLUMN: TextCodingColumn = {
  column_id: 10, dataset_id: 5, dataset_name: 'Wave 1', column_name: 'q1', column_text: 'What happened?',
  column_type: 'open_text', sequence_order: 0, total_rows: 6, non_empty_rows: 6, coded_rows: 5,
}
const NORTH: SubgroupFilter[] = [{ column_id: 7, operator: 'in', values: ['North'] }]
const UNFINISHED: SubgroupFilter[] = [...NORTH, { column_id: 8, operator: 'gte', value: '' }]

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  h.next = []
  h.unfiltered = []
})

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <CrossAnalysisPanel projectId={1} focalColumnIds={[10]} textColumns={[COLUMN]} />
    </QueryClientProvider>,
  )
}

function setFilters(list: SubgroupFilter[]) {
  h.next = list
  fireEvent.click(screen.getByRole('button', { name: 'set filters' }))
}

const exportButton = () => screen.getByRole('button', { name: /Export Cross-Analysis/ })

describe('Cross-analysis CSV — the comparison on screen (#1534)', () => {
  it('D103: finished filters — the export sends filters_json, exactly the list the comparison asked for', async () => {
    renderPanel()
    setFilters(NORTH)
    await waitFor(() => expect(filteredFrequencies).toHaveBeenCalled())
    const asked = (filteredFrequencies.mock.calls[0][1] as { filters: SubgroupFilter[] }).filters
    fireEvent.click(exportButton())
    expect(exportCrossAnalysis).toHaveBeenCalledTimes(1)
    const sent = exportCrossAnalysis.mock.calls[0][1] as Record<string, unknown>
    expect(sent).not.toHaveProperty('filters')
    expect(JSON.parse(sent.filters_json as string)).toEqual(asked)
    expect(asked).toEqual(NORTH)
  })

  it('D103: no filters — the export sends none and nothing waits (positive control)', () => {
    renderPanel()
    expect(exportButton()).not.toHaveAttribute('aria-disabled')
    fireEvent.click(exportButton())
    expect((exportCrossAnalysis.mock.calls[0][1] as Record<string, unknown>).filters_json).toBeUndefined()
    expect(screen.queryByText(UNFINISHED_FILTER_REASON)).toBeNull()
  })

  it('D103: an unfinished filter — the comparison is not asked, and the export waits and says why', async () => {
    renderPanel()
    setFilters(UNFINISHED)
    const button = exportButton()
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).not.toBeDisabled()
    expect(button).toHaveAccessibleDescription(UNFINISHED_FILTER_REASON)
    fireEvent.click(button)
    expect(exportCrossAnalysis).not.toHaveBeenCalled()
    await new Promise(r => setTimeout(r, 400))
    expect(filteredFrequencies).not.toHaveBeenCalled()
  })

  it('D108: while a filter is set, one line says the filters reach the comparison only', () => {
    renderPanel()
    expect(screen.queryByText(FILTERS_REACH_NOTE)).toBeNull()
    setFilters(NORTH)
    expect(screen.getByText(FILTERS_REACH_NOTE)).toBeInTheDocument()
  })

  it('D107: a focal dataset no filter judges is named inside the comparison', async () => {
    h.unfiltered = ['Wave 2']
    renderPanel()
    setFilters(NORTH)
    expect(await screen.findByText(
      'Wave 2 is not in this comparison: none of the filters applies to its records.',
    )).toBeInTheDocument()
  })

  it('D107: every focal dataset compared — no sentence (positive control for the absence)', async () => {
    renderPanel()
    setFilters(NORTH)
    await screen.findByText('Code Frequencies')
    expect(screen.queryByText(/is not in this comparison/)).toBeNull()
  })
})
