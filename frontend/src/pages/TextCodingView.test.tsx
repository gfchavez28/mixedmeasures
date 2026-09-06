/**
 * TextCodingView — the rating strip on the TEXT-CODING surface (#868 d), the
 * `r` verb, the row menu's Rate item, and the undo that carries a rating.
 *
 * Until 2026-09-03 this was the one coding surface with no rating door at all:
 * the only PATCH was segment-keyed, and its chips were handed neither the
 * rating nor the scale, so a rating that arrived by merge or import rendered
 * as nothing. These pin the same contract the document and observation
 * harnesses pin, against THIS page's cache — an INFINITE query (#844):
 *
 *   · applying a scaled code by digit opens the strip BELOW the grid and
 *     outside the virtualiser (#826); a digit typed into it rates through the
 *     text-coding `setMagnitude` WITHOUT applying a second code (#870 a);
 *   · `r` re-opens it for an application that already exists, seeded at the
 *     current value — a ZERO (the falsy-zero fixture rule);
 *   · the row menu names each ratable code and offers nothing otherwise;
 *   · the chips render the rating the payload carries;
 *   · removing a rated code then Ctrl+Z re-applies WITH the rating.
 *
 * Harness mirrors `DocumentCodingWorkbench.test.tsx`: the API namespace is
 * mocked at `@/lib/api`, the layout and auth contexts are stubbed, Virtuoso
 * renders every row under `VirtuosoMockContext`. This page reads `projectId`
 * from the ROUTE, so the router carries it.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import { VirtuosoMockContext } from 'react-virtuoso'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Code, TextCodingListResponse, TextCodingResponse } from '@/lib/api'

const columns = vi.fn()
const getConfig = vi.fn()
const list = vi.fn()
const progress = vi.fn()
const listNotes = vi.fn()
const applyCode = vi.fn()
const removeCode = vi.fn()
const bulkCode = vi.fn()
const bulkRemoveCode = vi.fn()
const setMagnitude = vi.fn()
const updateConfig = vi.fn()
const listCodes = vi.fn()
const listCategories = vi.fn()
const listCoders = vi.fn()
const coderCoverage = vi.fn()
const listMemos = vi.fn()

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    textCodingApi: {
      ...actual.textCodingApi,
      columns: (...a: unknown[]) => columns(...a),
      getConfig: (...a: unknown[]) => getConfig(...a),
      list: (...a: unknown[]) => list(...a),
      progress: (...a: unknown[]) => progress(...a),
      listNotes: (...a: unknown[]) => listNotes(...a),
      applyCode: (...a: unknown[]) => applyCode(...a),
      removeCode: (...a: unknown[]) => removeCode(...a),
      bulkCode: (...a: unknown[]) => bulkCode(...a),
      bulkRemoveCode: (...a: unknown[]) => bulkRemoveCode(...a),
      setMagnitude: (...a: unknown[]) => setMagnitude(...a),
      updateConfig: (...a: unknown[]) => updateConfig(...a),
    },
    codesApi: { ...actual.codesApi, list: (...a: unknown[]) => listCodes(...a) },
    categoriesApi: { ...actual.categoriesApi, list: (...a: unknown[]) => listCategories(...a) },
    authApi: { ...actual.authApi, listCoders: (...a: unknown[]) => listCoders(...a) },
    codeAnalysisApi: { ...actual.codeAnalysisApi, coderCoverage: (...a: unknown[]) => coderCoverage(...a) },
    memosApi: { ...actual.memosApi, list: (...a: unknown[]) => listMemos(...a) },
  }
})

vi.mock('@/layouts/ProjectLayout', () => ({
  useProjectLayout: () => ({ projectId: 1, openCodebook: vi.fn(), setBreadcrumbLabel: vi.fn() }),
}))

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 1, username: 'Alice' }, refreshAuth: vi.fn() }),
}))

import TextCodingView from './TextCodingView'

const text = (
  id: number, valueText: string, extra: Partial<TextCodingResponse> = {},
): TextCodingResponse => ({
  dataset_value_id: id, dataset_id: 1, dataset_name: 'Survey', dataset_row_id: id,
  row_identifier: `R${id}`, participant_id: null, participant_name: null,
  column_id: 10, column_name: 'Q7', column_text: 'Anything else?', column_sequence_order: 0,
  value_text: valueText, word_count: valueText.split(' ').length, is_quoted: false, excerpt_id: null,
  applied_code_ids: [], applied_code_details: [], note_count: 0,
  ...extra,
})

const PAGE: TextCodingListResponse = {
  texts: [
    text(101, 'The first response.'),
    // 🔴 Rated ZERO by this coder: the falsy-zero fixture rule. An undo that
    // re-applied bare and one that read `previous || null` both lose it.
    text(102, 'The second response.', {
      applied_code_ids: [7],
      applied_code_details: [{ code_id: 7, user_id: 1, attribution: null, is_universal: false,
                               magnitude: 0, magnitude_conflict: null }],
    }),
  ],
  total_texts: 2, non_empty_texts: 2, coded_texts: 1, total_rows: 2, coded_rows: 1, has_more: false,
}

const makeCode = (id: number, numericId: number, name: string, extra: Partial<Code> = {}): Code => ({
  id, project_id: 1, numeric_id: numericId, name, description: null, color: null,
  is_universal: false, is_active: true,
  created_at: '2026-09-03T00:00:00+00:00', updated_at: '2026-09-03T00:00:00+00:00',
  usage_count: 0, category_id: null, category_name: null, category_color: null, category_order: null,
  ...extra,
})
// Uncategorised → a plain digit resolves by numeric_id, no chord.
const CODES = [
  makeCode(7, 1, 'Engagement', { magnitude_scale: { min: 0, max: 10, step: 1, anchors: [] } }),
  makeCode(8, 2, 'Disruption'),
]

function renderView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <MemoryRouter initialEntries={['/projects/1/datasets/text-coding']}>
          <VirtuosoMockContext.Provider value={{ viewportHeight: 1000, itemHeight: 48 }}>
            <Routes>
              <Route path="/projects/:projectId/datasets/text-coding" element={<TextCodingView />} />
            </Routes>
          </VirtuosoMockContext.Provider>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  )
}

/**
 * ⚠️ Keydowns are dispatched on `document.body`, not `window`, unlike the two
 * workbench harnesses. `ByTextTable` and `ByRecordPanel` keep a private window
 * listener beside the shared hook, and it reads `e.target.closest(...)` — a
 * window-targeted synthetic event has no `closest` and throws as an uncaught
 * error that vitest counts even while every assertion passes. A real keydown
 * always targets an element (the focused one, else `<body>`), so body is the
 * honest target; it bubbles to the window listeners all the same.
 */

