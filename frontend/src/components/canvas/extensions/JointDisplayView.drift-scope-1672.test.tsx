/**
 * #1672 D354, mounted: the real view, its construct detail and its Compact mark, with a drift
 * stamp a colleague saved. The audit's probe (R4 `drift-blind.probe.test.tsx`) showed a blind
 * viewer "Numbers moved … 6 of 11 → 2 of 11 · 4.50 (6 scores) → 3.00 (2 scores)" — the
 * colleague's counts and rating means. The mocks are `JointDisplayView.test.tsx`'s.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import '@testing-library/jest-dom/vitest'
import type { NodeViewProps } from '@tiptap/core'

vi.mock('@tiptap/react', () => ({
  NodeViewWrapper: ({ children, ...rest }: { children?: React.ReactNode }) => <div {...rest}>{children}</div>,
}))
vi.mock('@/layouts/ProjectLayout', () => ({ useProjectLayout: () => ({ projectId: 1 }) }))
vi.mock('@/lib/auth-context', () => ({ useAuth: () => ({ user: { id: 1 } }) }))
const blindState = { blind: false, withholding: false, settled: true }
vi.mock('@/hooks/useBlindMode', () => ({ useBlindMode: () => blindState }))
const NO_MACHINES = new Set<number>()
vi.mock('@/hooks/useCoders', () => ({
  useCoders: () => ({ coderMap: new Map([[1, { id: 1, username: 'Me' }], [2, { id: 2, username: 'Colleague' }]]) }),
  useMachineCoderIds: () => NO_MACHINES,
}))
vi.mock('@/hooks/useListLoad', () => ({ useListLoad: () => ({ status: 'loading', error: null, retry: () => {}, retrying: false }) }))

const api = vi.hoisted(() => ({ compute: vi.fn(), pinFacts: vi.fn(), passages: vi.fn(), cases: vi.fn() }))
vi.mock('@/lib/api', () => ({
  jointDisplayApi: api,
  excerptsApi: { wholePassage: vi.fn() },
  codesApi: { list: vi.fn() }, conversationsApi: { list: vi.fn() }, documentsApi: { list: vi.fn() },
  metricsApi: { analysisColumns: vi.fn(), quickCompute: vi.fn(), crossTabulation: vi.fn() },
  materialsApi: { listAllMaterials: vi.fn() },
  comparisonsApi: { groupComparison: vi.fn() },
}))

import JointDisplayView from './JointDisplayView'
import { DialogsContext } from '@/components/canvas/joint-display/display-store'
import { rowCells } from '@/lib/joint-display'
import { DRIFT_OTHER_SCOPE_TEXT, DRIFT_ACCEPT_CURRENT_TEXT } from '@/lib/joint-display-vocabulary'

function cell(group: string, count: number, n: number, mean: number | null) {
  return { group, count, n, share: count / n, share_undefined_reason: null, passages: count,
    rating: mean == null ? null : { mean, n: count, undefined_reason: null } }
}
function rowResult(high: number, mean: number) {
  const s = { code_id: 31, name: 'Trust', unit: 'participants', rated: true, formed_groups: null,
    cells: [cell('High', high, 11, mean), cell('Low', 1, 10, 2)],
    difference: { value: null, ci_lower: null, ci_upper: null, ci_level: null, ci_method: null, unavailable_reason: 'x' } }
  return { key: 'r1', codes: [s], variables: [], missing_code_ids: [], missing_column_ids: [],
    strands: { codes: 'covers', variables: 'not_measured' },
    by_strand: { codes: { kind: 'codes', status: 'covers', codes: [s], variables: [], observation_codes: [], missing_code_ids: [], missing_column_ids: [] },
      variables: { kind: 'variables', status: 'not_measured', codes: [], variables: [], observation_codes: [], missing_code_ids: [], missing_column_ids: [], not_measured_reason: 'nothing_bound' } } }
}
function payloadFor(high: number, mean: number) {
  return { unit: 'participants', group_by: { column_id: 11, name: 'Gain group', dataset_id: 1, dataset_name: 'Roster' },
    groups: [{ key: 'High', participants: 11, with_material: 11, without_coding: 0 }, { key: 'Low', participants: 10, with_material: 10, without_coding: 0 }],
    unavailable_reason: null,
    scope: { conversations: 1, documents: 0, unassigned_passages: 0, participants_without_group: 0, no_coding_scope: 'viewer' },
    rating: { basis: 'b', score_basis: 's', scope: 'viewer', excluded_ratings: {}, unavailable_reason: null },
    strands: [], rows: [rowResult(high, mean)] }
}

// The colleague (user 2) saved the meta-inference: the stamp holds the numbers under THEIR view.
const colleagueStamp = { hash: 'h', cells: rowCells(rowResult(6, 4.5) as never), stamped_at: '2026-11-15', scope: 2 }

let k = 0
function mount(baseline: object) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const display = { title: 'D', group_by_column_id: 11, rows: [{ key: 'r1', construct: 'Trust', code_ids: [31],
    meta_inference: { text: 'Trust differs', author_id: 2, written_at: '2026-11-15', level: null, type: null },
    baseline }] }
  const updateAttributes = vi.fn()
  const props = { node: { attrs: { displayKey: `drift-1672-${++k}`, figureEpoch: 3, display } },
    updateAttributes, deleteNode: vi.fn(), selected: false, editor: { isEditable: true } } as unknown as NodeViewProps
  render(<MemoryRouter><QueryClientProvider client={qc}><DialogsContext.Provider value={vi.fn()}>
    <JointDisplayView {...props} /></DialogsContext.Provider></QueryClientProvider></MemoryRouter>)
  return updateAttributes
}

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('#1672 D354 — the stamp of another coder view, mounted', () => {
  it('blind: no "moved" mark, no colleague figure, the sentence — and Accept re-stamps under the viewer', async () => {
    Object.assign(blindState, { blind: true, withholding: true, settled: true })
    api.compute.mockResolvedValue(payloadFor(2, 3.0))
    const updateAttributes = mount(colleagueStamp)
    const toggle = await screen.findByRole('button', { name: /Trust/ })
    expect(api.compute.mock.calls[0][1].coder_ids).toEqual([1])
    expect(screen.queryByText(/numbers moved/i)).not.toBeInTheDocument()   // the Compact mark
    fireEvent.click(toggle)
    const note = await screen.findByText(new RegExp(DRIFT_OTHER_SCOPE_TEXT.slice(0, 40)))
    expect(document.body.textContent).not.toMatch(/6 of 11|4\.50 \(6/)
    expect(screen.queryByText(/Numbers moved/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: `${DRIFT_ACCEPT_CURRENT_TEXT} for Trust` }))
    const calls = updateAttributes.mock.calls
    const written = calls[calls.length - 1][0].display.rows[0].baseline
    expect(written.scope).toBe(1)
    expect(written.cells['code:31:High']).toBe(rowCells(rowResult(2, 3.0) as never)['code:31:High'])
    expect(note).toBeTruthy()
  })

  it('CONTROL: the same view still says what moved, with its figures and the mark', async () => {
    Object.assign(blindState, { blind: false, withholding: false, settled: true })
    api.compute.mockResolvedValue(payloadFor(2, 3.0))
    mount({ ...colleagueStamp, scope: 'all' })
    const toggle = await screen.findByRole('button', { name: /Trust/ })
    expect(screen.getByText(/numbers moved/)).toBeInTheDocument()
    fireEvent.click(toggle)
    expect(await screen.findByText(/Numbers moved/)).toBeInTheDocument()
    expect(document.body.textContent).toMatch(/6 of 11/)
  })
})
