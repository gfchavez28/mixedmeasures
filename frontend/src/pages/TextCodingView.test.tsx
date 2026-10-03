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
import { ApiError } from '@/lib/api/client'

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

/** `retry` mirrors `main.tsx`'s client default when a test is about the retry
 * policy; `retryDelay: 0` so the automatic second ask, if any, happens at once. */
function renderView({ clientRetry = false as boolean | number } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: clientRetry, retryDelay: 0 } } })
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

/**
 * #956 — the header's multi-coder controls do not depend on the progress count.
 *
 * Measured on a 965,917-value survey: selecting nine open-text columns makes
 * `coding-progress` 500 (SQLite's variable ceiling). The gauges, the blind
 * toggle AND the coder badge all rendered inside `progressData &&`, so the
 * whole group vanished — including the page's only statement that colleagues
 * were hidden. The three sibling workbenches never gated either control on data.
 */
describe('#956 — the header survives a progress count that fails or is still loading', () => {
  const TWO_CODERS = [
    { id: 1, username: 'Alice', display_color: null, archived: false },
    { id: 2, username: 'Bob', display_color: null, archived: false },
  ]

  it('a failed count says progress is unavailable, and the blind toggle stays', async () => {
    listCoders.mockResolvedValue(TWO_CODERS)
    progress.mockRejectedValue(new ApiError(500, { detail: 'Internal Server Error' }, {}))
    renderView()

    expect(await screen.findByText('Progress unavailable')).toBeInTheDocument()
    // Blind is the default with two coders; the toggle is its only statement.
    expect(await screen.findByRole('button', { name: /Colleagues hidden/ })).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(screen.queryByText('Texts:')).not.toBeInTheDocument()
  })

  it('a count that has not answered yet does not hide the toggle either', async () => {
    // The discriminating case: gating on the count having SETTLED (data or an
    // error) passes the test above and still unmounts the toggle on every key
    // change — including the Reveal press itself, because blind is part of the
    // count's query key.
    listCoders.mockResolvedValue(TWO_CODERS)
    progress.mockReturnValue(new Promise(() => {}))
    renderView()

    expect(await screen.findByRole('button', { name: /Colleagues hidden/ })).toBeInTheDocument()
    expect(screen.queryByText('Progress unavailable')).not.toBeInTheDocument()
  })

  it('a count that never got an answer is asked once more on its own', async () => {
    // Pins the query's `retry` wiring — this harness's client default is
    // `retry: false`, so only the page's own option can produce the second call.
    // One coder, so the key does not move under the test.
    progress
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ by_column: [], overall_texts: { coded: 1, total: 2 }, overall_records: { coded: 1, total: 2 } })
    renderView()
    // React Query waits 1 s before its first retry.
    expect(await screen.findByRole('progressbar', { name: 'Texts coded: 50%' }, { timeout: 4000 })).toBeInTheDocument()
  })

  it('a successful count still renders both gauges beside the toggle', async () => {
    listCoders.mockResolvedValue(TWO_CODERS)
    renderView()

    expect(await screen.findByRole('progressbar', { name: 'Texts coded: 50%' })).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: 'Records coded: 50%' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Colleagues hidden/ })).toBeInTheDocument()
    expect(screen.queryByText('Progress unavailable')).not.toBeInTheDocument()
  })
})

/**
 * #964 — blind mode read an unanswered coder roster as a one-person roster, so a
 * colleague's chips rendered and the server gauge was fetched all-coder.
 */
