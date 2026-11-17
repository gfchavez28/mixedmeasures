/**
 * #1615 — the analysis sidebar's variable picker while blind.
 *
 * The picker asks the variable list with the viewer's scope, so the server can mark the rating
 * scores hidden from her (`withheld_while_blind`, C4); it leaves those out and says how many
 * under their dataset in the Data view's words (#1608). It asks nothing before the scope is
 * known (D96). Positive control: an unmarked variable is listed, and with no scope (not
 * withholding) nothing is hidden.
 *
 * jsdom: what renders and what is asked — the live picker is the build's drive.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, within, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'

const api = vi.hoisted(() => ({ analysisColumns: vi.fn() }))
const scope = vi.hoisted(() => ({
  value: { coderIds: [7] as number[] | null, coderScope: '7' as string | undefined, scopeKey: '7', scopeReady: true },
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, metricsApi: { ...actual.metricsApi, analysisColumns: api.analysisColumns } }
})
vi.mock('@/hooks/useAnalysisScope', () => ({ useAnalysisScope: () => scope.value }))

import { ColumnPicker } from './ColumnPicker'

const col = (id: number, name: string, withheld = false) => ({
  id, dataset_id: 1, dataset_name: 'Participants', column_code: null, column_name: name,
  column_text: name, column_type: 'numeric', scale_labels: null, equivalence_group_id: null,
  domain_ids: [], ...(withheld ? { withheld_while_blind: true } : {}),
})

function marked(withheld: boolean) {
  return {
    datasets: [{ id: 1, name: 'Participants', columns: [
      col(10, 'Trust (score)', withheld), col(11, 'Trust (rated passages)', withheld), col(12, 'Age'),
    ] }],
    domains: [], demographics: [],
  }
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ColumnPicker
          projectId={1} mode="columns" onModeChange={() => {}}
          selectedColumnIds={new Set<number>()} onToggleColumn={() => {}}
          selectedDomainIds={new Set<number>()} onToggleDomain={() => {}}
          onSelectAllDataset={() => {}} expandedDatasetId={1} onToggleDataset={() => {}}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  scope.value = { coderIds: [7], coderScope: '7', scopeKey: '7', scopeReady: true }
})

describe('the variable picker while blind (#1615)', () => {
  it('asks with the viewer’s scope, leaves the marked scores out, and says how many', async () => {
    api.analysisColumns.mockResolvedValue(marked(true))
    mount()
    const list = await screen.findByRole('listbox', { name: 'Variables in Participants' })
    expect(api.analysisColumns).toHaveBeenCalledWith(1, '7')
    const names = within(list).getAllByRole('checkbox').map(b => b.getAttribute('aria-label') ?? '')
    expect(names.some(n => n.includes('Age'))).toBe(true)              // control: an ordinary variable stays
    expect(names.some(n => n.includes('Trust'))).toBe(false)
    expect(screen.getByTestId('withheld-rating-scores')).toHaveTextContent(
      "2 rating columns are hidden while blind. A participant score combines every coder's ratings, so it would show your colleagues' judgements.")
  })

  it('positive control: not withholding, nothing is asked to be marked and nothing is hidden', async () => {
    scope.value = { coderIds: null, coderScope: undefined, scopeKey: 'every-coder', scopeReady: true }
    api.analysisColumns.mockResolvedValue(marked(false))
    mount()
    const list = await screen.findByRole('listbox', { name: 'Variables in Participants' })
    expect(api.analysisColumns.mock.calls[0][1]).toBeUndefined()   // no scope sent
    expect(within(list).getAllByRole('checkbox')).toHaveLength(3)
    expect(screen.queryByTestId('withheld-rating-scores')).toBeNull()
  })

  it('asks nothing before the scope is known (D96), and says it is loading', async () => {
    scope.value = { coderIds: null, coderScope: undefined, scopeKey: 'unsettled', scopeReady: false }
    api.analysisColumns.mockResolvedValue(marked(true))
    mount()
    expect(await screen.findByText(/Loading variables/)).toBeInTheDocument()
    await waitFor(() => expect(api.analysisColumns).not.toHaveBeenCalled())
  })
})
