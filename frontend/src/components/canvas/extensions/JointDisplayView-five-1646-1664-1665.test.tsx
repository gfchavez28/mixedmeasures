/**
 * The joint display's five (2026-11-16d) — THROUGH the view that reads each fix (the 11-16c lesson:
 * a field-by-field copy drops a new wire field under a green server suite):
 *
 * - #1646 (D337): the open construct's Quotes line counts a pin against ITS strand — a survey
 *   answer pinned beside one interview passage read "2 of 9 coded passages pinned" — and a
 *   survey-only display (a survey strand + a survey comments strand) offers *Pin a quote*.
 * - #1665 (D336): the Compact view says a variable of another dataset apart, never "no longer in
 *   this project".
 * - #1664 (D333): the open construct names a saved rule's inactive code and says why it is not run.
 *
 * The mocks are `JointDisplayView-slice2.test.tsx`'s.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
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
vi.mock('@/hooks/useBlindMode', () => ({ useBlindMode: () => ({ blind: false, withholding: false, settled: true }) }))
const NO_MACHINES = new Set<number>()
vi.mock('@/hooks/useCoders', () => ({
  useCoders: () => ({ coderMap: new Map([[1, { id: 1, username: 'Me' }]]) }),
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
import { DialogsContext } from '../joint-display/display-store'
import { MISFIT_RULE_UNAVAILABLE_TEXT, otherDatasetVariablesText } from '@/lib/joint-display-vocabulary'

let mountCount = 0

function codeStrand(name: string, passages: number) {
  return {
    code_id: 31, name, unit: 'participants', rated: false, formed_groups: null,
    cells: [
      { group: 'High', count: 3, n: 11, share: 3 / 11, share_undefined_reason: null, passages, rating: null },
      { group: 'Low', count: 0, n: 10, share: 0, share_undefined_reason: null, passages: 0, rating: null },
    ],
    difference: { value: 3 / 11, ci_lower: null, ci_upper: null, ci_level: null, ci_method: null, unavailable_reason: null },
  }
}

function strandOf(kind: string, status: string, lists: Record<string, unknown> = {}) {
  return { kind, status, codes: [], variables: [], observation_codes: [], missing_code_ids: [], missing_column_ids: [], ...lists }
}

function facts(key: string, kind: string) {
  return { key, kind, unit: 'participants', dataset_id: null, observations: null,
    scope: { conversations: 1, documents: 0, unassigned_passages: 0, participants_without_group: 0, no_coding_scope: 'every_coder' },
    groups: [{ key: 'High', with_material: 11, without_coding: 0, surveyed: kind === 'text_codes' ? 11 : null },
      { key: 'Low', with_material: 10, without_coding: 0, surveyed: kind === 'text_codes' ? 10 : null }] }
}

function payload(row: Record<string, unknown>, strands: unknown[]) {
  return {
    unit: 'participants',
    group_by: { column_id: 11, name: 'Gain group', dataset_id: 1, dataset_name: 'Roster' },
    groups: [{ key: 'High', participants: 11, with_material: 11, without_coding: 0 },
      { key: 'Low', participants: 10, with_material: 10, without_coding: 0 }],
    unavailable_reason: null,
    scope: { conversations: 1, documents: 0, unassigned_passages: 0, participants_without_group: 0, no_coding_scope: 'every_coder' },
    rating: null, strands,
    rows: [{ key: 'r1', codes: [], variables: [], missing_code_ids: [], missing_column_ids: [],
      strands: { codes: 'covers', variables: 'not_measured' }, ...row }],
  }
}

const pin = (strand: string, text: string) => ({ excerptId: null, displayText: text, sourceContext: '', conversationId: null,
  observationId: null, group: 'High', role: null, purpose: '', strand })

function mount(display: unknown) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const props = {
    node: { attrs: { displayKey: `five-${++mountCount}`, figureEpoch: 3, display } },
    updateAttributes: vi.fn(), deleteNode: vi.fn(), selected: false, editor: { isEditable: true },
  } as unknown as NodeViewProps
  render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <DialogsContext.Provider value={vi.fn()}>
          <JointDisplayView {...props} />
        </DialogsContext.Provider>
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

// ── Display A: Interviews (codes) · Comments (survey comments, binding nothing here) · Survey ──
const DISPLAY_A = {
  title: 'Teachers', group_by_column_id: 11,
  strands: [
    { key: 's-int', kind: 'codes', label: 'Interviews', conversation_ids: [5], document_ids: [] },
    { key: 's-txt', kind: 'text_codes', label: 'Comments', text_column_ids: [40] },
    { key: 's-svy', kind: 'variables', label: 'Survey', dataset_id: 2 },
  ],
  rows: [{ key: 'r1', construct: 'Protected planning time',
    bindings: { 's-int': { code_ids: [31, 32] }, 's-svy': { column_ids: [44] } },
    // An interview passage and a survey answer, both pinned in High.
    pins: [pin('s-int', 'We get an hour.'), pin('s-txt', 'Never enough time.')],
    misfit: { rule: { conditions: [{ kind: 'code', strand_key: 's-int', code_id: 32, present: false }] }, added: [], removed: [] } }],
}
const PAYLOAD_A = payload({
  codes: [codeStrand('Planning time', 9)],
  other_dataset_column_ids: [44],
  inactive_codes: [{ strand_key: 's-int', code_id: 32, name: 'Workload', merged_into_id: 31, merged_into_name: 'Planning time' }],
  by_strand: {
    's-int': strandOf('codes', 'covers', { codes: [codeStrand('Planning time', 9)] }),
    's-txt': { ...strandOf('text_codes', 'not_measured'), not_measured_reason: 'nothing_bound' },
    's-svy': { ...strandOf('variables', 'not_measured', { other_dataset_column_ids: [44] }), not_measured_reason: 'bound_other_dataset' },
  },
}, [facts('s-int', 'codes'), facts('s-txt', 'text_codes'),
  { key: 's-svy', kind: 'variables', unit: 'participants', dataset_id: 2, groups: null, scope: null, observations: null }])

const openConstruct = async () => {
  await screen.findByRole('table')
  fireEvent.click(screen.getByRole('button', { name: /Protected planning time/ }))
}

beforeEach(() => {
  api.cases.mockResolvedValue({
    groups: ['High', 'Low'], total: 21, listed: 21, matched: null, unknown: null,
    rule_unavailable_reason: 'code_inactive', rule_withheld_columns: [], list_size: 0, added_outside: 0,
    codes: [{ code_id: 31, name: 'Planning time' }], variables: [], cases: [], named_cases: [], unavailable_reason: null,
  })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('#1665 — the Compact view says another dataset’s variable apart', () => {
  it('"from another dataset", never "no longer in this project"', async () => {
    api.compute.mockResolvedValue(PAYLOAD_A)
    mount(DISPLAY_A)
    const table = await screen.findByRole('table')
    expect(table).toHaveTextContent(otherDatasetVariablesText(1))
    expect(table.textContent).not.toMatch(/no longer in this project/)
  })
})

describe('#1646 — the Quotes line counts each pin against its own strand', () => {
  it('the survey answer is not counted against the interview passages: 1 of 9, not 2 of 9', async () => {
    api.compute.mockResolvedValue(PAYLOAD_A)
    mount(DISPLAY_A)
    await openConstruct()
    expect(screen.getByText('High · 1 of 9 coded passages pinned')).toBeInTheDocument()
    expect(screen.queryByText(/2 of 9 coded passages/)).toBeNull()
  })

  it('a survey-only display offers Pin a quote, and counts its coded answers', async () => {
    const display = {
      title: 'Survey only', group_by_column_id: 11,
      strands: [{ key: 's-svy', kind: 'variables', label: 'Survey', dataset_id: 2 },
        { key: 's-txt', kind: 'text_codes', label: 'Comments', text_column_ids: [40] }],
      rows: [{ key: 'r1', construct: 'Protected planning time', bindings: { 's-txt': { code_ids: [31] } } }],
    }
    api.compute.mockResolvedValue(payload({
      by_strand: {
        's-svy': { ...strandOf('variables', 'not_measured'), not_measured_reason: 'nothing_bound' },
        's-txt': strandOf('text_codes', 'covers', { codes: [codeStrand('Planning time', 4)] }),
      },
    }, [{ key: 's-svy', kind: 'variables', unit: 'participants', dataset_id: 2, groups: null, scope: null, observations: null },
      facts('s-txt', 'text_codes')]))
    mount(display)
    await openConstruct()
    expect(screen.getByRole('button', { name: 'Pin a quote for High, Protected planning time' })).toBeInTheDocument()
    expect(screen.getByText('High · 0 of 4 coded answers pinned')).toBeInTheDocument()
  })
})

describe('#1664 — the open construct names a saved rule’s inactive code', () => {
  it('"did not use “Workload”" with the reason it is not run — never "a code this row no longer binds"', async () => {
    api.compute.mockResolvedValue(PAYLOAD_A)
    mount(DISPLAY_A)
    await openConstruct()
    expect(await screen.findByText(/did not use “Workload”/)).toBeInTheDocument()
    expect(screen.queryByText(/no longer binds/)).toBeNull()
    expect(await screen.findByText(MISFIT_RULE_UNAVAILABLE_TEXT.code_inactive)).toBeInTheDocument()
  })
})
