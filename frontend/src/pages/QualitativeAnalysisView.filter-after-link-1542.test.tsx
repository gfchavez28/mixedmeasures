/**
 * #1542 (1.6.0, D123) — a link to the analysis page while it is open can carry another participant
 * list, and the chosen values then no longer describe what is applied: they are DROPPED, so the
 * panel never claims a filter its requests do not carry.
 *
 * The page stays mounted across a same-route navigation (TopRail's *Analysis › Qualitative*, a code
 * hit in Search), so `useQualitativeAnalysis`'s `filterChoice` survived it: after a link with no
 * `pids` the reads went unfiltered while the panel still read "Group, 1 chosen" with the rule line
 * shown (the 2026-11-06e /codebase-audit, F6; its git-ignored
 * probe). The fix decides only when a NEW LOCATION commits — never on an ordinary render, where
 * a new choice sits beside the old URL for one transition (`url-state.md` §2) — so the cases below
 * also pin that the hook's OWN writes keep the values.
 * Fixture and harness: `QualitativeAnalysisView.filter-state-1537.test.tsx`'s (Pat 501 = Group X /
 * Site North, Sam 502 = Group Y / Site South; code A counts 5 unfiltered and 1 under any filter).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  NO_PARTICIPANT_MATCHES_VALUES, PARTICIPANT_FILTER_RULE, givenFilterNote,
} from '@/lib/participant-filter'

const frequencies = vi.fn()
const demographicFilters = vi.fn()
const codedSegments = vi.fn((..._a: unknown[]) => Promise.resolve())
const codeCooccurrence = vi.fn()
const sourceFrequenciesCsv = vi.fn()
const demographicComparisonCsv = vi.fn()
const exportCodeFrequenciesCsv = vi.fn((..._a: unknown[]) => Promise.resolve())
const createMaterial = vi.fn()
const listCoders = vi.fn()
// The page's other reads that carry the filter; they never answer — only whether they are ASKED matters.
const sourceFrequencies = vi.fn((..._a: unknown[]) => new Promise(() => {}))
const demographicComparison = vi.fn((..._a: unknown[]) => new Promise(() => {}))
const listQuoted = vi.fn((..._a: unknown[]) => new Promise(() => {}))

const CODE = {
  id: 601, project_id: 1, numeric_id: 2, name: 'A', description: null, color: null,
  is_universal: false, is_active: true, created_at: '', updated_at: '',
  usage_count: 0, category_id: null, category_name: null, category_color: null, category_order: null,
}
const OPTIONS = [
  { subtype: 'group', label: 'Group', values: [
    { value: 'X', participant_ids: [501], count: 1 }, { value: 'Y', participant_ids: [502], count: 1 },
  ] },
  { subtype: 'site', label: 'Site', values: [
    { value: 'North', participant_ids: [501], count: 1 }, { value: 'South', participant_ids: [502], count: 1 },
  ] },
]
const material = (id: number, name: string, participantIds: number[]) => ({
  id, collection_id: 7, material_type: 'qualitative_descriptives', auto_name: name, custom_name: null,
  display_order: id, source_tab: 'descriptives', created_at: '', has_missing_refs: false, missing_refs: [],
  config: { tab: 'descriptives', source: 'all', participant_ids: participantIds },
})

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  const never = () => new Promise(() => {})
  return {
    ...actual,
    codesApi: { ...actual.codesApi, list: () => Promise.resolve({ codes: [CODE], total: 1 }) },
    categoriesApi: { ...actual.categoriesApi, list: () => Promise.resolve({ categories: [] }) },
    conversationsApi: { ...actual.conversationsApi, list: () => Promise.resolve({ conversations: [], total: 0 }) },
    documentsApi: { ...actual.documentsApi, list: () => Promise.resolve([]) },
    observationsApi: { ...actual.observationsApi, list: () => Promise.resolve([]) },
    materialsApi: {
      ...actual.materialsApi,
      list: () => Promise.resolve({ collections: [{ id: 7, project_id: 1, name: 'Materials', display_order: 0, created_at: '', material_count: 2 }] }),
      get: () => Promise.resolve({
        id: 7, project_id: 1, name: 'Materials', display_order: 0, created_at: '',
        materials: [material(1, 'Saved under Group Y', [502]), material(2, 'Saved unfiltered', [])],
      }),
      createMaterial: (...a: unknown[]) => createMaterial(...a),
    },
    authApi: { ...actual.authApi, listCoders: (...a: unknown[]) => listCoders(...a) },
    excerptsApi: { ...actual.excerptsApi, listQuoted: (...a: unknown[]) => listQuoted(...a) },
    exportApi: {
      ...actual.exportApi,
      codedSegments: (...a: unknown[]) => codedSegments(...a),
      codeCooccurrence: (...a: unknown[]) => codeCooccurrence(...a),
      sourceFrequenciesCsv: (...a: unknown[]) => sourceFrequenciesCsv(...a),
      demographicComparisonCsv: (...a: unknown[]) => demographicComparisonCsv(...a),
    },
    codeAnalysisApi: {
      ...actual.codeAnalysisApi,
      frequencies: (...a: unknown[]) => frequencies(...a),
      textColumnsWithCoding: () => Promise.resolve([]),
      demographicFilters: (...a: unknown[]) => demographicFilters(...a),
      consensusStatus: () => Promise.resolve({ exists: false, stale_count: 0 }),
      coderCoverage: () => Promise.resolve({ coders: [], count: 0 }),
      machineAgreement: never,
      sourceFrequencies: (...a: unknown[]) => sourceFrequencies(...a),
      demographicComparison: (...a: unknown[]) => demographicComparison(...a),
      saturation: never,
    },
  }
})
vi.mock('@/lib/code-frequencies-export', async () => {
  const actual = await vi.importActual<typeof import('@/lib/code-frequencies-export')>('@/lib/code-frequencies-export')
  return { ...actual, exportCodeFrequenciesCsv: (...a: unknown[]) => exportCodeFrequenciesCsv(...a) }
})
vi.mock('@/layouts/ProjectLayout', () => ({
  useProjectLayout: () => ({ projectId: 1, openCodebook: vi.fn(), setBreadcrumbLabel: vi.fn() }),
}))
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 1, username: 'Alice' }, refreshAuth: vi.fn() }),
}))

import QualitativeAnalysisView from '@/pages/QualitativeAnalysisView'

const ALICE = { id: 1, username: 'Alice', display_color: null, archived: false }

/** Links to the SAME route, so the page stays mounted. The first is TopRail's and Search's shape
 *  (`go(projectBase + '/analysis/qualitative')`, `…?tab=content&contentMode=by-code&codes=ID`): a new
 *  search with no `pids`. No in-app link carries `pids` today; the other two are the URL's own cases. */
