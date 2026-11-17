/**
 * #1660 (D345) — the builder's two presses that unmount their own button land focus on the
 * control that acts next (`focus-landing.ts::landAfterPress`), as the strand Remove already did:
 *
 * - *Remove construct* → the construct name now in its place, else the one before (its row goes
 *   with the button; Radix's focus scope put focus on the dialog, so Tab restarted at the top —
 *   driven 2026-11-15d);
 * - slice 1's *Add … strand* → the new strand's name (the view gives way to the strands editor).
 *
 * Mocks as `joint-display-limits-1644.test.tsx`.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@testing-library/jest-dom/vitest'

const col = (id: number, name: string, column_type: string) => ({ id, dataset_id: 1, dataset_name: 'Roster', column_code: null,
  column_name: name, column_text: name, column_type, scale_labels: null, equivalence_group_id: null, domain_ids: [] })
const analysisColumns = vi.fn()
vi.mock('@/lib/api', () => ({
  metricsApi: { analysisColumns: (...a: unknown[]) => analysisColumns(...a) },
  textCodingApi: { columns: vi.fn().mockResolvedValue({ columns: [] }) },
  codesApi: { list: vi.fn().mockResolvedValue({ total: 1, codes: [{ id: 31, name: 'Planning time', is_active: true, is_universal: false }] }) },
  conversationsApi: { list: vi.fn().mockResolvedValue({ total: 1, conversations: [{ id: 5, name: 'Focus group 1' }] }) },
  documentsApi: { list: vi.fn().mockResolvedValue([]) },
  materialsApi: { listAllMaterials: vi.fn().mockResolvedValue([]) },
  observationsApi: { list: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/hooks/useAnalysisScope', () => ({
  useAnalysisScope: () => ({ coderIds: null, coderScope: undefined, scopeKey: 'every-coder', scopeReady: true }),
}))

import JointDisplayBuilder from './JointDisplayBuilder'
import { readDisplay, type JointDisplay } from '@/lib/joint-display'
import { STRAND_KIND_TERMS } from '@/lib/joint-display-vocabulary'

function mount(display: JointDisplay) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <JointDisplayBuilder open onOpenChange={() => {}} projectId={1} initial={display} mode="edit" onSubmit={vi.fn()} />
    </QueryClientProvider>,
  )
}

const SLICE_1 = readDisplay({
  title: 'T', group_by_column_id: 11,
  rows: ['C1', 'C2', 'C3'].map((c, i) => ({ key: `r${i}`, construct: c, code_ids: [31] })),
})
const press = (el: HTMLElement) => { el.focus(); fireEvent.click(el) }

beforeEach(() => {
  analysisColumns.mockResolvedValue({ domains: [], demographics: [],
    datasets: [{ id: 1, name: 'Roster', columns: [col(11, 'Gain group', 'nominal')] }] })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('#1660 (D345) — the builder', () => {
  it('Remove construct lands on the construct now in its place, then on the one before', async () => {
    mount(SLICE_1)
    press(await screen.findByRole('button', { name: 'Remove construct C2' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove construct C2' })).toBeNull())
    // C3 took C2's place: it is now "Construct 2".
    await waitFor(() => expect(screen.getByLabelText('Construct 2 name')).toHaveFocus())
    expect(screen.getByLabelText('Construct 2 name')).toHaveValue('C3')

    press(screen.getByRole('button', { name: 'Remove construct C3' }))  // the last row
    await waitFor(() => expect(screen.getByLabelText('Construct 1 name')).toHaveFocus())
    expect(screen.getByLabelText('Construct 1 name')).toHaveValue('C1')
    expect(document.activeElement).not.toBe(document.body)
  })

  it('slice 1’s Add … strand lands on the new strand’s name', async () => {
    mount(SLICE_1)
    const add = await screen.findByRole('button', { name: STRAND_KIND_TERMS[0].add })
    press(add)
    // The slice-1 view gave way to the strands editor: the pressed button is gone.
    await screen.findByLabelText('Strand 3 name')
    expect(add.isConnected).toBe(false)
    await waitFor(() => expect(screen.getByLabelText('Strand 3 name')).toHaveFocus())
  })
})
