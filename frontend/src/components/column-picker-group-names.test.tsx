/**
 * #1169 — every checkbox in the analysis sidebar's Groups list has a name.
 *
 * The Variables tab named its checkbox (`aria-label={label}`); the Groups tab's
 * sibling had none, so a reader met "checkbox, not checked" once per group with
 * nothing to say which (confirmed in Chrome's tree twice, 10-13d). A POPULATION
 * assertion over the rendered rows, with a floor, so it cannot pass by rendering
 * none.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'

const api = vi.hoisted(() => ({ analysisColumns: vi.fn() }))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, metricsApi: { ...actual.metricsApi, analysisColumns: api.analysisColumns } }
})

import { ColumnPicker } from './ColumnPicker'

const GROUPS = [
  { id: 1, name: 'Workplace wellbeing and professional development engagement', member_count: 3, datasets: ['Survey'] },
  { id: 2, name: 'Belonging', member_count: 4, datasets: ['Survey', 'Follow-up'] },
  { id: 3, name: 'Workload', member_count: 2, datasets: ['Survey'] },
]

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('the Groups list (#1169)', () => {
  it('names every group checkbox after its group', async () => {
    api.analysisColumns.mockResolvedValue({ datasets: [], domains: GROUPS })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ColumnPicker
            projectId={1}
            mode="domains"
            onModeChange={() => {}}
            selectedColumnIds={new Set<number>()}
            onToggleColumn={() => {}}
            selectedDomainIds={new Set<number>([2])}
            onToggleDomain={() => {}}
            onSelectAllDataset={() => {}}
            expandedDatasetId={null}
            onToggleDataset={() => {}}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    const list = await screen.findByRole('listbox', { name: 'Variable groups' })
    const boxes = within(list).getAllByRole('checkbox')
    expect(boxes.length).toBeGreaterThanOrEqual(GROUPS.length)  // the floor
    expect(boxes.map(b => b.getAttribute('aria-label'))).toEqual(GROUPS.map(g => g.name))
    for (const g of GROUPS) {
      expect(within(list).getByRole('checkbox', { name: g.name })).toBeInTheDocument()
    }
  })
})
