/**
 * DocumentCodingWorkbench — the rating strip on the DOCUMENT surface (#868 b)
 * and the undo that carries a rating (#868 f).
 *
 * Until 2026-09-02 the document workbench could not rate at all: the strip was
 * mounted on the conversation workbench only, and this page's chips announced
 * "not rated" over ratings the payload never carried (#868 a). These pins:
 *
 *   · applying a scaled code by digit opens the strip BELOW the list — outside
 *     the listbox and outside the virtualiser (#826) — and a digit typed into
 *     the strip commits through `setMagnitude` WITHOUT applying a second code
 *     (the #870 a stand-down, exercised on a real page);
 *   · removing a rated code and undoing re-applies WITH the rating — and the
 *     fixture rates ZERO, so a fix that re-applied bare and one that dropped a
 *     falsy value fail the same way.
 *
 * Harness mirrors `ObservationWorkbench.test.tsx`: the API namespace is mocked
 * at `@/lib/api`, the layout and auth contexts are stubbed, Virtuoso renders
 * every row under `VirtuosoMockContext`.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import { VirtuosoMockContext } from 'react-virtuoso'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Code, DocumentDetailResponse, DocumentSegmentResponse } from '@/lib/api'

const getDetail = vi.fn()
const listDocuments = vi.fn()
const listNotes = vi.fn()
const listCodes = vi.fn()
const listCategories = vi.fn()
const listCoders = vi.fn()
const listExcerpts = vi.fn()
const coderCoverage = vi.fn()
const applyCode = vi.fn()
const removeCode = vi.fn()
const bulkCode = vi.fn()
const setMagnitude = vi.fn()

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    documentsApi: {
      ...actual.documentsApi,
      getDetail: (...a: unknown[]) => getDetail(...a),
      list: (...a: unknown[]) => listDocuments(...a),
      listNotes: (...a: unknown[]) => listNotes(...a),
    },
    codesApi: { ...actual.codesApi, list: (...a: unknown[]) => listCodes(...a) },
    categoriesApi: { ...actual.categoriesApi, list: (...a: unknown[]) => listCategories(...a) },
    authApi: { ...actual.authApi, listCoders: (...a: unknown[]) => listCoders(...a) },
    excerptsApi: { ...actual.excerptsApi, list: (...a: unknown[]) => listExcerpts(...a) },
    codeAnalysisApi: { ...actual.codeAnalysisApi, coderCoverage: (...a: unknown[]) => coderCoverage(...a) },
    codingApi: {
      ...actual.codingApi,
      applyCode: (...a: unknown[]) => applyCode(...a),
      removeCode: (...a: unknown[]) => removeCode(...a),
      bulkCode: (...a: unknown[]) => bulkCode(...a),
      setMagnitude: (...a: unknown[]) => setMagnitude(...a),
    },
  }
})

vi.mock('@/layouts/ProjectLayout', () => ({
  useProjectLayout: () => ({ projectId: 1, setBreadcrumbLabel: vi.fn(), openCodebook: vi.fn() }),
}))

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 1, username: 'Alice' }, refreshAuth: vi.fn() }),
}))

import DocumentCodingWorkbench from './DocumentCodingWorkbench'

const segment = (
  id: number, order: number, text: string, extra: Partial<DocumentSegmentResponse> = {},
): DocumentSegmentResponse => ({
  id, sequence_order: order, text, word_count: text.split(' ').length,
  page_number: null, heading_level: null, codes: [], has_note: false,
  attached_notes: [], excerpt_info: null,
  merged_into_id: null, is_merge_result: 0, split_into_id: null, is_split_result: 0,
  ...extra,
})

const DOC: DocumentDetailResponse = {
  id: 5, name: 'Field notes', description: null, summary: null,
  source_format: 'docx', segmentation_mode: 'paragraph',
  segment_count: 2, coded_segment_count: 1, page_count: null,
  created_at: '2026-09-02T00:00:00+00:00', updated_at: '2026-09-02T00:00:00+00:00',
  segments: [
    segment(51, 0, 'The first paragraph of the field notes.'),
    // 🔴 Rated ZERO: the falsy-zero fixture rule. An undo that re-applied bare
    // and one that read `previous || null` both lose exactly this value.
    segment(52, 1, 'The second paragraph.', {
      codes: [{ id: 7, name: 'Engagement', color: null, is_universal: false, user_id: 1,
                magnitude: 0, magnitude_conflict: null }],
    }),
  ],
  image_positions: [],
}

const makeCode = (id: number, numericId: number, name: string, extra: Partial<Code> = {}): Code => ({
  id, project_id: 1, numeric_id: numericId, name, description: null, color: null,
  is_universal: false, is_active: true,
  created_at: '2026-09-02T00:00:00+00:00', updated_at: '2026-09-02T00:00:00+00:00',
  usage_count: 0, category_id: null, category_name: null, category_color: null, category_order: null,
  ...extra,
})
// Uncategorised → a plain digit resolves by numeric_id, no chord.
const CODES = [
  makeCode(7, 1, 'Engagement', { magnitude_scale: { min: 0, max: 10, step: 1, anchors: [] } }),
  makeCode(8, 2, 'Disruption'),
]

function renderWorkbench() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <MemoryRouter initialEntries={['/docs/5']}>
          <VirtuosoMockContext.Provider value={{ viewportHeight: 1000, itemHeight: 48 }}>
            <Routes>
              <Route path="/docs/:documentId" element={<DocumentCodingWorkbench />} />
            </Routes>
          </VirtuosoMockContext.Provider>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  )
}

let store: Record<string, string> = {}

beforeEach(() => {
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
  getDetail.mockResolvedValue(DOC)
  listDocuments.mockResolvedValue([])
  listNotes.mockResolvedValue([])
  listCodes.mockResolvedValue({ codes: CODES, total: CODES.length })
  listCategories.mockResolvedValue({ categories: [] })
  listCoders.mockResolvedValue([{ id: 1, username: 'Alice', display_color: null, archived: false }])
  listExcerpts.mockResolvedValue({ excerpts: [], total: 0 })
  coderCoverage.mockResolvedValue({ coders: [], count: 0 })
  applyCode.mockResolvedValue({ applied: true })
  removeCode.mockResolvedValue({ applied: false })
  bulkCode.mockResolvedValue({ success_count: 0, error_count: 0, failed_segment_ids: [] })
  setMagnitude.mockResolvedValue({ applied: true, magnitude: 7 })
})

afterEach(cleanup)

describe('the rating strip on the document workbench (#868 b)', () => {
  it('applying a scaled code by digit opens the strip below the list, and a digit in it rates without coding', async () => {
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    // The row selects on mousedown (button 0), not click — see DocumentSegmentRow.
    fireEvent.mouseDown(rows[0], { button: 0 })  // segment 51, uncoded
    fireEvent.keyDown(window, { key: '1' })  // numeric_id 1 → Engagement, which declares a scale

    await waitFor(() => expect(applyCode).toHaveBeenCalledWith(51, 7))
    const strip = await screen.findByTestId('magnitude-strip')

    // Outside the listbox and outside the scroller: a conditional child inside a
    // virtualised row risks the remount that drops focus to <body> (#826).
    const listbox = screen.getByRole('listbox')
    expect(listbox.contains(strip)).toBe(false)
    expect(strip.compareDocumentPosition(listbox) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()

    // It took focus — that is what stands the chord layer down.
    const group = screen.getByRole('radiogroup')
    expect(document.activeElement).toBe(group)

    // A digit typed INTO the strip is the rating, not a second code (#870 a).
    fireEvent.keyDown(group, { key: '7' })
    await waitFor(() => expect(setMagnitude).toHaveBeenCalledWith(51, 7, 7))
    expect(applyCode).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('magnitude-strip')).not.toBeInTheDocument()
  })

  it('removing a code does not open the strip, and applying to a multi-selection does not either', async () => {
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    fireEvent.mouseDown(rows[1], { button: 0 })  // segment 52 already carries Engagement
    fireEvent.keyDown(window, { key: '1' })  // toggle → remove
    await waitFor(() => expect(removeCode).toHaveBeenCalledWith(52, 7))
    expect(screen.queryByTestId('magnitude-strip')).not.toBeInTheDocument()
  })
})

describe('undo carries the rating (#868 f)', () => {
  it('removing a rated code then Ctrl+Z re-applies WITH the previous rating — a ZERO', async () => {
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    fireEvent.mouseDown(rows[1], { button: 0 })  // segment 52: Engagement rated 0 by this coder
    fireEvent.keyDown(window, { key: '1' })
    await waitFor(() => expect(removeCode).toHaveBeenCalledWith(52, 7))
    // The undo affordance enables only once the entry is registered (tests/the internal design notes).
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled())

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })

    // Fourth argument: the captured rating. `undefined` there is the old bug.
    await waitFor(() => expect(applyCode).toHaveBeenCalledWith(52, 7, undefined, 0))
  })
})
