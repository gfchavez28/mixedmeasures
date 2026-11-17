/**
 * Joint display slice 2 (r2): the Compact view and the open construct with NAMED strands — three
 * per-group strands and an observation strand beside them, on r1's wire (`rows[].by_strand`, the
 * strands' own facts on `response.strands` — the combine, R3/R6). The mocks are
 * `JointDisplayView.test.tsx`'s; jsdom sees no layout (640×360 is reasoned, not measured).
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
const blindState = { blind: false, withholding: false, settled: true }
vi.mock('@/hooks/useBlindMode', () => ({ useBlindMode: () => blindState }))
const NO_MACHINES = new Set<number>()
vi.mock('@/hooks/useCoders', () => ({
  useCoders: () => ({ coderMap: new Map([[1, { id: 1, username: 'Me' }], [2, { id: 2, username: 'Colleague' }]]) }),
  useMachineCoderIds: () => NO_MACHINES,
}))
vi.mock('@/hooks/useListLoad', () => ({ useListLoad: () => ({ status: 'loading', error: null, retry: () => {}, retrying: false }) }))

const api = vi.hoisted(() => ({
  compute: vi.fn(),
  pinFacts: vi.fn(),
  passages: vi.fn(),
}))
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

let mountCount = 0

function codeStrand(name: string, high: number) {
  return {
    code_id: 31, name, unit: 'participants', rated: false, formed_groups: null,
    cells: [
      { group: 'High', count: high, n: 11, share: high / 11, share_undefined_reason: null, passages: 9, rating: null },
      { group: 'Low', count: 0, n: 10, share: 0, share_undefined_reason: null, passages: 2, rating: null },
    ],
    difference: { value: high / 11, ci_lower: null, ci_upper: null, ci_level: null, ci_method: null, unavailable_reason: null },
  }
}

/** One strand of the row on r1's wire: only its kind's list filled. */
function strandOf(kind: string, status: string, lists: Record<string, unknown[]>) {
  return { kind, status, codes: [], variables: [], observation_codes: [], missing_code_ids: [], missing_column_ids: [], ...lists }
}

/** A code strand's own denominators (`response.strands[i]`) — R3: each header's count is THIS strand's. */
function codeFacts(key: string, highWithout: number) {
  return { key, kind: 'codes', unit: 'participants', dataset_id: null, observations: null,
    scope: { conversations: 1, documents: 0, unassigned_passages: 0, participants_without_group: 0, no_coding_scope: 'every_coder' },
    groups: [{ key: 'High', with_material: 11, without_coding: highWithout, surveyed: null },
      { key: 'Low', with_material: 10, without_coding: 0, surveyed: null }] }
}

function payload() {
  return {
    unit: 'participants',
    group_by: { column_id: 11, name: 'Gain group', dataset_id: 1, dataset_name: 'Roster' },
    // Slice 1's top-level fields: the FIRST code strand's projection (r1-3).
    groups: [{ key: 'High', participants: 11, with_material: 11, without_coding: 2 },
      { key: 'Low', participants: 10, with_material: 10, without_coding: 0 }],
    unavailable_reason: null,
    scope: { conversations: 4, documents: 0, unassigned_passages: 0, participants_without_group: 0, no_coding_scope: 'every_coder' },
    rating: null,
    strands: [
      codeFacts('s-int', 2), codeFacts('s-fg', 5),
      { key: 's-svy', kind: 'variables', unit: 'participants', dataset_id: 2, groups: null, scope: null, observations: null },
      { key: 's-obs', kind: 'observation_codes', unit: 'observations', dataset_id: null, groups: null, scope: null,
        observations: { chosen: 3, with_coding: 2, agreed: 0, observed_seconds: 3600, segmentation: 'open' } },
    ],
    rows: [{
      key: 'r1', codes: [codeStrand('Planning time', 7), codeStrand('Planning time', 2)], variables: [],
      missing_code_ids: [], missing_column_ids: [], strands: { codes: 'covers', variables: 'not_measured' },
      by_strand: {
        's-int': strandOf('codes', 'covers', { codes: [codeStrand('Planning time', 7)] }),
        's-fg': strandOf('codes', 'covers', { codes: [codeStrand('Planning time', 2)] }),
        // #1659: the row binds nothing from the survey strand — the server says so
        's-svy': { ...strandOf('variables', 'not_measured', {}), not_measured_reason: 'nothing_bound' },
        's-obs': strandOf('observation_codes', 'covers', { observation_codes: [{ code_id: 31, name: 'Planning time',
          unit: 'observations', observations: 2, of_observations: 3, seconds: 540, observed_seconds: 3600, time_share: 0.15,
          time_share_undefined_reason: null, clips: null, of_clips: null, clips_undefined_reason: 'clips_open_cuts',
          rating_unavailable_reason: null }] }),
      },
    }],
  }
}