/** The grid row for one response — rows carry `id="text-<dvid>"` (#484). */
async function findRow(dvId: number): Promise<HTMLElement> {
  return waitFor(() => {
    const el = document.getElementById(`text-${dvId}`)
    if (!el) throw new Error(`row text-${dvId} not rendered yet`)
    return el
  })
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
  columns.mockResolvedValue({ columns: [{
    column_id: 10, dataset_id: 1, dataset_name: 'Survey', column_name: 'Q7', column_text: 'Anything else?',
    column_type: 'open_text', sequence_order: 0, total_rows: 2, non_empty_rows: 2, coded_rows: 1,
  }] })
  getConfig.mockResolvedValue({
    view_mode: 'by_text', focal_column_ids: [10], dataset_filter_ids: null, random_seed: null,
    context_visibility: {}, hide_empty: true, starred_value_ids: [],
    treat_as_empty: [], treat_as_empty_is_default: true,
  })
  list.mockResolvedValue(PAGE)
  progress.mockResolvedValue({ by_column: [], overall_texts: { coded: 1, total: 2 }, overall_records: { coded: 1, total: 2 } })
  listNotes.mockResolvedValue([])
  updateConfig.mockResolvedValue({})
  listCodes.mockResolvedValue({ codes: CODES, total: CODES.length })
  listCategories.mockResolvedValue({ categories: [] })
  listCoders.mockResolvedValue([{ id: 1, username: 'Alice', display_color: null, archived: false }])
  coderCoverage.mockResolvedValue({ coders: [], count: 0 })
  listMemos.mockResolvedValue({ memos: [], total: 0 })
  applyCode.mockResolvedValue({ dataset_value_id: 101, code_id: 7, applied: true })
  removeCode.mockResolvedValue({ status: 'ok' })
  bulkCode.mockResolvedValue({ results: [], success_count: 0, error_count: 0, failed_dataset_value_ids: [] })
  bulkRemoveCode.mockResolvedValue({ deleted_count: 0, code_id: 7 })
  setMagnitude.mockResolvedValue({ dataset_value_id: 101, code_id: 7, applied: true, magnitude: 7 })
})