function NavProbe() {
  const navigate = useNavigate()
  return (
    <>
      <button type="button" onClick={() => navigate('/projects/1/analysis/qualitative?tab=descriptives&codes=601')}>link-without-pids</button>
      <button type="button" onClick={() => navigate('/projects/1/analysis/qualitative?tab=descriptives&codes=601&pids=501')}>link-with-other-pids</button>
      <button type="button" onClick={() => navigate('/projects/1/analysis/qualitative?tab=descriptives&codes=601&pids=502')}>link-with-same-pids</button>
      <button type="button" onClick={() => navigate(-1)}>back</button>
    </>
  )
}
function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.search}</output>
}

let queryClient: QueryClient
function renderPage(query = '') {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        {/* A query naming its own tab must not follow a default one: `get('tab')` reads the first. */}
        <MemoryRouter initialEntries={[`/projects/1/analysis/qualitative?${query.includes('tab=') ? '' : 'tab=descriptives&'}codes=601${query}`]}>
          <Routes>
            <Route
              path="/projects/:projectId/analysis/qualitative"
              element={<><QualitativeAnalysisView /><LocationProbe /><NavProbe /></>}
            />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  )
}

/** The applied filter: the URL's `pids`. */
const pids = () => new URLSearchParams(screen.getByTestId('location').textContent ?? '').get('pids')
/** The `participant_ids` the last coding-count request sent. */
const lastSent = () => {
  const calls = frequencies.mock.calls
  return (calls[calls.length - 1]?.[1] as { participant_ids?: string } | undefined)?.participant_ids
}
async function toggleFilters() {
  fireEvent.click(await screen.findByRole('button', { name: /^Filters/ }))
}
async function choose(variable: string, value: string) {
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${variable}(, \\d+ chosen)?$`) }))
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${value} \\(`) }))
  fireEvent.mouseDown(document.body)  // close the list, as a click outside does
}

class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver)
  const store: Record<string, string> = {}
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => { store[k] = String(v) },
      removeItem: (k: string) => { delete store[k] },
      clear: () => {},
    },
  })
  vi.clearAllMocks()
  listCoders.mockResolvedValue([ALICE])
  // Code A counts 5 unfiltered and 1 under any filter — so a whole-project count is visible.
  frequencies.mockImplementation((_pid: unknown, params?: { participant_ids?: string }) => Promise.resolve({
    frequencies: [{ code_id: 601, segment_count: params?.participant_ids ? 1 : 5, text_count: 0 }],
    total_coded_segments: 1, total_coded_texts: 0,
  }))
  demographicFilters.mockResolvedValue({ filters: OPTIONS, conversations: [] })
})