describe('#964 — while the roster has not answered, colleagues stay hidden', () => {
  const TWO_CODERS = [
    { id: 1, username: 'Alice', display_color: null, archived: false },
    { id: 2, username: 'Bob', display_color: null, archived: false },
  ]
  // Response 101 carries ONLY a colleague's code; 102 carries mine.
  const WITH_COLLEAGUE: TextCodingListResponse = {
    ...PAGE,
    texts: [
      text(101, 'The first response.', {
        applied_code_ids: [8],
        applied_code_details: [{ code_id: 8, user_id: 2, attribution: null, is_universal: false,
                                 magnitude: null, magnitude_conflict: null }],
      }),
      PAGE.texts[1],
    ],
  }

  it.each([
    ['loading', () => listCoders.mockReturnValue(new Promise(() => {}))],
    ['failed', () => listCoders.mockRejectedValue(new Error('network'))],
  ] as const)('roster %s: my chip renders, the colleague\'s does not, and no gauge is fetched', async (_s, arrange) => {
    arrange()
    list.mockResolvedValue(WITH_COLLEAGUE)
    renderView()

    const mine = await findRow(102)
    await waitFor(() => expect(within(mine).getByText('Engagement')).toBeInTheDocument())
    expect(within(await findRow(101)).queryByText('Disruption')).not.toBeInTheDocument()
    // The server-counted gauge waits for a settled scope rather than guessing one.
    expect(progress).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /Colleagues/ })).not.toBeInTheDocument()
  })

  it.each([
    ['two coders', TWO_CODERS, 1],
    ['one coder', TWO_CODERS.slice(0, 1), undefined],
  ] as const)('a roster that answers late (%s) fetches the gauge ONCE, under the right scope', async (_s, roster, coderId) => {
    let answer!: (v: unknown) => void
    listCoders.mockReturnValue(new Promise(r => { answer = r }))
    renderView()
    await findRow(102)
    expect(progress).not.toHaveBeenCalled()

    answer(roster)
    await waitFor(() => expect(progress).toHaveBeenCalled())
    expect(progress).toHaveBeenCalledTimes(1)
    expect((progress.mock.calls[0][1] as { coder_id?: number }).coder_id).toBe(coderId)
  })

  // Found by #964's review: "View all — N archived" outlived re-blinding.
  it('re-blinding hides an archived colleague\'s chips even after "View all" was switched on', async () => {
    listCoders.mockResolvedValue(TWO_CODERS)
    coderCoverage.mockResolvedValue({
      coders: [{ user_id: 3, username: 'Carla', display_color: null, archived: true, coding_count: 1 }],
      count: 1,
    })
    list.mockResolvedValue({
      ...PAGE,
      texts: [
        text(101, 'The first response.', {
          applied_code_ids: [8],
          applied_code_details: [{ code_id: 8, user_id: 3, attribution: null, is_universal: false,
                                   magnitude: null, magnitude_conflict: null }],
        }),
        PAGE.texts[1],
      ],
    })
    store['mm-blind-revealed-1-1'] = '1'
    renderView()

    fireEvent.click(await screen.findByRole('button', { name: 'Filter codes by coder' }))
    fireEvent.click(await screen.findByRole('button', { name: /View all — 1 archived/ }))
    expect(await screen.findByText(/coded by Carla/)).toBeInTheDocument() // positive control

    fireEvent.click(screen.getByRole('button', { name: /Colleagues shown/ }))
    expect(await screen.findByRole('button', { name: /Colleagues hidden/ })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText(/coded by Carla/)).not.toBeInTheDocument())
  })
})

/**
 * #961 — nothing on this page claims a list is empty before the list answers.
 *
 * Measured on a large survey (production build): the page opened on "No text
 * columns found in this project." for ~3.4 s, and made the same claim for good
 * when the column list failed. Each case below forces one list to be slow or to
 * fail and asserts the page says THAT, never the empty claim; the "answered and
 * empty" cases are the positive controls that keep the true claims alive.
 */
