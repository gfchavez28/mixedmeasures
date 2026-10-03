/**
 * #1030 — the analysis page offers the Model comparison tab to a LONE researcher
 * whose project a model has coded, and asks THIS project's coverage — never the
 * install-wide roster — whether one has (#1038 g).
 *
 * The mount on the page is pinned here rather than inferred from the predicate's
 * unit test: #624 and row 49 each shipped a surface reachable from nowhere while
 * its own tests stayed green.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import { TooltipProvider } from '@/components/ui/tooltip'

const listCoders = vi.fn()
const coderCoverage = vi.fn()
const machineAgreement = vi.fn()

const CODE = {
  id: 7, project_id: 1, numeric_id: 2, name: 'Pacing', description: null, color: null,
  is_universal: false, is_active: true, created_at: '', updated_at: '',
  usage_count: 0, category_id: null, category_name: null, category_color: null, category_order: null,
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  const never = () => new Promise(() => {})
  return {
    ...actual,
    // One active code: with no code and no conversation the page is its import empty state.
    codesApi: { ...actual.codesApi, list: () => Promise.resolve({ codes: [CODE], total: 1 }) },
    categoriesApi: { ...actual.categoriesApi, list: () => Promise.resolve({ categories: [] }) },
    conversationsApi: { ...actual.conversationsApi, list: () => Promise.resolve({ conversations: [], total: 0 }) },
    documentsApi: { ...actual.documentsApi, list: () => Promise.resolve([]) },
    observationsApi: { ...actual.observationsApi, list: () => Promise.resolve([]) },
    materialsApi: { ...actual.materialsApi, list: () => Promise.resolve({ collections: [] }) },
    authApi: { ...actual.authApi, listCoders: (...a: unknown[]) => listCoders(...a) },
    excerptsApi: { ...actual.excerptsApi, listQuoted: never },
    codeAnalysisApi: {
      ...actual.codeAnalysisApi,
      frequencies: () => Promise.resolve({ frequencies: [], total_coded_segments: 0, total_coded_texts: 0 }),
      textColumnsWithCoding: () => Promise.resolve([]),
      demographicFilters: () => Promise.resolve({ filters: [] }),
      consensusStatus: () => Promise.resolve({ exists: false, stale_count: 0 }),
      coderCoverage: (...a: unknown[]) => coderCoverage(...a),
      machineAgreement: (...a: unknown[]) => machineAgreement(...a),
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

const ALICE = { id: 1, username: 'Alice', display_color: null, archived: false }
const MODEL = { id: 9, username: 'GPT-4o', display_color: null, archived: false, coder_type: 'ai' }
const covItem = (c: typeof ALICE & { coder_type?: string }) =>
  ({ user_id: c.id, username: c.username, display_color: null, archived: c.archived, coder_type: c.coder_type ?? 'human' })

function renderPage(tab = 'content') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
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
  listCoders.mockResolvedValue([ALICE, MODEL])
  machineAgreement.mockResolvedValue({ available: false, unavailable_reason: 'no_shared_source', pairs: [] })
})

afterEach(cleanup)

describe('#1030 — the Model comparison tab', () => {
  it('is offered to ONE person when a model has coded this project — and no Reliability tab is', async () => {
    coderCoverage.mockResolvedValue({ coders: [covItem(ALICE), covItem(MODEL)], count: 2 })
    renderPage()
    expect(await screen.findByRole('tab', { name: 'Model comparison' })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Reliability' })).not.toBeInTheDocument()
  })

  it('is NOT offered when the only model on the install coded another project (#1038 g)', async () => {
    // The roster names a machine (install-wide); this project's coverage does not.
    coderCoverage.mockResolvedValue({ coders: [covItem(ALICE)], count: 1 })
    renderPage()
    expect(await screen.findByRole('tab', { name: 'Content' })).toBeInTheDocument()
    await waitFor(() => expect(coderCoverage).toHaveBeenCalled())
    // Give coverage its answer before asserting the absence.
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'Model comparison' })).not.toBeInTheDocument())
  })

  it('is NOT offered for an ARCHIVED model — the comparison leaves it out', async () => {
    coderCoverage.mockResolvedValue({
      coders: [covItem(ALICE), { ...covItem(MODEL), archived: true }], count: 2,
    })
    renderPage()
    expect(await screen.findByRole('tab', { name: 'Content' })).toBeInTheDocument()
    await waitFor(() => expect(coderCoverage).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'Model comparison' })).not.toBeInTheDocument())
  })

  it('a deep link renders the comparison full width, compared for every person', async () => {
    coderCoverage.mockResolvedValue({ coders: [covItem(ALICE), covItem(MODEL)], count: 2 })
    renderPage('models')
    expect(await screen.findByRole('heading', { name: 'Model comparison' })).toBeInTheDocument()
    await waitFor(() => expect(machineAgreement).toHaveBeenCalledWith(1, null))
    expect(screen.getByRole('tab', { name: 'Model comparison' })).toHaveAttribute('aria-selected', 'true')
  })
})