afterEach(cleanup)



/** Choose Group = Y and wait until the URL and the count request both carry it. */
async function chooseGroupY() {
  await toggleFilters()
  await choose('Group', 'Y')
  await waitFor(() => expect(pids()).toBe('502'))
  await waitFor(() => expect(lastSent()).toBe('502'))
  expect(await screen.findByRole('button', { name: 'Group, 1 chosen' })).toBeInTheDocument()
}

describe('#1542 — a link that changes the list drops the chosen values', () => {
  it('a link with no `pids`: the reads go unfiltered and the panel claims no values and no rule', async () => {
    renderPage()
    await chooseGroupY()
    fireEvent.click(screen.getByRole('button', { name: 'link-without-pids' }))
    await waitFor(() => expect(pids()).toBeNull())
    await waitFor(() => expect(lastSent()).toBeUndefined())
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Group, 1 chosen' })).toBeNull())
    expect(screen.queryByText(PARTICIPANT_FILTER_RULE)).toBeNull()
    expect(screen.getByRole('button', { name: 'Group' })).toBeInTheDocument()
  })

  it('a link with ANOTHER list: the choice follows the URL — the panel says the list it was given', async () => {
    renderPage()
    await chooseGroupY()
    fireEvent.click(screen.getByRole('button', { name: 'link-with-other-pids' }))
    await waitFor(() => expect(pids()).toBe('501'))
    await waitFor(() => expect(lastSent()).toBe('501'))
    expect(await screen.findByText(givenFilterNote(1), { exact: false })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Group, 1 chosen' })).toBeNull()
  })

  it('a link with the SAME list keeps the values (the list did not change)', async () => {
    renderPage()
    await chooseGroupY()
    fireEvent.click(screen.getByRole('button', { name: 'link-with-same-pids' }))
    await waitFor(() => expect(new URLSearchParams(screen.getByTestId('location').textContent ?? '').get('codes')).toBe('601'))
    expect(pids()).toBe('502')
    expect(screen.getByRole('button', { name: 'Group, 1 chosen' })).toBeInTheDocument()
  })

  it('Back after the link returns the list without values: SAID, never claimed as the old values', async () => {
    renderPage()
    await chooseGroupY()
    fireEvent.click(screen.getByRole('button', { name: 'link-without-pids' }))
    await waitFor(() => expect(pids()).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'back' }))
    await waitFor(() => expect(pids()).toBe('502'))
    await waitFor(() => expect(lastSent()).toBe('502'))
    expect(await screen.findByText(givenFilterNote(1), { exact: false })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Group, 1 chosen' })).toBeNull()
  })
})

describe('#1542 — the page’s OWN writes keep the values (positive controls)', () => {
  it('another setter (Exclude facilitator) writes the URL and the values stay', async () => {
    renderPage()
    await chooseGroupY()
    fireEvent.click(await screen.findByRole('button', { name: /^Sources/ }))
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Exclude facilitator' }))
    await waitFor(() => expect(new URLSearchParams(screen.getByTestId('location').textContent ?? '').get('excl')).toBe('0'))
    expect(pids()).toBe('502')
    expect(screen.getByRole('button', { name: 'Group, 1 chosen' })).toBeInTheDocument()
    expect(screen.getByText(PARTICIPANT_FILTER_RULE)).toBeInTheDocument()
  })

  it('two choices in quick succession: the values are the last choice’s, never dropped between them', async () => {
    renderPage()
    await toggleFilters()
    await choose('Group', 'Y')
    await choose('Site', 'South')   // Y ∩ South = Sam (502): the same list, new values
    await waitFor(() => expect(pids()).toBe('502'))
    expect(await screen.findByRole('button', { name: 'Group, 1 chosen' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Site, 1 chosen' })).toBeInTheDocument()
  })

  it('values that match no one remove `pids`, and the location that writes it keeps them (#1538)', async () => {
    renderPage()
    await toggleFilters()
    await choose('Group', 'Y')
    await choose('Site', 'North')   // Y ∩ North = no one: no `pids`, the values kept and said
    expect(await screen.findByText(NO_PARTICIPANT_MATCHES_VALUES)).toBeInTheDocument()
    expect(pids()).toBeNull()
    expect(screen.getByRole('button', { name: 'Group, 1 chosen' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Site, 1 chosen' })).toBeInTheDocument()
  })
})