describe('#961 — no "nothing here" before the lists answer', () => {
  const NO_SELECTION = {
    view_mode: 'by_text', focal_column_ids: [], dataset_filter_ids: null, random_seed: null,
    context_visibility: {}, hide_empty: true, starred_value_ids: [],
    treat_as_empty: [], treat_as_empty_is_default: true,
  }
  const SERVER_ERROR = () => new ApiError(500, { detail: 'Internal Server Error' }, {})

  it('a column list still loading says so — never "No text columns found"', async () => {
    getConfig.mockResolvedValue(NO_SELECTION)
    columns.mockReturnValue(new Promise(() => {}))
    renderView()
    expect(await screen.findByText('Loading text columns…')).toBeInTheDocument()
    expect(screen.queryByText('No text columns found in this project.')).not.toBeInTheDocument()
  })

  it('a FAILED column list says the load failed; Retry asks again and lands focus in the workspace', async () => {
    getConfig.mockResolvedValue(NO_SELECTION)
    columns.mockRejectedValueOnce(SERVER_ERROR())
    // The app's own client default (`retry: 1`), so the page's `retryUnanswered`
    // is what decides — a server that ANSWERED is not asked again on its own.
    renderView({ clientRetry: 1 })

    expect(await screen.findByText('The text columns could not be loaded.')).toBeInTheDocument()
    expect(screen.queryByText('No text columns found in this project.')).not.toBeInTheDocument()
    expect(columns).toHaveBeenCalledTimes(1)

    const retry = screen.getByRole('button', { name: 'Retry' })
    retry.focus()
    fireEvent.click(retry)
    expect(await screen.findByText('Select one or more text columns to begin coding.')).toBeInTheDocument()
    expect(columns).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Coding' })))
  })

  it('an ANSWERED empty column list still says so (positive control)', async () => {
    getConfig.mockResolvedValue(NO_SELECTION)
    columns.mockResolvedValue({ columns: [] })
    renderView()
    expect(await screen.findByText('No text columns found in this project.')).toBeInTheDocument()
  })

  it('a saved selection not restored yet is not "select a column"', async () => {
    getConfig.mockReturnValue(new Promise(() => {}))
    renderView()
    expect(await screen.findByText('Loading your column selection…')).toBeInTheDocument()
    expect(screen.queryByText('Select one or more text columns to begin coding.')).not.toBeInTheDocument()
  })

  it('the responded count waits for the column list rather than reading 0/0', async () => {
    let answer!: (v: unknown) => void
    columns.mockReturnValue(new Promise(r => { answer = r }))
    renderView()
    await findRow(101)  // the saved selection restored; the texts loaded in parallel
    expect(screen.queryByText(/responded/)).not.toBeInTheDocument()

    answer({ columns: [{
      column_id: 10, dataset_id: 1, dataset_name: 'Survey', column_name: 'Q7', column_text: 'Anything else?',
      column_type: 'open_text', sequence_order: 0, total_rows: 2, non_empty_rows: 2, coded_rows: 1,
    }] })
    expect(await screen.findByText('2/2 responded')).toBeInTheDocument()
  })

  it('a FAILED page of texts says the load failed — not "No texts found. Try adjusting your filters."', async () => {
    list.mockRejectedValue(SERVER_ERROR())
    renderView()
    expect(await screen.findByText('The texts could not be loaded.')).toBeInTheDocument()
    expect(screen.queryByText(/No texts found/)).not.toBeInTheDocument()
  })

  it('the code panel says codes are loading — not "No codes yet"', async () => {
    listCodes.mockReturnValue(new Promise(() => {}))
    renderView()
    await findRow(101)
    const panel = screen.getByRole('region', { name: 'Code panel' })
    expect(within(panel).getByText('Loading codes…')).toBeInTheDocument()
    expect(within(panel).queryByText('No codes yet')).not.toBeInTheDocument()
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

/** #1028 — the server swaps a code-set value and says what it replaced; undo puts it back. */
describe('an apply that REPLACED a value, and its undo (#1028) — the text-coding surface', () => {
  it('Ctrl+Z re-applies the replaced value WITH its rating — a ZERO — and removes nothing', async () => {
    applyCode.mockImplementation(async (_pid: number, body: { code_id: number }) =>
      ({ dataset_value_id: 102, code_id: body.code_id, applied: true,
         replaced_code_ids: body.code_id === 8 ? [7] : [] }))
    renderView()
    fireEvent.click(await findRow(102))  // holds Engagement, rated 0
    fireEvent.keyDown(document.body, { key: '2' })  // Disruption
    await waitFor(() => expect(applyCode).toHaveBeenCalledWith(1, { dataset_value_id: 102, code_id: 8 }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled())

    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })
    await waitFor(() => expect(applyCode).toHaveBeenLastCalledWith(1, { dataset_value_id: 102, code_id: 7 }))
    await waitFor(() => expect(setMagnitude).toHaveBeenCalledWith(1, { dataset_value_id: 102, code_id: 7, magnitude: 0 }))
    expect(removeCode).not.toHaveBeenCalled()
  })
})
