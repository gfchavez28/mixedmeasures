/**
 * #1545 (1.6.0) — every file the analysis page writes under the participant filter says so: the
 * client's files (Frequencies, Quote Board) on their scope line, the server's (Co-occurrence,
 * Source Data, Comparison) by handing the route the panel's description of the
 * values as `participant_filter_label` beside the ids. Run through the REAL hook, panel and page
 * wiring; the fixture and harness are `QualitativeAnalysisView.filter-state-1537.test.tsx`'s.
 * The comparison view's own door: `RelationshipsPanel.filter-label-1545.test.tsx`. The server's
 * half of each file: `backend/tests/test_participant_filter_files_1545.py`.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { PARTICIPANT_FILTER_RULE } from '@/lib/participant-filter'

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
const quoteBoardScopes: (string | null)[] = []
vi.mock('@/components/qualitative-analysis/QuoteBoardView', () => ({
  default: (props: { fileScope: string | null }) => {
    quoteBoardScopes.push(props.fileScope)
    return <div data-testid="quote-board-stub" />
  },
}))
vi.mock('@/layouts/ProjectLayout', () => ({
  useProjectLayout: () => ({ projectId: 1, openCodebook: vi.fn(), setBreadcrumbLabel: vi.fn() }),
}))
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 1, username: 'Alice' }, refreshAuth: vi.fn() }),
}))

import QualitativeAnalysisView from './QualitativeAnalysisView'

const ALICE = { id: 1, username: 'Alice', display_color: null, archived: false }

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
              element={<><QualitativeAnalysisView /><LocationProbe /></>}
            />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  )
}

/** The applied filter: the URL's `pids`. */
const pids = () => new URLSearchParams(screen.getByTestId('location').textContent ?? '').get('pids')

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
  quoteBoardScopes.length = 0
  listCoders.mockResolvedValue([ALICE])
  // Code A counts 5 unfiltered and 1 under any filter — so a whole-project count is visible.
  frequencies.mockImplementation((_pid: unknown, params?: { participant_ids?: string }) => Promise.resolve({
    frequencies: [{ code_id: 601, segment_count: params?.participant_ids ? 1 : 5, text_count: 0 }],
    total_coded_segments: 1, total_coded_texts: 0,
  }))
  demographicFilters.mockResolvedValue({ filters: OPTIONS, conversations: [] })
})

afterEach(cleanup)


const FILTERED = `Scope: participant filter: Group: Y (1 participant). ${PARTICIPANT_FILTER_RULE}`
const scopeOf = (call: unknown[] | undefined) => (call?.[1] as { scope?: string | null } | undefined)?.scope

async function openExports() {
  fireEvent.click(await screen.findByRole('button', { name: 'Exports' }))
}

describe('#1545 — every file written under the filter says so', () => {
  it('chosen values: each of the five Exports doors names them', async () => {
    renderPage('&docs=201&groupBy=group')
    await toggleFilters()
    await choose('Group', 'Y')
    await waitFor(() => expect(pids()).toBe('502'))
    await openExports()

    fireEvent.click(screen.getByRole('button', { name: 'Frequencies CSV' }))
    await waitFor(() => expect(exportCodeFrequenciesCsv).toHaveBeenCalledTimes(1))
    expect(scopeOf(exportCodeFrequenciesCsv.mock.calls[0])).toBe(FILTERED)

    fireEvent.click(screen.getByRole('button', { name: 'Co-occurrence CSV' }))
    expect(codeCooccurrence).toHaveBeenCalledTimes(1)
    expect((codeCooccurrence.mock.calls[0][1] as { participant_ids?: string }).participant_ids).toBe('502')
    expect(codeCooccurrence.mock.calls[0][2]).toBe('Group: Y')

    fireEvent.click(screen.getByRole('button', { name: 'Source Data CSV' }))
    expect(sourceFrequenciesCsv).toHaveBeenCalledTimes(1)
    expect(sourceFrequenciesCsv.mock.calls[0][1]).toMatchObject({ participant_ids: '502', participant_filter_label: 'Group: Y' })

    fireEvent.click(screen.getByRole('button', { name: 'Comparison CSV' }))
    expect(demographicComparisonCsv).toHaveBeenCalledTimes(1)
    expect(demographicComparisonCsv.mock.calls[0][1]).toMatchObject({ participant_ids: '502', participant_filter_label: 'Group: Y' })
  })

  it('the header’s Export CSV writes the same line', async () => {
    renderPage('&docs=201')
    await toggleFilters()
    await choose('Group', 'Y')
    await waitFor(() => expect(pids()).toBe('502'))
    fireEvent.click(screen.getByRole('button', { name: /^Export CSV/ }))
    await waitFor(() => expect(exportCodeFrequenciesCsv).toHaveBeenCalledTimes(1))
    expect(scopeOf(exportCodeFrequenciesCsv.mock.calls[0])).toBe(FILTERED)
  })

  it('the Quote Board is handed the line for its file', async () => {
    renderPage('&tab=quoteboard')
    await toggleFilters()
    await choose('Group', 'Y')
    await waitFor(() => expect(pids()).toBe('502'))
    await waitFor(() => expect(quoteBoardScopes[quoteBoardScopes.length - 1]).toBe(FILTERED))
  })

  it('a list from a link (no values, D124): the count alone, and no label is sent', async () => {
    renderPage('&docs=201&groupBy=group&pids=502')
    await waitFor(() => expect(pids()).toBe('502'))
    await openExports()
    fireEvent.click(screen.getByRole('button', { name: 'Frequencies CSV' }))
    await waitFor(() => expect(exportCodeFrequenciesCsv).toHaveBeenCalledTimes(1))
    expect(scopeOf(exportCodeFrequenciesCsv.mock.calls[0]))
      .toBe(`Scope: participant filter: 1 participant. ${PARTICIPANT_FILTER_RULE}`)
    fireEvent.click(screen.getByRole('button', { name: 'Source Data CSV' }))
    expect(sourceFrequenciesCsv.mock.calls[0][1]).toMatchObject({ participant_ids: '502' })
    expect((sourceFrequenciesCsv.mock.calls[0][1] as Record<string, string>).participant_filter_label).toBeUndefined()
  })

  it('POSITIVE CONTROL: no filter, no line and no label', async () => {
    renderPage('&docs=201&groupBy=group')
    await openExports()
    fireEvent.click(screen.getByRole('button', { name: 'Frequencies CSV' }))
    await waitFor(() => expect(exportCodeFrequenciesCsv).toHaveBeenCalledTimes(1))
    expect(scopeOf(exportCodeFrequenciesCsv.mock.calls[0])).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Co-occurrence CSV' }))
    expect(codeCooccurrence.mock.calls[0][2]).toBeUndefined()
    fireEvent.click(screen.getByRole('button', { name: 'Source Data CSV' }))
    expect(sourceFrequenciesCsv.mock.calls[0][1]).not.toHaveProperty('participant_filter_label')
  })
})
