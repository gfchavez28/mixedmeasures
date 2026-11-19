/**
 * #1659 — the Compact view's "not measured" line and the open construct's strand status say WHY,
 * in the server's reason: a row whose bound code was merged away read
 * "INTERVIEWS Not measured: no code bound" above the sentence naming where the coding went (the
 * drive, 2026-11-15d). The mocks are `JointDisplayView-slice2.test.tsx`'s.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
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

const api = vi.hoisted(() => ({ compute: vi.fn(), pinFacts: vi.fn(), passages: vi.fn() }))
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
import { SERVER_VOCABULARY as V } from '@/lib/joint-display-vocabulary'

let mountCount = 0

const LIVE = {
  code_id: 32, name: 'Workload', unit: 'participants', rated: false, formed_groups: null,
  cells: [
    { group: 'High', count: 3, n: 11, share: 3 / 11, share_undefined_reason: null, passages: 4, rating: null },
    { group: 'Low', count: 1, n: 10, share: 0.1, share_undefined_reason: null, passages: 1, rating: null },
  ],
  difference: { value: null, ci_lower: null, ci_upper: null, ci_level: null, ci_method: null, unavailable_reason: null },
}

function strandOf(kind: string, status: string, reason: string | null, lists: Record<string, unknown[]> = {}) {
  return { kind, status, codes: [], variables: [], observation_codes: [], missing_code_ids: [], missing_column_ids: [],
    not_measured_reason: reason, ...lists }
}

function payload() {
  return {
    unit: 'participants',
    group_by: { column_id: 11, name: 'Team', dataset_id: 1, dataset_name: 'Roster' },
    groups: [{ key: 'High', participants: 11, with_material: 11, without_coding: 0 },
      { key: 'Low', participants: 10, with_material: 10, without_coding: 0 }],
    unavailable_reason: null,
    scope: { conversations: 4, documents: 0, unassigned_passages: 0, participants_without_group: 0, no_coding_scope: 'every_coder' },
    rating: null,
    rows: [{
      key: 'r1', codes: [], variables: [], missing_code_ids: [], missing_column_ids: [],
      strands: { codes: 'not_measured', variables: 'not_measured' },
      // the drive's case: the interview strand's bound code was merged into "Wellbeing"
      inactive_codes: [{ strand_key: 's-int', code_id: 31, name: 'Morale', merged_into_id: 40, merged_into_name: 'Wellbeing' }],
      by_strand: {
        's-int': strandOf('codes', 'not_measured', V.STRAND_NOT_MEASURED_BOUND_INACTIVE),
        's-fg': strandOf('codes', 'covers', null, { codes: [LIVE] }),
        's-txt': strandOf('text_codes', 'not_measured', V.STRAND_NOT_MEASURED_NO_QUESTIONS),
        's-svy': strandOf('variables', 'not_measured', V.STRAND_NOT_MEASURED_NOTHING_BOUND),
      },
    }],
  }
}

const DISPLAY = {
  title: 'Morale by team', group_by_column_id: 11,
  strands: [
    { key: 's-int', kind: 'codes', label: 'Interviews', conversation_ids: [5], document_ids: [] },
    { key: 's-fg', kind: 'codes', label: 'Focus groups', conversation_ids: [7], document_ids: [] },
    { key: 's-txt', kind: 'text_codes', label: 'Survey comments', text_column_ids: [44] },
    { key: 's-svy', kind: 'variables', label: 'Baseline survey', dataset_id: 2 },
  ],
  rows: [{ key: 'r1', construct: 'Team morale', bindings: {
    's-int': { code_ids: [31] }, 's-fg': { code_ids: [32] }, 's-txt': { code_ids: [32] } } }],
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const props = {
    node: { attrs: { displayKey: `nm-${++mountCount}`, figureEpoch: 3, display: DISPLAY } },
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

beforeEach(() => { api.compute.mockResolvedValue(payload()) })
afterEach(() => { cleanup(); vi.clearAllMocks() })

/** The not-measured line for a strand: the row header whose tag is the strand's name (#1713, D393). */
function lineOf(table: HTMLElement, tag: string): HTMLElement {
  return within(table).getByText(tag, { selector: 'span' }).closest('th')!
}

describe('#1659 — the Compact view says why a strand is not measured', () => {
  it('a merged-away code: "inactive", never "no code bound" above the sentence naming the merge', async () => {
    mount()
    const table = await screen.findByRole('table')
    expect(lineOf(table, 'Interviews')).toHaveTextContent(/^InterviewsNot measured: what it binds is inactive in the codebook$/)
    expect(within(table).getByText(/Morale.*Wellbeing/)).toBeInTheDocument()   // the merge's own sentence stays
    expect(table.textContent).not.toMatch(/Interviews\s*Not measured: no code bound/)
  })

  it('a survey comments strand with no question left says so — nothing else on screen did', async () => {
    mount()
    const table = await screen.findByRole('table')
    expect(lineOf(table, 'Survey comments')).toHaveTextContent('Not measured: none of its survey questions is in this project')
  })

  it('nothing bound keeps its words (the control)', async () => {
    mount()
    const table = await screen.findByRole('table')
    expect(lineOf(table, 'Baseline survey')).toHaveTextContent('Not measured: no variable bound')
  })

  it('#1713 D393: a not-measured line is a ROW HEADER named "<tag>: <why>", never a cell no header names', async () => {
    mount()
    const table = await screen.findByRole('table')
    expect(within(table).getByRole('rowheader', { name: 'Baseline survey: Not measured: no variable bound' })).toBeInTheDocument()
    expect(within(table).getByRole('rowheader', { name: 'Interviews: Not measured: what it binds is inactive in the codebook' }))
      .toBeInTheDocument()
    expect(within(table).queryByRole('cell', { name: /Not measured/ })).toBeNull()
  })

  it('the open construct’s strand status gives each strand its own reason, not the shared sentence', async () => {
    mount()
    await screen.findByRole('table')
    fireEvent.click(screen.getByRole('button', { name: /Team morale/ }))
    expect(screen.getByText('Not measured: what it binds is inactive in the codebook.')).toBeInTheDocument()
    expect(screen.getByText('Not measured: none of its survey questions is in this project.')).toBeInTheDocument()
    expect(screen.getByText('Not measured: no variable bound.')).toBeInTheDocument()
    expect(screen.queryByText(/nothing from this strand is bound/)).toBeNull()
    // a covered strand still offers covers / silent (the control)
    expect(screen.getByRole('group', { name: 'Focus groups strand status for Team morale' })).toBeInTheDocument()
  })
})
