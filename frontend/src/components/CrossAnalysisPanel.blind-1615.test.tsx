/**
 * #1615 — Text Coding's Cross-analysis tells the server when blind mode withholds, so a filter,
 * a cross-tab variable or a density grouping worked out from participant scores is refused.
 *
 * The panel's `coder_ids` is ALSO a lead's coder filter (not blind), so the blind signal is D273's
 * separate flag, `ratings_follow_coder_ids`, sent ONLY while withholding — on the four reads that
 * take a picked column (the comparison, the cross-tab, the density, the CSV), never on the
 * response length (it reads the focal texts only). The flag is in the three query KEYS: a lead
 * filtering to herself sends the very `coder_ids` blind mode sends, so a key without it would serve
 * her unrefused answer to the blind panel (multicoder.md *Blind-scope cache correctness*). A
 * refused density grouping is SAID (the server's sentence), never an empty panel.
 *
 * jsdom: `SubgroupFilterPanel`, the coder filter and the Radix `Select` are replaced by buttons
 * that hand the panel exact values (the 1534 test's pattern) — the build session drives it live.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { TextCodingColumn } from '@/lib/api'
import { ApiError } from '@/lib/api/client'

const REFUSAL = '“band” cannot form groups while blind: it comes from participant scores, which combine every coder\'s ratings, so its groups would show your colleagues\' judgements.'

const h = vi.hoisted(() => ({
  blind: { blind: true, withholding: true, settled: true },
  pick: 77,
  user: { id: 2, username: 'Alice' } as { id: number; username: string } | null,
}))

const filteredFrequencies = vi.fn((..._a: unknown[]) => new Promise(() => {}))
const crossTabulation = vi.fn((..._a: unknown[]) => new Promise(() => {}))
const codeDensity = vi.fn((..._a: unknown[]): Promise<unknown> => new Promise(() => {}))
const responseLength = vi.fn((..._a: unknown[]) => new Promise(() => {}))
const exportCrossAnalysis = vi.fn((..._a: unknown[]) => Promise.resolve())

vi.mock('@/lib/api', () => ({
  textAnalysisApi: {
    filteredFrequencies: (...a: unknown[]) => filteredFrequencies(...a),
    crossTabulation: (...a: unknown[]) => crossTabulation(...a),
    codeDensity: (...a: unknown[]) => codeDensity(...a),
    responseLength: (...a: unknown[]) => responseLength(...a),
    exportCrossAnalysis: (...a: unknown[]) => exportCrossAnalysis(...a),
  },
  datasetsApi: { allColumns: vi.fn(() => Promise.resolve({ columns: [] })) },
}))
vi.mock('./SubgroupFilterPanel', () => ({
  default: (p: { onFiltersChange: (f: unknown[]) => void }) => (
    <button type="button" onClick={() => p.onFiltersChange([{ column_id: 77, operator: 'gte', value: '3' }])}>
      set filters
    </button>
  ),
}))
vi.mock('./CoderFilterPopover', () => ({
  // A lead hides Bob: her filter is then `coder_ids: [2]` — the very scope blind mode sends.
  default: (p: { onChange: (s: Set<number>) => void }) => (
    <button type="button" onClick={() => p.onChange(new Set([3]))}>just me</button>
  ),
}))
vi.mock('@/components/ui/select', () => ({
  Select: (p: { onValueChange: (v: string) => void; children: ReactNode }) => (
    <div>{p.children}<button type="button" onClick={() => p.onValueChange(String(h.pick))}>pick</button></div>
  ),
  SelectTrigger: () => null, SelectValue: () => null, SelectContent: () => null, SelectItem: () => null,
}))
vi.mock('@/hooks/useBlindMode', () => ({
  useBlindMode: () => ({ ...h.blind, blindLens: new Set<number>(), toggleReveal: () => {} }),
}))
vi.mock('@/hooks/useCoders', () => ({
  useCoders: () => ({
    coders: [{ id: 2, username: 'Alice', color: null, coder_type: 'human' },
             { id: 3, username: 'Bob', color: null, coder_type: 'human' }],
    multiCoder: true,
  }),
}))
vi.mock('@/hooks/useConsensusStatus', () => ({ useConsensusStatus: () => ({ data: { exists: false, stale_count: 0 } }) }))
vi.mock('@/hooks/useCoderCoverage', () => ({ useProjectCoderKinds: () => ({ hasMachine: false }) }))
vi.mock('@/lib/auth-context', () => ({ useAuth: () => ({ user: h.user }) }))

import CrossAnalysisPanel from './CrossAnalysisPanel'

const COLUMN: TextCodingColumn = {
  column_id: 10, dataset_id: 5, dataset_name: 'Participants', column_name: 'note', column_text: 'Note',
  column_type: 'open_text', sequence_order: 0, total_rows: 1, non_empty_rows: 1, coded_rows: 1,
}
const BLIND = { blind: true, withholding: true, settled: true }
const NOT_BLIND = { blind: false, withholding: false, settled: true }

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  h.blind = { ...BLIND }
  h.user = { id: 2, username: 'Alice' }
  codeDensity.mockImplementation(() => new Promise(() => {}))
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

/** Drive every door: the filters, the cross-tab variable, the CSV (the density asks on mount). */
async function pressEveryDoor() {
  fireEvent.click(screen.getByRole('button', { name: 'set filters' }))
  fireEvent.click(screen.getAllByRole('button', { name: 'pick' })[0])   // the cross-tab variable
  await waitFor(() => expect(filteredFrequencies).toHaveBeenCalled())
  await waitFor(() => expect(crossTabulation).toHaveBeenCalled())
  fireEvent.click(screen.getByRole('button', { name: /Export Cross-Analysis/ }))
  await waitFor(() => expect(exportCrossAnalysis).toHaveBeenCalled())
}

