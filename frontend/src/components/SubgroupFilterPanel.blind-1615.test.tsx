/**
 * #1615 (the lead's addition to r4's doors) — the subgroup filter's value list IS a column's
 * values, and a band of a participant score sorts people by every coder's ratings. While blind
 * mode withholds, the list asks with the viewer's scope (keyed by it, waiting for the blind
 * state — fail closed, D96), and a rating column's answer (`withheld_while_blind`, no values)
 * says why instead of "Loading values...".
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const h = vi.hoisted(() => ({
  scope: { coderScope: '7' as string | undefined, scopeReady: true },
  freq: { frequencies: [] as unknown[], total: 0, withheld_while_blind: true as boolean | undefined },
}))
const getFrequencies = vi.fn((..._a: unknown[]) => Promise.resolve(h.freq))

vi.mock('@/lib/api', () => ({
  datasetsApi: {
    allColumns: vi.fn(() => Promise.resolve({ columns: [{
      id: 5, dataset_id: 3, dataset_name: 'Participants', dataset_color: null, column_code: null,
      column_name: 'band', column_text: 'Score band', column_type: 'demographic', scale_points: null,
    }] })),
  },
  recodeApi: { getFrequencies: (...a: unknown[]) => getFrequencies(...a) },
}))
vi.mock('@/hooks/useBlindScope', () => ({ useBlindScope: () => h.scope }))

import SubgroupFilterPanel from './SubgroupFilterPanel'
import { WITHHELD_VALUES_NOTICE } from '@/lib/blind-rating-columns'

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <SubgroupFilterPanel
        projectId={1}
        focalColumnIds={[9]}
        textColumns={[{ column_id: 9, dataset_id: 3 } as never]}
        filters={[{ column_id: 5, operator: 'in', values: [] }]}
        onFiltersChange={() => {}}
        matchCount={null}
      />
    </QueryClientProvider>,
  )
}

async function openValues() {
  fireEvent.click(await screen.findByRole('button', { name: /select\.\.\./ }))
}

afterEach(() => {
  cleanup()
  getFrequencies.mockClear()
  h.scope = { coderScope: '7', scopeReady: true }
  h.freq = { frequencies: [], total: 0, withheld_while_blind: true }
})

describe('the subgroup filter’s values while blind (#1615)', () => {
  it('asks with the viewer’s scope, and says why a rating column has no values', async () => {
    mount()
    await openValues()
    await waitFor(() => expect(getFrequencies).toHaveBeenCalledWith(1, 3, 5, '7'))
    expect(await screen.findByText(WITHHELD_VALUES_NOTICE)).toBeInTheDocument()
    expect(screen.queryByText('Loading values...')).not.toBeInTheDocument()
  })

  it('does not ask before the blind state is ready (fail closed, D96)', async () => {
    h.scope = { coderScope: undefined, scopeReady: false }
    mount()
    await openValues()
    await new Promise(r => setTimeout(r, 20))
    expect(getFrequencies).not.toHaveBeenCalled()
  })

  it('positive control: not blind — every coder, and the values are offered', async () => {
    h.scope = { coderScope: undefined, scopeReady: true }
    h.freq = { frequencies: [{ value_text: 'High', count: 2 }], total: 2, withheld_while_blind: undefined }
    mount()
    await openValues()
    await waitFor(() => expect(getFrequencies).toHaveBeenCalledWith(1, 3, 5, undefined))
    expect(await screen.findByRole('option', { name: 'High' })).toBeInTheDocument()
    expect(screen.queryByText(WITHHELD_VALUES_NOTICE)).not.toBeInTheDocument()
  })
})
