/**
 * #1645 — the Compact view draws a rated code's line ONCE per construct, tagged "Rated", after
 * the per-group strands' lines and before a strand drawn beside the groups — never
 * "<strand> · rated" under each strand binding the code (the same person-level number twice,
 * read as each strand's). The mocks are `JointDisplayView-slice2.test.tsx`'s.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
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
import { RATED_LINE_TAG } from '@/lib/joint-display-vocabulary'

let mountCount = 0

function code(codeId: number, name: string, rated: boolean, high: number) {
  return {
    code_id: codeId, name, unit: 'participants', rated, formed_groups: null,
    cells: [
      { group: 'High', count: high, n: 11, share: high / 11, share_undefined_reason: null, passages: 9,
        rating: rated ? { mean: -0.25, n: 4, undefined_reason: null } : null },
      { group: 'Low', count: 1, n: 10, share: 0.1, share_undefined_reason: null, passages: 2,
        rating: rated ? { mean: 0.5, n: 2, undefined_reason: null } : null },
    ],
    difference: { value: null, ci_lower: null, ci_upper: null, ci_level: null, ci_method: null, unavailable_reason: null },
  }
}

function strandOf(kind: string, status: string, lists: Record<string, unknown[]>) {
  return { kind, status, codes: [], variables: [], observation_codes: [], missing_code_ids: [], missing_column_ids: [], ...lists }
}

function payload() {
  return {
    unit: 'participants',
    group_by: { column_id: 11, name: 'Team', dataset_id: 1, dataset_name: 'Roster' },
    groups: [{ key: 'High', participants: 11, with_material: 11, without_coding: 0 },
      { key: 'Low', participants: 10, with_material: 10, without_coding: 0 }],
    unavailable_reason: null,
    scope: { conversations: 4, documents: 0, unassigned_passages: 0, participants_without_group: 0, no_coding_scope: 'every_coder' },
    rating: { basis: 'mean_of_participant_scores', score_basis: 'median', scope: 'every_rated_passage_in_the_project', excluded_ratings: {}, unavailable_reason: null },
    rows: [{
      key: 'r1', codes: [], variables: [], missing_code_ids: [], missing_column_ids: [],
      strands: { codes: 'covers', variables: 'not_measured' },
      by_strand: {
        's-int': strandOf('codes', 'covers', { codes: [code(31, 'Morale', true, 7), code(32, 'Workload', false, 3)] }),
        's-txt': strandOf('text_codes', 'covers', { codes: [code(31, 'Morale', true, 2)] }),
        's-obs': strandOf('observation_codes', 'covers', { observation_codes: [{ code_id: 31, name: 'Morale',
          unit: 'observations', observations: 2, of_observations: 3, seconds: 540, observed_seconds: 3600, time_share: 0.15,
          time_share_undefined_reason: null, clips: null, of_clips: null, clips_undefined_reason: 'clips_open_cuts',
          rating_unavailable_reason: 'not_on_clips' }] }),
      },
    }],
  }
}

const DISPLAY = {
  title: 'Morale by team', group_by_column_id: 11,
  strands: [
    { key: 's-int', kind: 'codes', label: 'Interviews', conversation_ids: [5], document_ids: [] },
    { key: 's-txt', kind: 'text_codes', label: 'Survey comments', text_column_ids: [44] },
    { key: 's-obs', kind: 'observation_codes', label: 'Site visits', observation_ids: null },
  ],
  rows: [{ key: 'r1', construct: 'Morale', bindings: {
    's-int': { code_ids: [31, 32] }, 's-txt': { code_ids: [31] }, 's-obs': { code_ids: [31] } } }],
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const props = {
    node: { attrs: { displayKey: `rated-${++mountCount}`, figureEpoch: 3, display: DISPLAY } },
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

describe('#1645 — the Compact view draws a rated code once, tagged "Rated"', () => {
  it('one Rated line for the code two strands bind; no "<strand> · rated" line; after the per-group strands, before the beside strand', async () => {
    mount()
    const table = await screen.findByRole('table')
    const headers = within(table).getAllByRole('rowheader').map(h => h.textContent ?? '')
    expect(headers.filter(h => h === `${RATED_LINE_TAG}Morale`)).toHaveLength(1)
    expect(headers.some(h => /· rated/i.test(h))).toBe(false)
    // its cells: each group's mean and scores, once
    const ratedRow = within(table).getAllByRole('rowheader').find(h => h.textContent === `${RATED_LINE_TAG}Morale`)!.closest('tr')!
    expect(within(ratedRow).getByText('-0.25 (4 scores)')).toBeInTheDocument()
    expect(within(ratedRow).getByText('0.50 (2 scores)')).toBeInTheDocument()
    expect(within(table).getAllByText('-0.25 (4 scores)')).toHaveLength(1)
    // order: Interviews' lines, Survey comments' line, then Rated, then the observation strand
    const at = (h: string) => headers.indexOf(h)
    expect(at(`${RATED_LINE_TAG}Morale`)).toBeGreaterThan(at('Survey commentsMorale'))
    expect(at(`${RATED_LINE_TAG}Morale`)).toBeGreaterThan(at('InterviewsWorkload'))
    expect(at(`${RATED_LINE_TAG}Morale`)).toBeLessThan(at('Site visitsMorale'))
  })

  it('an unrated code gets no Rated line (the control)', async () => {
    mount()
    const table = await screen.findByRole('table')
    const headers = within(table).getAllByRole('rowheader').map(h => h.textContent ?? '')
    expect(headers).toContain('InterviewsWorkload')
    expect(headers).not.toContain(`${RATED_LINE_TAG}Workload`)
  })
})

/**
 * #1713 (a)/(b), D392 + D394 — what each line and cell is NAMED. jsdom does not lay out, but
 * Testing Library's name computation reads `aria-label`, `aria-hidden` and `sr-only` text as a
 * browser would for these shapes; the drive reads the same names in Chrome's tree.
 */
