/**
 * #1535 (1.5.9, D111–D114) — the analysis page's *Exports › Segments CSV* door sends exactly the
 * request `codedSegmentsFileRequest` builds for the page's selection, and says when it cannot.
 *
 * The page's door used to pass its `filterParams` (shaped for `/frequencies`, #749), so one
 * selected document exported every coded passage. The function is held to the shared case table
 * (`lib/coded-segments-file.cases.json`) by `lib/coded-segments-file.test.ts`, and the table to the
 * server by `backend/tests/test_coded_segments_selection_1535.py`; this file closes the last link —
 * the PAGE hands the door that request, from its URL state. Harness: the model-tab test's.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import cases from '@/lib/coded-segments-file.cases.json'
import { SEGMENTS_FILE_ANSWERS_NOTE, SEGMENTS_FILE_NO_PASSAGE_REASON } from '@/lib/qual-comparison'

const codedSegments = vi.fn((..._a: unknown[]) => Promise.resolve())
const listCoders = vi.fn()

const CODE = {
  id: 601, project_id: 1, numeric_id: 2, name: 'A', description: null, color: null,
  is_universal: false, is_active: true, created_at: '', updated_at: '',
  usage_count: 0, category_id: null, category_name: null, category_color: null, category_order: null,
}

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
    materialsApi: { ...actual.materialsApi, list: () => Promise.resolve({ collections: [] }) },
    authApi: { ...actual.authApi, listCoders: (...a: unknown[]) => listCoders(...a) },
    excerptsApi: { ...actual.excerptsApi, listQuoted: never },
    exportApi: { ...actual.exportApi, codedSegments: (...a: unknown[]) => codedSegments(...a) },
    codeAnalysisApi: {
      ...actual.codeAnalysisApi,
      frequencies: () => Promise.resolve({ frequencies: [], total_coded_segments: 0, total_coded_texts: 0 }),
      textColumnsWithCoding: () => Promise.resolve([]),
      demographicFilters: () => Promise.resolve({ filters: [] }),
      consensusStatus: () => Promise.resolve({ exists: false, stale_count: 0 }),
      coderCoverage: () => Promise.resolve({ coders: [], count: 0 }),
      machineAgreement: never,
      sourceFrequencies: never,
      saturation: never,
    },
  }
})

vi.mock('@/layouts/ProjectLayout', () => ({
  useProjectLayout: () => ({ projectId: 1, openCodebook: vi.fn(), setBreadcrumbLabel: vi.fn() }),
}))
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 1, username: 'Alice' }, refreshAuth: vi.fn() }),
}))

import QualitativeAnalysisView from './QualitativeAnalysisView'

const CASE = Object.fromEntries(cases.cases.map(c => [c.name, c]))
const ALICE = { id: 1, username: 'Alice', display_color: null, archived: false }

function renderPage(query: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[`/projects/1/analysis/qualitative?tab=descriptives&${query}`]}>
          <Routes>
            <Route path="/projects/:projectId/analysis/qualitative" element={<QualitativeAnalysisView />} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  )
}

async function segmentsDoor(query: string) {
  renderPage(query)
  fireEvent.click(await screen.findByRole('button', { name: 'Exports' }))
  return screen.getByRole('button', { name: 'Segments CSV' })
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
})

afterEach(cleanup)

describe('#1535 — the page hands its Segments CSV door the selection', () => {
  it.each([
    // [case in the shared table, the page URL that makes that selection]
    ['d1_only', 'source=conversations&docs=201'],
    ['o1_only', 'source=conversations&obs=301'],
    ['c1_and_d1', 'source=conversations&convs=101&docs=201'],
    ['c1_code_a_only', 'source=conversations&convs=101&codes=601'],
    ['everything_participant_p2', 'source=conversations&convs=101,102&docs=201,202&obs=301&pids=502'],
    ['c1_interviewer_included', 'source=conversations&convs=101&excl=0'],
    ['nothing_selected_all', 'source=all'],
  ])('%s', async (name, query) => {
    const door = await segmentsDoor(query)
    expect(door).not.toHaveAttribute('aria-disabled')
    fireEvent.click(door)
    await waitFor(() => expect(codedSegments).toHaveBeenCalledTimes(1))
    expect(codedSegments).toHaveBeenCalledWith(1, CASE[name].file!.query)
  })

  it('carries the page\'s EFFECTIVE coder scope beside the selection — blind mode\'s, here (#499, #1530 D98)', async () => {
    // A second coder on the roster: blind mode withholds, so the page counts the viewer's own
    // coding and its file must too.
    listCoders.mockResolvedValue([ALICE, { id: 9002, username: 'Bea', display_color: null, archived: false }])
    const door = await segmentsDoor('source=conversations&convs=101&docs=201')
    fireEvent.click(door)
    await waitFor(() => expect(codedSegments).toHaveBeenCalledTimes(1))
    expect(codedSegments).toHaveBeenCalledWith(1, { ...CASE.c1_and_d1.file!.query, coder_ids: '1' })
  })
})

describe('#1535 D114 — the door says what the file cannot hold', () => {
  it('under the Text source it is aria-disabled, says why, and sends nothing', async () => {
    expect(CASE.nothing_selected_text.file).toBeNull()
    const door = await segmentsDoor('source=text')
    expect(door).toHaveAttribute('aria-disabled', 'true')
    expect(door).toHaveAccessibleDescription(SEGMENTS_FILE_NO_PASSAGE_REASON)
    expect(screen.getByText(SEGMENTS_FILE_NO_PASSAGE_REASON)).toBeInTheDocument()
    fireEvent.click(door)
    fireEvent.keyDown(door, { key: 'Enter' })
    expect(codedSegments).not.toHaveBeenCalled()
  })

  it('with questions alone selected it is aria-disabled too', async () => {
    const door = await segmentsDoor('source=all&ccols=401')
    expect(door).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(door)
    expect(codedSegments).not.toHaveBeenCalled()
  })

  it('with questions beside passages it works and one line says the answers are left out', async () => {
    const door = await segmentsDoor('source=all&convs=101&ccols=401')
    expect(door).not.toHaveAttribute('aria-disabled')
    expect(door).toHaveAccessibleDescription(SEGMENTS_FILE_ANSWERS_NOTE)
    fireEvent.click(door)
    await waitFor(() => expect(codedSegments).toHaveBeenCalledWith(1, CASE.c1_beside_t1.file!.query))
  })

  it('says nothing when there is nothing to say', async () => {
    const door = await segmentsDoor('source=conversations&convs=101')
    expect(door).toHaveAccessibleDescription('')
    expect(screen.queryByText(SEGMENTS_FILE_ANSWERS_NOTE)).not.toBeInTheDocument()
    expect(screen.queryByText(SEGMENTS_FILE_NO_PASSAGE_REASON)).not.toBeInTheDocument()
  })
})
