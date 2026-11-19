/**
 * #1673 D355 — clearing a construct's name never deletes its work on *Save changes*. The audit's
 * case (R4): in edit mode, construct 2's name cleared, *Save changes* saved `rows: [r1]` — its
 * pin and meta-inference gone, unsaid. *Remove construct* is the way to delete one.
 *
 * Now the button is unavailable while a nameless construct HOLDS anything — focusable,
 * `aria-disabled`, described by the footer sentence naming it, and its click does nothing. A new,
 * empty, nameless row is still dropped on save.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@testing-library/jest-dom/vitest'

vi.mock('@/lib/api', () => ({
  metricsApi: { analysisColumns: vi.fn().mockResolvedValue({ domains: [], demographics: [], datasets: [
    { id: 1, name: 'Roster', columns: [
      { id: 11, dataset_id: 1, dataset_name: 'Roster', column_code: null, column_name: 'Gain group', column_text: 'Gain group', column_type: 'nominal', scale_labels: null, equivalence_group_id: null, domain_ids: [] },
    ] },
  ] }) },
  codesApi: { list: vi.fn().mockResolvedValue({ total: 1, codes: [
    { id: 31, name: 'Planning time', is_active: true, is_universal: false },
  ] }) },
  conversationsApi: { list: vi.fn().mockResolvedValue({ total: 1, conversations: [{ id: 5, name: 'Focus group 1' }] }) },
  documentsApi: { list: vi.fn().mockResolvedValue([]) },
  materialsApi: { listAllMaterials: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/hooks/useAnalysisScope', () => ({
  useAnalysisScope: () => ({ coderIds: null, coderScope: undefined, scopeKey: 'every-coder', scopeReady: true }),
}))

import JointDisplayBuilder from './JointDisplayBuilder'
import { readDisplay, rowHoldsWork, unnamedConstructHoldingWork } from '@/lib/joint-display'
import { unnamedConstructText } from '@/lib/joint-display-vocabulary'

function mountEdit(initial: unknown) {
  const onSubmit = vi.fn()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}>
    <JointDisplayBuilder open onOpenChange={() => {}} projectId={1} initial={readDisplay(initial)} mode="edit" onSubmit={onSubmit} />
  </QueryClientProvider>)
  return onSubmit
}

afterEach(() => { cleanup(); vi.clearAllMocks() })

const pin = { excerptId: 501, displayText: 'We never had planning time', sourceContext: '', conversationId: 5, observationId: null, group: 'High', role: 'typical', purpose: '' }
const stored = {
  title: 'Edit me', group_by_column_id: 11,
  rows: [
    { key: 'r1', construct: 'Training dosage', code_ids: [31] },
    { key: 'r2', construct: 'Planning time', code_ids: [31], pins: [pin],
      meta_inference: { text: 'Both strands say planning time was missing.', author_id: 1, written_at: '2026-11-15', level: null, type: null } },
  ],
}

describe('#1673 D355 — Save changes and a nameless construct', () => {
  it('a cleared name with work under it: the button is unavailable, says why, and saves nothing', async () => {
    const onSubmit = mountEdit(stored)
    fireEvent.change(await screen.findByLabelText('Construct 2 name'), { target: { value: '' } })
    const save = screen.getByRole('button', { name: 'Save changes' })
    expect(save).not.toBeDisabled()                       // focusable: the tab stop is the disclosure
    expect(save).toHaveAttribute('aria-disabled', 'true')
    expect(save).toHaveAccessibleDescription(unnamedConstructText(2))
    fireEvent.click(save)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('CONTROL: an unchanged save keeps both constructs', async () => {
    const onSubmit = mountEdit(stored)
    const save = await screen.findByRole('button', { name: 'Save changes' })
    expect(save).not.toHaveAttribute('aria-disabled')
    fireEvent.click(save)
    expect(onSubmit.mock.calls[0][0].rows.map((r: { key: string }) => r.key)).toEqual(['r1', 'r2'])
  })

  it('a new, empty, nameless construct is still dropped on save', async () => {
    const onSubmit = mountEdit({ ...stored, rows: [...stored.rows, { key: 'r3', construct: '' }] })
    fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }))
    expect(onSubmit.mock.calls[0][0].rows.map((r: { key: string }) => r.key)).toEqual(['r1', 'r2'])
  })
})

describe('what "holds anything" means (D355)', () => {
  const d = (row: object) => readDisplay({ group_by_column_id: 11, rows: [{ key: 'r', construct: '', ...row }] })
  it.each([
    ['bound codes', { code_ids: [31] }],
    ['a saved result', { result_material_ids: [9] }],
    ['a pin', { pins: [pin] }],
    ['a fit', { fit: 'confirmation' }],
    ['a meta-inference', { meta_inference: { text: 'x' } }],
    ['an implication', { implication: 'Fund it.' }],
    ['a rule', { misfit: { rule: { conditions: [{ kind: 'group', group: 'High' }] }, added: [], removed: [] } }],
    ['a picked case', { misfit: { rule: null, added: [{ participant_id: 3, reason: 'r' }], removed: [] } }],
    ['a stamp', { baseline: { hash: 'h', cells: {}, stamped_at: 'd' } }],
  ])('%s', (_what, row) => {
    expect(rowHoldsWork(d(row).rows[0])).toBe(true)
    expect(unnamedConstructHoldingWork(d(row))).toBe(1)
  })
  it('an empty row holds nothing', () => {
    expect(rowHoldsWork(d({}).rows[0])).toBe(false)
    expect(unnamedConstructHoldingWork(d({}))).toBeNull()
  })
})