afterEach(cleanup)

describe('the rating strip on the text-coding surface (#868 d)', () => {
  it('applying a scaled code by digit opens the strip below the grid, and a digit in it rates without coding', async () => {
    renderView()
    fireEvent.click(await findRow(101))  // uncoded
    fireEvent.keyDown(document.body, { key: '1' })  // numeric_id 1 → Engagement, which declares a scale

    await waitFor(() => expect(applyCode).toHaveBeenCalledWith(1, { dataset_value_id: 101, code_id: 7 }))
    const strip = await screen.findByTestId('magnitude-strip')

    // Outside the grid and after it: a conditional child inside a virtualised
    // row risks the remount that drops focus to <body> (#826).
    const grid = screen.getByRole('grid')
    expect(grid.contains(strip)).toBe(false)
    expect(strip.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()

    // It took focus — that is what stands the chord layer down.
    const group = screen.getByRole('radiogroup')
    expect(document.activeElement).toBe(group)

    // A digit typed INTO the strip is the rating, not a second code (#870 a),
    // and it goes to the TEXT-CODING endpoint with the cell as its target.
    fireEvent.keyDown(group, { key: '7' })
    await waitFor(() => expect(setMagnitude).toHaveBeenCalledWith(1, { dataset_value_id: 101, code_id: 7, magnitude: 7 }))
    expect(applyCode).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('magnitude-strip')).not.toBeInTheDocument()
  })

  it('`r` re-opens the strip for an application that already exists, seeded at its current rating — a ZERO', async () => {
    renderView()
    fireEvent.click(await findRow(102))  // Engagement rated 0 by this coder
    fireEvent.keyDown(document.body, { key: 'r' })

    await screen.findByTestId('magnitude-strip')
    expect(screen.getByRole('radio', { checked: true })).toHaveAccessibleName('0')
    expect(applyCode).not.toHaveBeenCalled()
    expect(removeCode).not.toHaveBeenCalled()
  })

  it('`r` falls through where there is nothing to rate, and a multi-response apply opens no strip', async () => {
    renderView()
    const first = await findRow(101)
    fireEvent.click(first)
    fireEvent.keyDown(document.body, { key: 'r' })
    expect(screen.queryByTestId('magnitude-strip')).not.toBeInTheDocument()

    fireEvent.click(await findRow(102), { shiftKey: true })  // range 101, 102
    fireEvent.keyDown(document.body, { key: '2' })  // Disruption on both → ONE bulk call
    await waitFor(() => expect(bulkCode).toHaveBeenCalledWith(1, { dataset_value_ids: [101, 102], code_id: 8 }))
    expect(screen.queryByTestId('magnitude-strip')).not.toBeInTheDocument()
  })

  it('the row menu names each ratable code, and offers nothing on a response with none', async () => {
    renderView()
    fireEvent.contextMenu(await findRow(102))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByText('Rate “Engagement”…')).toBeInTheDocument()
    fireEvent.keyDown(menu, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())

    fireEvent.contextMenu(await findRow(101))
    const menu2 = await screen.findByRole('menu')
    expect(within(menu2).queryByText(/^Rate /)).not.toBeInTheDocument()
  })

  it('the chip renders the rating the payload carries — a ZERO, never "not rated"', async () => {
    renderView()
    const row = await findRow(102)
    // The fact travels as sr-only TEXT beside the name (#753's split); the
    // meter is decorative. A chip handed no scale renders neither.
    await waitFor(() => expect(within(row).getByText(/0 out of 10/)).toBeInTheDocument())
    expect(within(row).queryByText(/not rated/)).not.toBeInTheDocument()
  })
})

describe('undo carries the rating (#868 f) — the text-coding surface', () => {
  it('removing a rated code then Ctrl+Z re-applies WITH the previous rating — a ZERO', async () => {
    renderView()
    fireEvent.click(await findRow(102))
    fireEvent.keyDown(document.body, { key: '1' })  // toggle → remove
    await waitFor(() => expect(removeCode).toHaveBeenCalledWith(1, { dataset_value_id: 102, code_id: 7 }))
    // The undo affordance enables only once the entry is registered (tests/the internal design notes).
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled())

    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })

    // `magnitude: 0` in the body: the captured rating. Its absence is the old bug.
    await waitFor(() => expect(applyCode).toHaveBeenCalledWith(1, { dataset_value_id: 102, code_id: 7, magnitude: 0 }))
  })
})
