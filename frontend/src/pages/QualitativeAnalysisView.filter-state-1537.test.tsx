/**
 * #1537/#1538 (1.6.0, D122–D126) — the analysis page keeps the participant filter the researcher
 * chose, keeps a filter it was given, and reads nothing when the chosen values match no one.
 *
 * Each case is a scenario of the 2026-11-06b review's probe and drive (in its
 * git-ignored kit), run here through the REAL hook, panel and page wiring:
 *   S1 a filter in the URL survives opening *Filters* · S2 collapsing and reopening keeps the values
 *   S3/S3b a saved analysis loaded while *Filters* is open applies its OWN list
 *   S4/S4b values no one holds together: no request carries the filter, one notice, every door waits
 *   D123 the values are re-applied when the people they select change
 * The fixture is the drive's: Pat (501) = Group X / Site North, Sam (502) = Group Y / Site South.
 * Harness: the #1535 Segments-CSV test's.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  NO_PARTICIPANT_MATCHES_VALUES, PARTICIPANT_FILTER_RULE, givenFilterNote, noParticipantMatchesNotice,
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
/** The `participant_ids` the last coding-count request sent. */
const lastSent = () => {
  const calls = frequencies.mock.calls
  return (calls[calls.length - 1]?.[1] as { participant_ids?: string } | undefined)?.participant_ids
}
/** The sidebar's count beside code A ('' while it shows none). */
const countOfA = () => screen.getAllByRole('treeitem')
  .find(item => item.textContent?.replace(/\d+$/, '') === 'A')
  ?.querySelector('.tabular-nums')?.textContent ?? null

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

describe('#1537 — the filter is kept until the researcher changes it', () => {
  it('S0 + S2: choosing Group = Y applies it; collapsing and reopening Filters keeps it', async () => {
    renderPage()
    await toggleFilters()
    await choose('Group', 'Y')
    await waitFor(() => expect(pids()).toBe('502'))
    await waitFor(() => expect(lastSent()).toBe('502'))
    expect(screen.getByText(PARTICIPANT_FILTER_RULE)).toBeInTheDocument()

    await toggleFilters()  // collapse: the panel unmounts
    expect(screen.queryByRole('button', { name: /^Group/ })).not.toBeInTheDocument()
    await toggleFilters()  // reopen

    expect(await screen.findByRole('button', { name: 'Group, 1 chosen' })).toBeInTheDocument()
    expect(pids()).toBe('502')
    expect(lastSent()).toBe('502')
    expect(screen.getByText(PARTICIPANT_FILTER_RULE)).toBeInTheDocument()
  })

  it('S1: a filter arriving in the URL survives opening Filters, is said, and clears only on Clear filter', async () => {
    renderPage('&pids=502')
    await waitFor(() => expect(lastSent()).toBe('502'))
    await toggleFilters()

    expect(await screen.findByText(givenFilterNote(1))).toBeInTheDocument()
    expect(screen.getByText(PARTICIPANT_FILTER_RULE)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Group' })).toBeInTheDocument()  // no value is claimed
    expect(pids()).toBe('502')

    fireEvent.click(screen.getByRole('button', { name: /Clear filter/ }))
    await waitFor(() => expect(pids()).toBeNull())
    await waitFor(() => expect(lastSent()).toBeUndefined())
    expect(screen.queryByText(givenFilterNote(1))).not.toBeInTheDocument()
  })

  it('S3: a saved analysis loaded while Filters is open applies its OWN list, and its values are not claimed', async () => {
    renderPage()
    await toggleFilters()
    await choose('Group', 'X')
    await waitFor(() => expect(pids()).toBe('501'))

    fireEvent.click(screen.getByRole('button', { name: /^Materials/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Saved under Group Y/ }))

    await waitFor(() => expect(pids()).toBe('502'))
    await waitFor(() => expect(lastSent()).toBe('502'))
    expect(await screen.findByText(givenFilterNote(1))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Group' })).toBeInTheDocument()  // X no longer shown chosen
  })

  it('S3b: an unfiltered saved analysis loaded while Filters is open leaves no filter', async () => {
    renderPage()
    await toggleFilters()
    await choose('Group', 'X')
    await waitFor(() => expect(pids()).toBe('501'))

    fireEvent.click(screen.getByRole('button', { name: /^Materials/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Saved unfiltered/ }))

    await waitFor(() => expect(pids()).toBeNull())
    await waitFor(() => expect(lastSent()).toBeUndefined())
    expect(screen.getByRole('button', { name: 'Group' })).toBeInTheDocument()
    expect(screen.queryByText(PARTICIPANT_FILTER_RULE)).not.toBeInTheDocument()
  })

  it('removing the last chosen value leaves no filter — and no values', async () => {
    renderPage()
    await toggleFilters()
    await choose('Group', 'Y')
    await waitFor(() => expect(pids()).toBe('502'))
    await choose('Group', 'Y')  // the same value again: deselected
    await waitFor(() => expect(pids()).toBeNull())
    await waitFor(() => expect(lastSent()).toBeUndefined())
    expect(screen.getByRole('button', { name: 'Group' })).toBeInTheDocument()
    expect(screen.queryByText(PARTICIPANT_FILTER_RULE)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Clear all/ })).not.toBeInTheDocument()
  })

  it('D123: the values are re-applied when the people they select change, and only then', async () => {
    renderPage()
    await toggleFilters()
    await choose('Group', 'Y')
    await waitFor(() => expect(pids()).toBe('502'))

    // The options refetch with nothing changed: no write.
    const before = frequencies.mock.calls.length
    await act(() => queryClient.invalidateQueries({ queryKey: ['demographic-filters', 1] }))
    expect(pids()).toBe('502')

    // A participant linked to Y since: the same values now select two people.
    demographicFilters.mockResolvedValue({ filters: [
      { ...OPTIONS[0], values: [OPTIONS[0].values[0], { value: 'Y', participant_ids: [502, 503], count: 2 }] },
      OPTIONS[1],
    ], conversations: [] })
    await act(() => queryClient.invalidateQueries({ queryKey: ['demographic-filters', 1] }))
    await waitFor(() => expect(pids()).toBe('502,503'))
    await waitFor(() => expect(lastSent()).toBe('502,503'))
    expect(frequencies.mock.calls.length).toBeGreaterThan(before)
  })
})

