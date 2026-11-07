/**
 * #1541 — the analysis page's *By Source* view, while blind, shows only the viewer's OWN chips:
 * an ARCHIVED colleague's too are hidden.
 *
 * The page passed `useBlindMode().blindLens`, which (once the roster answers) is a hide set of the
 * ACTIVE roster's colleagues — and `useCoders` leaves archived coders out (#451/#503 keep their
 * coding in the workbench GAUGES). So Carol, archived, who coded passage T3, showed her chip to a
 * blind Alice, while every other surface on the page (By Code's server scope, the files, the
 * Quote Board) left her out. This renders the PAGE — the fix is in its wiring, not in
 * `ContentBySource` (whose own blind test, `ContentBySource.blind-1531.test.tsx`, passes a lens).
 *
 * Alice (1) and Bob (2) are on the roster; Carol (3) is archived, so she is not.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, within, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import { TooltipProvider } from '@/components/ui/tooltip'

const listSegments = vi.fn()
const listCoders = vi.fn()

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  const never = () => new Promise(() => {})
  return {
    ...actual,
    codesApi: { ...actual.codesApi, list: () => Promise.resolve({ codes: CODES, total: CODES.length }) },
    categoriesApi: { ...actual.categoriesApi, list: () => Promise.resolve({ categories: [] }) },
    conversationsApi: {
      ...actual.conversationsApi,
      list: () => Promise.resolve({
        conversations: [{ id: 5, name: 'Interview 1', segment_count: 2, coded_count: 2 }], total: 1,
      }),
    },
    documentsApi: { ...actual.documentsApi, list: () => Promise.resolve([]) },
    observationsApi: { ...actual.observationsApi, list: () => Promise.resolve([]) },
    segmentsApi: { ...actual.segmentsApi, list: (...a: unknown[]) => listSegments(...a) },
    materialsApi: { ...actual.materialsApi, list: () => Promise.resolve({ collections: [] }) },
    authApi: { ...actual.authApi, listCoders: (...a: unknown[]) => listCoders(...a) },
    excerptsApi: { ...actual.excerptsApi, listQuoted: never },
    codeAnalysisApi: {
      ...actual.codeAnalysisApi,
      frequencies: () => Promise.resolve({
        frequencies: [{ code_id: 10, segment_count: 1, text_count: 0 }], total_coded_segments: 2, total_coded_texts: 0,
      }),
      textColumnsWithCoding: () => Promise.resolve([]),
      demographicFilters: () => Promise.resolve({ filters: [] }),
      consensusStatus: () => Promise.resolve({ exists: false, stale_count: 0 }),
      revealBlindMode: () => Promise.resolve(),
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

const ALICE = 1, BOB = 2, CAROL = 3
const code = (id: number, name: string) => ({
  id, project_id: 1, numeric_id: id, name, description: null, color: '#2563eb',
  is_universal: false, is_active: true, created_at: '', updated_at: '',
  usage_count: 1, category_id: null, category_name: null, category_color: null, category_order: null,
})
const CODES = [code(10, 'Alice theme'), code(11, 'Bob theme'), code(12, 'Carol theme')]
const details = (pairs: [number, number][]) => pairs.map(([code_id, user_id]) => ({
  code_id, user_id, attribution: null, is_universal: false, magnitude: null, magnitude_conflict: null,
}))

function renderBySource() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <MemoryRouter initialEntries={['/projects/1/analysis/qualitative?tab=content&contentMode=by-source&contentSrc=c:5']}>
          <Routes>
            <Route path="/projects/:projectId/analysis/qualitative" element={<QualitativeAnalysisView />} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  )
}

let store: Record<string, string> = {}
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
  listCoders.mockResolvedValue([
    { id: ALICE, username: 'Alice', display_color: null, archived: false },
    { id: BOB, username: 'Bob', display_color: null, archived: false },
  ])
  listSegments.mockResolvedValue({
    coded_count: 2,
    segments: [
      { id: 101, text: 'T one', speaker_name: 'Ana', is_facilitator: false, sequence_order: 1,
        applied_codes: [10, 11], applied_code_details: details([[10, ALICE], [11, BOB]]) },
      { id: 103, text: 'T three', speaker_name: 'Ana', is_facilitator: false, sequence_order: 3,
        applied_codes: [12], applied_code_details: details([[12, CAROL]]) },
    ],
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

/** A passage's row in the By Source reader (the code names also appear in the sidebar's code list). */
const row = (text: string) => {
  const el = screen.getByText(text).closest('div.items-start')
  if (!(el instanceof HTMLElement)) throw new Error(`no row for ${text}`)
  return within(el)
}

/*
 * On this door the page draws the reader TWICE. The coding counts are asked before the Content
 * tab's auto-select fills the empty source selection and again under it, and the tab body waits
 * on the counts, so the first reader is unmounted and drawn again — measured in jsdom on the code
 * before #1541's fix and after it. An element held from the first render can be detached by the
 * time it is asserted: CI run 42324614584 failed `toBeInTheDocument` on the 'T three' that
 * `findByText` had just returned. So each test asserts inside ONE `waitFor` callback, where every
 * query reads the same DOM, whichever render it is; the chips are the same in both, because the
 * lens does not depend on the source selection.
 */
describe('#1541 — By Source while blind shows the viewer’s own chips only', () => {
  it('an ARCHIVED colleague’s code is hidden, as the active colleague’s is', async () => {
    renderBySource()
    await waitFor(() => {
      // Positive control, in the same DOM as the negatives: both passages and the viewer's own chip.
      row('T three')
      expect(row('T one').getByText('Alice theme')).toBeInTheDocument()
      expect(row('T one').queryByText('Bob theme')).toBeNull()     // the active colleague (held before #1541)
      expect(row('T three').queryByText('Carol theme')).toBeNull() // the archived colleague (#1541)
    })
  })

  it('revealed: every coder’s chips show, the archived colleague’s included (the fixture can show Carol)', async () => {
    store[`mm-blind-revealed-1-${ALICE}`] = '1'
    renderBySource()
    await waitFor(() => {
      expect(row('T three').getByText('Carol theme')).toBeInTheDocument()
      expect(row('T one').getByText('Bob theme')).toBeInTheDocument()
      expect(row('T one').getByText('Alice theme')).toBeInTheDocument()
    })
  })
})
