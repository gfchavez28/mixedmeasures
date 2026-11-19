/**
 * #1665 (D335) — changing a survey strand's dataset starts the strand over in every construct.
 *
 * The strand editor's dataset select patched the strand alone: a construct's variables of the
 * OLD dataset stayed chosen, the compute left them out ("no longer in this project", #1665's
 * filed sentence) and the construct's picker could not untick them — it offers the new dataset's
 * variables only, and read "2 chosen" with nothing ticked. Now a change that would clear chosen
 * variables ASKS (r6-10's pattern: the safe choice takes focus; either choice hands focus back to
 * the select), and one that clears nothing happens at once. The mocks are the residuals test's.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@testing-library/jest-dom/vitest'

const analysisColumns = vi.fn()
const col = (id: number, ds: number, dsName: string, name: string, column_type: string) => ({ id, dataset_id: ds,
  dataset_name: dsName, column_code: null, column_name: name, column_text: name, column_type, scale_labels: null,
  equivalence_group_id: null, domain_ids: [] })
const COLUMNS = { domains: [], demographics: [], datasets: [
  { id: 1, name: 'Roster', columns: [col(11, 1, 'Roster', 'Gain group', 'nominal')] },
  { id: 2, name: 'Baseline', columns: [col(21, 2, 'Baseline', 'Training hours', 'numeric'), col(22, 2, 'Baseline', 'Years', 'numeric')] },
  { id: 3, name: 'Follow-up', columns: [col(31, 3, 'Follow-up', 'Hours now', 'numeric')] },
] }
vi.mock('@/lib/api', () => ({
  metricsApi: { analysisColumns: (...a: unknown[]) => analysisColumns(...a) },
  textCodingApi: { columns: vi.fn().mockResolvedValue({ columns: [] }) },
  codesApi: { list: vi.fn().mockResolvedValue({ total: 1, codes: [{ id: 31, name: 'Planning time', is_active: true, is_universal: false }] }) },
  conversationsApi: { list: vi.fn().mockResolvedValue({ total: 0, conversations: [] }) },
  documentsApi: { list: vi.fn().mockResolvedValue([]) },
  materialsApi: { listAllMaterials: vi.fn().mockResolvedValue([]) },
  observationsApi: { list: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/hooks/useAnalysisScope', () => ({
  useAnalysisScope: () => ({ coderIds: null, coderScope: undefined, scopeKey: 'every-coder', scopeReady: true }),
}))

import JointDisplayBuilder from './JointDisplayBuilder'
import { readDisplay, type JointDisplay } from '@/lib/joint-display'
import { strandDatasetChangeText, strandDatasetChangeWarningText, strandDatasetKeepText } from '@/lib/joint-display-vocabulary'

const initial = (svy: number[]): JointDisplay => readDisplay({
  title: 'T', group_by_column_id: 11,
  strands: [{ key: 'iv', kind: 'codes', label: 'Interviews' }, { key: 'sv', kind: 'variables', label: 'Survey', dataset_id: 2 }],
  rows: [{ key: 'r1', construct: 'Planning', bindings: { iv: { code_ids: [31] }, sv: { column_ids: svy } } }],
})

function mount(display: JointDisplay) {
  const onSubmit = vi.fn()
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <JointDisplayBuilder open onOpenChange={() => {}} projectId={1} initial={display} mode="edit" onSubmit={onSubmit} />
    </QueryClientProvider>,
  )
  return onSubmit
}

const select = () => screen.getByRole('combobox', { name: 'Dataset for Survey' }) as HTMLSelectElement
const saved = (onSubmit: ReturnType<typeof vi.fn>) => {
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  return onSubmit.mock.calls[0][0] as JointDisplay
}

beforeEach(() => { analysisColumns.mockResolvedValue(COLUMNS) })
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('#1665 — a survey strand’s new dataset starts the strand over', () => {
  it('asks first when a construct chose its variables; Keep leaves the dataset and the variables', async () => {
    const onSubmit = mount(initial([21, 22]))
    await screen.findByRole('combobox', { name: 'Dataset for Survey' })
    fireEvent.change(select(), { target: { value: '3' } })
    expect(screen.getByText(strandDatasetChangeWarningText(1))).toBeInTheDocument()
    expect(select().value).toBe('2')   // nothing changed until it is confirmed
    const keep = screen.getByRole('button', { name: strandDatasetKeepText('Baseline') })
    expect(keep).toHaveFocus()
    fireEvent.click(keep)
    expect(screen.queryByText(strandDatasetChangeWarningText(1))).toBeNull()
    await waitFor(() => expect(select()).toHaveFocus())
    const d = saved(onSubmit)
    expect(d.strands.find(s => s.key === 'sv')!.dataset_id).toBe(2)
    expect(d.rows[0].bindings.sv.column_ids).toEqual([21, 22])
  })

  it('Change takes the new dataset and clears the old one’s variables — nothing left that cannot be unticked', async () => {
    const onSubmit = mount(initial([21, 22]))
    await screen.findByRole('combobox', { name: 'Dataset for Survey' })
    fireEvent.change(select(), { target: { value: '3' } })
    // #1703 (a) (D371): the button names the dataset the strand changes TO.
    fireEvent.click(screen.getByRole('button', { name: strandDatasetChangeText('Follow-up') }))
    expect(select().value).toBe('3')
    await waitFor(() => expect(select()).toHaveFocus())
    expect(screen.getByRole('button', { name: /^Survey for Planning: 0 chosen/ })).toBeInTheDocument()
    const d = saved(onSubmit)
    expect(d.strands.find(s => s.key === 'sv')!.dataset_id).toBe(3)
    expect(d.rows[0].bindings.sv.column_ids).toEqual([])
    expect(d.rows[0].bindings.iv.code_ids).toEqual([31])   // another strand is untouched
  })

  it('a change that clears nothing happens at once, with no question (the control)', async () => {
    mount(initial([]))
    await screen.findByRole('combobox', { name: 'Dataset for Survey' })
    fireEvent.change(select(), { target: { value: '3' } })
    expect(select().value).toBe('3')
    expect(screen.queryByRole('button', { name: /^Use “/ })).toBeNull()
  })

  it('#1703 (a): the button reads Use “Follow-up”, and choosing no dataset reads Remove the dataset', async () => {
    mount(initial([21, 22]))
    await screen.findByRole('combobox', { name: 'Dataset for Survey' })
    fireEvent.change(select(), { target: { value: '3' } })
    expect(screen.getByRole('button', { name: 'Use “Follow-up”' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Keep “Baseline”' }))
    fireEvent.change(select(), { target: { value: '' } })
    expect(screen.getByRole('button', { name: 'Remove the dataset' })).toBeInTheDocument()
  })
})