const DISPLAY = {
  title: 'Teachers by gain group', group_by_column_id: 11,
  strands: [
    { key: 's-int', kind: 'codes', label: 'Interviews', conversation_ids: [5], document_ids: [] },
    { key: 's-fg', kind: 'codes', label: 'Focus groups', conversation_ids: [7], document_ids: [] },
    { key: 's-svy', kind: 'variables', label: 'Baseline survey', dataset_id: 2 },
    { key: 's-obs', kind: 'observation_codes', label: 'Site visits', observation_ids: null },
  ],
  rows: [{ key: 'r1', construct: 'Protected planning time', fit: 'expansion',
    bindings: { 's-int': { code_ids: [31] }, 's-fg': { code_ids: [31] }, 's-obs': { code_ids: [31] } } }],
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const updateAttributes = vi.fn()
  const openDialog = vi.fn()
  const displayKey = `s2-${++mountCount}`
  const props = {
    node: { attrs: { displayKey, figureEpoch: 3, display: DISPLAY } },
    updateAttributes, deleteNode: vi.fn(), selected: false, editor: { isEditable: true },
  } as unknown as NodeViewProps
  render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <DialogsContext.Provider value={openDialog}>
          <JointDisplayView {...props} />
        </DialogsContext.Provider>
      </QueryClientProvider>
    </MemoryRouter>,
  )
  return { updateAttributes, openDialog, displayKey }
}

const lastDisplay = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls[fn.mock.calls.length - 1][0].display

