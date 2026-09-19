/**
 * #961 — Qualitative Analysis does not say "nothing has been coded" before it
 * has counted.
 *
 * Measured on a large survey (production build): every tab read "No segments or
 * text has been coded yet." for ~5.7 s, because `hasCoding` was read off the
 * code-frequency count while that count was still undefined — and the same
 * sentence came back on every filter, source or blind-mode change, each a new
 * query key. A FAILED count made the claim for good; a failed codes or
 * conversations list sent the researcher to import conversations they had.
 *
 * The first harness to render this page. It stubs the API namespace and the two
 * contexts; every tab body is left unrendered by keeping the count unanswered,
 * failed, or answered-with-no-coding — the three states this entry is about.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ApiError } from '@/lib/api/client'

const listCodes = vi.fn()
const listConversations = vi.fn()
const frequencies = vi.fn()
const listDocuments = vi.fn()
const listObservations = vi.fn()
const textColumnsWithCoding = vi.fn()
const listCoders = vi.fn()

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  const never = () => new Promise(() => {})
  return {
    ...actual,
    codesApi: { ...actual.codesApi, list: (...a: unknown[]) => listCodes(...a) },
    categoriesApi: { ...actual.categoriesApi, list: () => Promise.resolve({ categories: [] }) },
    conversationsApi: { ...actual.conversationsApi, list: (...a: unknown[]) => listConversations(...a) },
    documentsApi: { ...actual.documentsApi, list: (...a: unknown[]) => listDocuments(...a) },
    observationsApi: { ...actual.observationsApi, list: (...a: unknown[]) => listObservations(...a) },
    materialsApi: { ...actual.materialsApi, list: () => Promise.resolve({ collections: [] }) },
    authApi: { ...actual.authApi, listCoders: (...a: unknown[]) => listCoders(...a) },
    excerptsApi: { ...actual.excerptsApi, listQuoted: never },
    codeAnalysisApi: {
      ...actual.codeAnalysisApi,
      frequencies: (...a: unknown[]) => frequencies(...a),
      textColumnsWithCoding: (...a: unknown[]) => textColumnsWithCoding(...a),
      demographicFilters: () => Promise.resolve({ filters: [] }),
      consensusStatus: () => Promise.resolve({ exists: false, stale_count: 0 }),
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

const CODE = {
  id: 7, project_id: 1, numeric_id: 2, name: 'Pacing', description: null, color: null,
  is_universal: false, is_active: true, created_at: '', updated_at: '',
  usage_count: 0, category_id: null, category_name: null, category_color: null, category_order: null,
}
const NO_CODING = { frequencies: [], total_coded_segments: 0, total_coded_texts: 0 }
const ALICE = { id: 1, username: 'Alice', display_color: null, archived: false }
const BOB = { id: 2, username: 'Bob', display_color: null, archived: false }
const SERVER_ERROR = () => new ApiError(500, { detail: 'Internal Server Error' }, {})

/** `retry` mirrors `main.tsx`'s client default when a test is about the retry
 * policy; `retryDelay: 0` so the automatic second ask, if any, happens at once. */
function renderPage({ clientRetry = false as boolean | number, tab = 'descriptives' } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: clientRetry, retryDelay: 0 } } })
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[`/projects/1/analysis/qualitative?tab=${tab}`]}>
          <Routes>
            <Route path="/projects/:projectId/analysis/qualitative" element={<QualitativeAnalysisView />} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  )
}

let store: Record<string, string> = {}