describe('#1538 — values no participant holds together read nothing and say so', () => {
  const NOTICE = noParticipantMatchesNotice('Group: X; Site: South')

  it.each([
    ['S4: Group = X, then Site = South', [['Group', 'X'], ['Site', 'South']]],
    ['S4b: Site = South, then Group = X', [['Site', 'South'], ['Group', 'X']]],
  ] as const)('%s', async (_name, steps) => {
    renderPage()
    await waitFor(() => expect(countOfA()).toBe('5'))  // unfiltered — and now cached
    await toggleFilters()
    await choose(steps[0][0], steps[0][1])
    await waitFor(() => expect(pids()).not.toBeNull())
    await waitFor(() => expect(countOfA()).toBe('1'))
    const sentBefore = frequencies.mock.calls.length

    await choose(steps[1][0], steps[1][1])
    expect(await screen.findByText(NOTICE)).toBeInTheDocument()
    const panelLine = screen.getByTestId('participant-filter-nobody')
    expect(panelLine).toHaveAttribute('role', 'status')
    expect(panelLine).toHaveTextContent(NO_PARTICIPANT_MATCHES_VALUES)
    expect(pids()).toBeNull()
    expect(screen.getByRole('button', { name: 'Group, 1 chosen' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Site, 1 chosen' })).toBeInTheDocument()
    expect(screen.queryByText(PARTICIPANT_FILTER_RULE)).not.toBeInTheDocument()
    // No request goes out without the filter — it would count the whole project.
    expect(frequencies.mock.calls.length).toBe(sentBefore)
    // …and the sidebar's code count is not the whole project's answer, which the disabled
    // query still holds under the unfiltered key: no number at all.
    expect(countOfA()).toBe('')
    // With no source selected *Add to Materials* would be natively disabled (nothing to draw);
    // blocked by the filter it stays focusable, so its reason can be reached (#754).
    const add = screen.getByRole('button', { name: /^Add to Materials/ })
    expect(add).toHaveAttribute('aria-disabled', 'true')
    expect(add).not.toBeDisabled()
  })

  it.each([
    // [the read, the page that asks it, the spy, the filter as that read sends it]
    ['the summary table and its charts', '&docs=201', sourceFrequencies, (a: unknown[]) => (a[1] as { participant_ids?: number[] }).participant_ids],
    ['the group comparison', '&tab=relationships&relView=comparisons&groupBy=group&docs=201', demographicComparison, (a: unknown[]) => (a[1] as { participant_ids?: number[] }).participant_ids],
    ['the Quote Board', '&tab=quoteboard', listQuoted, (a: unknown[]) => (a[1] as { participant_ids?: string }).participant_ids],
  ] as const)('%s is not asked without the filter while no one matches', async (_name, query, spy, sentFilter) => {
    // The page OPENS filtered, so no unfiltered request of this read is ever in flight: these
    // spies never answer, and a second ask of a key already being fetched would join that fetch
    // rather than call again — the first version of this test could not see the mutant.
    renderPage(`${query}&pids=501`)
    // The read is asked WITH the filter — the positive control for the absence below.
    await waitFor(() => expect(spy.mock.calls.some(call => String(sentFilter(call)) === '501')).toBe(true))
    await toggleFilters()
    await choose('Group', 'X')  // the given list, now with its values: still [501]
    await choose('Site', 'South')
    await screen.findByText(NOTICE)
    expect(spy.mock.calls.some(call => sentFilter(call) === undefined)).toBe(false)
  })

  it('every door that would carry the figures waits, describes itself by the notice, and refuses its click', async () => {
    renderPage('&docs=201')
    await toggleFilters()
    await choose('Group', 'X')
    await choose('Site', 'South')
    const notice = await screen.findByText(NOTICE)
    expect(notice.id).not.toBe('')

    fireEvent.click(screen.getByRole('button', { name: 'Exports' }))
    const doors = [
      screen.getByRole('button', { name: /^Export CSV/ }),
      screen.getByRole('button', { name: /^Add to Materials/ }),
      screen.getByRole('button', { name: 'Frequencies CSV' }),
      screen.getByRole('button', { name: 'Segments CSV' }),
      screen.getByRole('button', { name: 'Co-occurrence CSV' }),
      screen.getByRole('button', { name: 'Source Data CSV' }),
      screen.getByRole('button', { name: 'Comparison CSV' }),
    ]
    for (const door of doors) {
      expect(door).toHaveAttribute('aria-disabled', 'true')
      expect(door).not.toBeDisabled()  // focusable: the tab stop is the disclosure (#754)
      expect(door).toHaveAttribute('aria-describedby', notice.id)
      fireEvent.click(door)
    }
    expect(exportCodeFrequenciesCsv).not.toHaveBeenCalled()
    expect(codedSegments).not.toHaveBeenCalled()
    expect(codeCooccurrence).not.toHaveBeenCalled()
    expect(sourceFrequenciesCsv).not.toHaveBeenCalled()
    expect(demographicComparisonCsv).not.toHaveBeenCalled()
    expect(createMaterial).not.toHaveBeenCalled()
  })

  it('Clear all ends it: the counts are asked again, with no filter', async () => {
    renderPage()
    await toggleFilters()
    await choose('Group', 'X')
    await choose('Site', 'South')
    await screen.findByText(NOTICE)

    fireEvent.click(screen.getByRole('button', { name: /Clear all/ }))
    await waitFor(() => expect(screen.queryByText(NOTICE)).not.toBeInTheDocument())
    await waitFor(() => expect(frequencies).toHaveBeenCalled())
    expect(lastSent()).toBeUndefined()
    expect(screen.getByTestId('participant-filter-nobody')).toBeEmptyDOMElement()
  })

  it('a positive control: the doors are live again once someone matches', async () => {
    renderPage('&docs=201')
    await toggleFilters()
    await choose('Group', 'X')
    await waitFor(() => expect(pids()).toBe('501'))
    fireEvent.click(screen.getByRole('button', { name: 'Exports' }))
    const segments = screen.getByRole('button', { name: 'Segments CSV' })
    expect(segments).not.toHaveAttribute('aria-disabled')
    fireEvent.click(segments)
    await waitFor(() => expect(codedSegments).toHaveBeenCalledTimes(1))
  })
})