beforeEach(() => {
  Object.assign(blindState, { blind: false, withholding: false, settled: true })
  api.compute.mockResolvedValue(payload())
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('joint display slice 2 — the Compact view draws every strand by its name', () => {
  it('sends the strands (C2), tags each line with its strand, and draws the observation strand once, beside the groups', async () => {
    mount()
    const table = await screen.findByRole('table')
    expect(api.compute.mock.calls[0][1].strands.map((s: { key: string }) => s.key)).toEqual(['s-int', 's-fg', 's-svy', 's-obs'])
    const headers = within(table).getAllByRole('rowheader').map(h => h.textContent)
    expect(headers).toContain('InterviewsPlanning time')
    expect(headers).toContain('Focus groupsPlanning time')
    expect(headers).toContain('Site visitsPlanning time')
    expect(within(table).getByText('Baseline survey').parentElement).toHaveTextContent('Baseline surveyNot measured: no variable bound')
    const obsCell = within(table).getByText(/2 of 3 observations/)
    expect(obsCell).toHaveTextContent('2 of 3 observations · 15% of observed time (9 min) · drawn once across the groups, not split by group')
    // r2-3: the Fit column prints the fit WITH its pair (the report's words)
    expect(within(table).getByText('Interviews · Focus groups: expansion')).toBeInTheDocument()
    expect(obsCell).toHaveAttribute('colspan', '2')   // across the group columns, never split
  })

  it('R3: with two code strands, each group header gives EACH strand’s own "with no coding", named', async () => {
    mount()
    const table = await screen.findByRole('table')
    const high = within(table).getAllByRole('columnheader').find(h => h.textContent?.startsWith('High'))!
    // The top-level `groups` carry only the first strand's 2; Focus groups' own count is 5.
    expect(high).toHaveTextContent('High · 11 · Interviews: 2 with no coding · Focus groups: 5 with no coding')
    const low = within(table).getAllByRole('columnheader').find(h => h.textContent?.startsWith('Low'))!
    expect(low).toHaveTextContent(/^Low · 10$/)   // a 0 is not printed in a header
    // …and the footer's note says it per strand, each over its own groups.
    expect(screen.getByText(/Interviews: Some participants have .* \(High: 2, Low: 0\)\..*Focus groups: Some participants have .* \(High: 5, Low: 0\)/))
      .toBeInTheDocument()
  })
})

describe('joint display slice 2 — the open construct', () => {
  it('a status per strand; the fit names its pair, and with 3+ strands the researcher chooses it (r2-3)', async () => {
    const { updateAttributes } = mount()
    await screen.findByRole('table')
    fireEvent.click(screen.getByRole('button', { name: /Protected planning time/ }))
    expect(screen.getByRole('group', { name: 'Fit for Protected planning time: Interviews · Focus groups' })).toBeInTheDocument()
    for (const s of ['Interviews', 'Focus groups', 'Site visits']) {
      expect(screen.getByRole('group', { name: `${s} strand status for Protected planning time` })).toBeInTheDocument()
    }
    expect(screen.queryByRole('group', { name: /Baseline survey strand status/ })).toBeNull()   // not measured: the app's
    fireEvent.click(within(screen.getByRole('group', { name: 'Focus groups strand status for Protected planning time' }))
      .getByRole('radio', { name: 'Silent' }))
    expect(lastDisplay(updateAttributes).rows[0].status['s-fg']).toBe('silent')
    const second = screen.getByRole('combobox', { name: 'Second strand of fit 1 for Protected planning time' })
    expect(within(second).getAllByRole('option').map(o => o.textContent)).toEqual(['Focus groups', 'Baseline survey', 'Site visits'])
    fireEvent.change(second, { target: { value: 's-obs' } })
    // R2: fits are ALWAYS stored as `row.fits`, the pair with its fit (slice 1's `fit` is read, never written)
    expect(lastDisplay(updateAttributes).rows[0].fits).toEqual([{ strands: ['s-int', 's-obs'], fit: 'expansion' }])
    expect(lastDisplay(updateAttributes).rows[0].fit).toBeUndefined()
    expect(screen.getByText(/Site visits \(3 observations\): Planning time 2 of 3 observations/)).toBeInTheDocument()
  })

  it('shape (ii): "Compare another pair" adds the first pair not yet recorded, stored as `fits`; never every pair', async () => {
    const { updateAttributes } = mount()
    await screen.findByRole('table')
    fireEvent.click(screen.getByRole('button', { name: /Protected planning time/ }))
    expect(screen.getAllByRole('group', { name: /^Fit for Protected planning time/ })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Compare another pair' }))
    expect(lastDisplay(updateAttributes).rows[0].fits).toEqual([
      { strands: ['s-int', 's-fg'], fit: 'expansion' }, { strands: ['s-int', 's-svy'], fit: null }])
  })

  it('a pin is chosen from a code strand’s own sources: the request names each code’s strand (r2-5)', async () => {
    const { openDialog } = mount()
    await screen.findByRole('table')
    fireEvent.click(screen.getByRole('button', { name: /Protected planning time/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Pin a quote for High, Protected planning time' }))
    expect(openDialog).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'pin', codes: [
      { id: 31, name: 'Planning time · Interviews', strandKey: 's-int' },
      { id: 31, name: 'Planning time · Focus groups', strandKey: 's-fg' },
    ] }))
    expect(screen.getByText(/chosen from Planning time \(Interviews\) 9 · Planning time \(Focus groups\) 9 coded passages/)).toBeInTheDocument()
  })
})