// react-resizable-panels constructs a ResizeObserver; jsdom has none.
class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver)
  store = {}
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => { store[k] = String(v) },
      removeItem: (k: string) => { delete store[k] },
      clear: () => { store = {} },
    },
  })
  vi.clearAllMocks()
  listCodes.mockResolvedValue({ codes: [CODE], total: 1 })
  listConversations.mockResolvedValue({ conversations: [], total: 0 })
  listDocuments.mockResolvedValue([])
  listObservations.mockResolvedValue([])
  textColumnsWithCoding.mockResolvedValue([])
  frequencies.mockResolvedValue(NO_CODING)
  listCoders.mockResolvedValue([ALICE])
})

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('#961 — Qualitative Analysis waits for the count before claiming anything', () => {
  it('a count still being taken says so — never "No segments or text has been coded yet."', async () => {
    frequencies.mockReturnValue(new Promise(() => {}))
    renderPage()
    expect(await screen.findByText('Counting coded segments and texts…')).toBeInTheDocument()
    expect(screen.queryByText(/has been coded yet/)).not.toBeInTheDocument()
  })

  it('a FAILED count says the count failed; Retry asks again and lands focus on the tab', async () => {
    frequencies.mockRejectedValueOnce(SERVER_ERROR())
    // The app's own client default (`retry: 1`), so the page's `retryUnanswered`
    // is what decides — a count the server ANSWERED is not asked again on its own.
    renderPage({ clientRetry: 1 })

    expect(await screen.findByText('The coding counts could not be loaded.')).toBeInTheDocument()
    expect(screen.queryByText(/has been coded yet/)).not.toBeInTheDocument()
    expect(frequencies).toHaveBeenCalledTimes(1)

    const retry = screen.getByRole('button', { name: 'Retry' })
    retry.focus()
    fireEvent.click(retry)
    // The retry answers with no coding: now, and only now, the claim is true.
    expect(await screen.findByText('No segments or text has been coded yet.')).toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Descriptives' })))
  })

  it('a FAILED codes list says the load failed — not "No conversations or coded text yet."', async () => {
    listCodes.mockRejectedValue(SERVER_ERROR())
    renderPage()
    expect(await screen.findByText('This project’s codes, sources or coders could not be loaded.')).toBeInTheDocument()
    expect(screen.queryByText('No conversations or coded text yet.')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Import Conversations' })).not.toBeInTheDocument()
  })

  it('the Sources count waits for all four source lists rather than reading low', async () => {
    let answer!: (v: unknown) => void
    listDocuments.mockReturnValue(new Promise(r => { answer = r }))
    renderPage()
    const sources = await screen.findByRole('button', { name: /^Sources/ })
    expect(sources).toHaveTextContent(/^Sources$/)

    answer([{ id: 3, name: 'Guide' }])
    await waitFor(() => expect(screen.getByRole('button', { name: /^Sources/ })).toHaveTextContent('Sources1'))
  })
})

/** The `coder_ids` each frequency request was scoped to (undefined = all coders). */
const frequencyScopes = () => frequencies.mock.calls.map(c => (c[1] as { coder_ids?: string }).coder_ids)

describe('#964 — the page does not fetch or render under a coder scope it has not settled', () => {
  it('while the roster is unanswered the page waits, and NO coding count is requested', async () => {
    listCoders.mockReturnValue(new Promise(() => {}))
    renderPage()
    expect(await screen.findByText('Loading codes, sources and coders…')).toBeInTheDocument()
    // Give every other list time to answer; the count must still not be asked for.
    await waitFor(() => expect(listDocuments).toHaveBeenCalled())
    await new Promise(r => setTimeout(r, 50))
    expect(frequencies).not.toHaveBeenCalled()
  })

  it('a multi-coder roster that answers late: the count is only ever asked for MY coding', async () => {
    let answer!: (v: unknown) => void
    listCoders.mockReturnValue(new Promise(r => { answer = r }))
    renderPage()
    await screen.findByText('Loading codes, sources and coders…')
    answer([ALICE, BOB])
    expect(await screen.findByText('No coding visible to you matches this selection yet.')).toBeInTheDocument()
    // Before #964 the first request went out all-coder while the roster loaded.
    expect(frequencyScopes()).toEqual(['1'])
  })

  it('a single-coder roster that answers late: ONE all-coder count, not a self-scoped one first', async () => {
    let answer!: (v: unknown) => void
    listCoders.mockReturnValue(new Promise(r => { answer = r }))
    renderPage()
    await screen.findByText('Loading codes, sources and coders…')
    answer([ALICE])
    expect(await screen.findByText('No segments or text has been coded yet.')).toBeInTheDocument()
    expect(frequencyScopes()).toEqual([undefined])
  })

  it('a FAILED roster says so, rather than rendering tabs whose blind scope is unknown', async () => {
    listCoders.mockRejectedValue(SERVER_ERROR())
    renderPage()
    expect(await screen.findByText('This project’s codes, sources or coders could not be loaded.')).toBeInTheDocument()
    expect(frequencies).not.toHaveBeenCalled()
  })
})

/**
 * #963 Tier 2 — the sidebar's source tree and the Content tab rest on FOUR
 * lists, and the page gate above them waits for only one of the four.
 *
 * `pageLoad` covers codes, conversations and the coder roster; text columns,
 * documents and observations are still in flight when the tree first paints, so
 * it said *"No sources available."* over three outstanding requests — and, once
 * any of them had failed, said it for the life of the page.
 */
describe('#963 — the source tree waits for all four lists before calling itself empty', () => {
  /** The Sources section is collapsed on arrival, so the tree is not mounted
   *  until it is opened — a fixture that does not render an arm cannot measure
   *  it (#961's own lesson, in the harness rather than the component). */
  async function openSources() {
    fireEvent.click(await screen.findByRole('button', { name: /^Sources/ }))
  }

  it('READY with nothing in the project: the claim is true, and is made (positive control)', async () => {
    renderPage()
    await openSources()
    expect(await screen.findByText('No sources available.')).toBeInTheDocument()
  })

  it('LOADING one of the four: says it is loading, never "No sources available."', async () => {
    listObservations.mockReturnValue(new Promise(() => {}))
    renderPage()
    await openSources()

    expect(await screen.findByText('Loading sources…')).toBeInTheDocument()
    expect(screen.queryByText('No sources available.')).not.toBeInTheDocument()
  })

  it('a LATE fourth list flips the claim on only when it answers', async () => {
    let answer!: (v: unknown) => void
    listObservations.mockReturnValue(new Promise(r => { answer = r }))
    renderPage()
    await openSources()
    await screen.findByText('Loading sources…')

    answer([])
    expect(await screen.findByText('No sources available.')).toBeInTheDocument()
  })

  it('FAILED: says the LOAD failed and offers a Retry', async () => {
    listObservations.mockRejectedValue(SERVER_ERROR())
    renderPage()
    await openSources()

    expect(await screen.findByText('Your sources could not be loaded')).toBeInTheDocument()
    expect(screen.queryByText('No sources available.')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Retry' }).length).toBeGreaterThan(0)
  })

  it('a failure in one list does not hide the sources that DID answer', async () => {
    // A failure notice is a statement about the request, never about the project:
    // the conversations already in hand stay on screen and stay selectable.
    listConversations.mockResolvedValue({
      conversations: [{ id: 1, name: 'Interview A', segment_count: 3, coded_count: 2 }], total: 1,
    })
    listObservations.mockRejectedValue(SERVER_ERROR())
    renderPage()
    await openSources()

    await screen.findByText('Your sources could not be loaded')
    expect(screen.getByText('Interview A')).toBeInTheDocument()
  })
})

/**
 * The Content tab reads the same four lists and blames the FILTERS for an empty
 * result — *"No sources available with current filters."* — which is a second
 * false statement on top of the first: the filters are not why.
 */
describe('#963 — the Content tab does not blame the filters for a list it has not got', () => {
  const CODED = { frequencies: [{ code_id: 7, count: 3 }], total_coded_segments: 3, total_coded_texts: 0 }

  /** The Content tab opens in "By Code"; the source list lives behind By Source. */
  async function openBySource() {
    fireEvent.click(await screen.findByRole('tab', { name: 'By Source' }))
  }

  it('READY with nothing in the project: the claim is made (positive control)', async () => {
    frequencies.mockResolvedValue(CODED)
    renderPage({ tab: 'content' })
    await openBySource()
    expect(await screen.findByText('No sources available with current filters.')).toBeInTheDocument()
  })

  it('LOADING one of the four: says it is loading, and blames nothing', async () => {
    frequencies.mockResolvedValue(CODED)
    listObservations.mockReturnValue(new Promise(() => {}))
    renderPage({ tab: 'content' })
    await openBySource()

    expect(await screen.findByText('Loading sources…')).toBeInTheDocument()
    expect(screen.queryByText('No sources available with current filters.')).not.toBeInTheDocument()
  })

  it('FAILED: says the LOAD failed', async () => {
    frequencies.mockResolvedValue(CODED)
    listObservations.mockRejectedValue(SERVER_ERROR())
    renderPage({ tab: 'content' })
    await openBySource()

    expect(await screen.findByText('Your sources could not be loaded')).toBeInTheDocument()
    expect(screen.queryByText('No sources available with current filters.')).not.toBeInTheDocument()
  })
})