describe('#1713 — the Compact table’s row headers and notes', () => {
  it('D392: every strand line’s row header is "<tag>: <name>", the tag in its source casing', async () => {
    mount()
    const table = await screen.findByRole('table')
    for (const name of ['Interviews: Morale', 'Interviews: Workload', 'Survey comments: Morale', `${RATED_LINE_TAG}: Morale`, 'Site visits: Morale']) {
      expect(within(table).getByRole('rowheader', { name })).toHaveAttribute('aria-label', name)
    }
    // The drawn tag is unchanged (CSS uppercases it); only the name gains the separator.
    expect(within(table).getAllByRole('rowheader').map(h => h.textContent)).toContain('InterviewsMorale')
  })

  it('D392: a line that formed the groups says so in its name, after the name (its badge is drawn)', async () => {
    const p = payload()
    const workload = p.rows[0].by_strand['s-int'].codes[1] as ReturnType<typeof code>
    workload.formed_groups = 'grouping_variable' as never
    api.compute.mockResolvedValue(p)
    mount()
    const table = await screen.findByRole('table')
    const header = within(table).getByRole('rowheader', { name: 'Interviews: Workload, formed the groups' })
    expect(header).toHaveTextContent('formed the groups')   // the visible badge
    // CONTROL: its sibling, which formed nothing, has no such tail.
    expect(within(table).getByRole('rowheader', { name: 'Interviews: Morale' })).toBeInTheDocument()
  })

  it('D394: a cell with a note names it ONCE — the note alone when there is no value; no description', async () => {
    const p = payload()
    // Both strands binding Morale carry the person-level rating (#1645): change it in each.
    for (const key of ['s-int', 's-txt'] as const) {
      const morale = p.rows[0].by_strand[key].codes[0] as ReturnType<typeof code>
      // Low: no score at all (the sweep's cell); High: a value WITH a note (the other arm).
      morale.cells[1].rating = { mean: null, n: 0, undefined_reason: 'no_scores' } as never
      morale.cells[0].rating = { mean: -0.25, n: 4, undefined_reason: 'no_scores' } as never
    }
    api.compute.mockResolvedValue(p)
    mount()
    const table = await screen.findByRole('table')
    const rated = within(table).getByRole('rowheader', { name: `${RATED_LINE_TAG}: Morale` }).closest('tr')!
    const [high, low] = within(rated).getAllByRole('cell')
    expect(low).toHaveAccessibleName('Nobody in this group has a score on this code.')
    expect(high).toHaveAccessibleName('-0.25 (4 scores) — Nobody in this group has a score on this code.')
    for (const cell of [high, low]) {
      expect(cell).not.toHaveAttribute('title')          // was on the cell: name AND description
      expect(cell).toHaveAccessibleDescription('')
      const shown = cell.querySelector('[aria-hidden]')!
      expect(shown).toHaveAttribute('title', 'Nobody in this group has a score on this code.')   // the mouse keeps it
    }
    // CONTROL: a cell with no note is plain text, nothing hidden.
    const interviews = within(table).getByRole('rowheader', { name: 'Interviews: Workload' }).closest('tr')!
    const plain = within(interviews).getAllByRole('cell')[0]
    expect(plain.querySelector('[aria-hidden], .sr-only')).toBeNull()
  })
})