const lastArgs = (fn: { mock: { calls: unknown[][] } }) => fn.mock.calls[fn.mock.calls.length - 1][1]
const flagOf = (fn: { mock: { calls: unknown[][] } }) =>
  (lastArgs(fn) as { ratings_follow_coder_ids?: boolean }).ratings_follow_coder_ids

describe('Cross-analysis tells the server when blind mode withholds (#1615, D273)', () => {
  it('sends the flag on the four reads that take a picked column, and not on the response length', async () => {
    renderPanel()
    await pressEveryDoor()
    expect(flagOf(filteredFrequencies)).toBe(true)
    expect(flagOf(crossTabulation)).toBe(true)
    expect(flagOf(codeDensity)).toBe(true)
    expect(flagOf(exportCrossAnalysis)).toBe(true)
    expect(responseLength.mock.calls[0][1]).not.toHaveProperty('ratings_follow_coder_ids')
    expect(codeDensity.mock.calls[0][1]).toMatchObject({ coder_ids: '2' })
  })

  it('CONTROL: with nothing withheld no request carries it — byte-for-byte the request before #1615', async () => {
    h.blind = { ...NOT_BLIND }
    renderPanel()
    await pressEveryDoor()
    for (const fn of [filteredFrequencies, crossTabulation, codeDensity, exportCrossAnalysis]) {
      expect(lastArgs(fn)).not.toHaveProperty('ratings_follow_coder_ids')
    }
  })

  it('a lead’s own-coder filter and blind mode send the same coder_ids — a different KEY, so blind asks again', async () => {
    h.blind = { ...NOT_BLIND }
    const { rerenderPanel } = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'just me' }))
    fireEvent.click(screen.getByRole('button', { name: 'set filters' }))
    fireEvent.click(screen.getAllByRole('button', { name: 'pick' })[0])
    const scoped = (fn: { mock: { calls: unknown[][] } }, csv: unknown) =>
      fn.mock.calls.filter(c => JSON.stringify((c[1] as { coder_ids?: unknown }).coder_ids) === JSON.stringify(csv)).length
    await waitFor(() => {
      expect(scoped(codeDensity, '2')).toBe(1)
      expect(scoped(filteredFrequencies, [2])).toBe(1)
      expect(scoped(crossTabulation, [2])).toBe(1)
    })
    expect(flagOf(codeDensity)).toBeUndefined()
    h.blind = { ...BLIND }
    rerenderPanel()
    // Each of the three reads is asked again — with the flag — rather than served from the cache.
    await waitFor(() => {
      expect(scoped(codeDensity, '2')).toBe(2)
      expect(scoped(filteredFrequencies, [2])).toBe(2)
      expect(scoped(crossTabulation, [2])).toBe(2)
    })
    for (const fn of [codeDensity, filteredFrequencies, crossTabulation]) expect(flagOf(fn)).toBe(true)
  })

  it('withholding with no self id asks nothing — the flag with no scope would withhold nothing (D96)', async () => {
    h.user = null
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'set filters' }))
    fireEvent.click(screen.getAllByRole('button', { name: 'pick' })[0])
    fireEvent.click(screen.getByRole('button', { name: /Export Cross-Analysis/ }))
    await new Promise(r => setTimeout(r, 400))   // past the filters' 300 ms debounce
    for (const fn of [filteredFrequencies, crossTabulation, codeDensity, responseLength, exportCrossAnalysis]) {
      expect(fn).not.toHaveBeenCalled()
    }
  })

  it('a refused density grouping says the server’s sentence, never an empty panel', async () => {
    codeDensity.mockImplementation(() => Promise.reject(new ApiError(409, { detail: REFUSAL }, {})))
    renderPanel()
    expect(await screen.findByText('The code density could not be loaded.')).toBeInTheDocument()
    expect(screen.getByText(new RegExp('cannot form groups while blind'))).toBeInTheDocument()
  })
})
