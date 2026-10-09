/**
 * CodingWorkbench — the conversation surface's rating undo (#868 f) and the
 * rating strip's stand-down on a real page (#870 a).
 *
 * The strip was mounted here first (#35), and the review found that undoing a
 * REMOVAL re-applied bare: `codingApi.applyCode(segmentId, codeId)` with no
 * rating, so Ctrl+Z silently unrated. The fixture rates ZERO on purpose — a fix
 * that re-applied bare and one that read `previous || null` fail identically.
 *
 * Harness mirrors `ObservationWorkbench.test.tsx` / `DocumentCodingWorkbench.test.tsx`.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, within, act } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import { VirtuosoMockContext } from 'react-virtuoso'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ThemeProvider } from '@/lib/theme-context'
import type { Code, Conversation, Segment } from '@/lib/api'

const getConversation = vi.fn()
const listConversations = vi.fn()
const listSegments = vi.fn()
const listCodes = vi.fn()
const listCategories = vi.fn()
const listNotes = vi.fn()
const listSpeakers = vi.fn()
const getProject = vi.fn()
const listCoders = vi.fn()
const listExcerpts = vi.fn()
const coderCoverage = vi.fn()
const applyCode = vi.fn()
const removeCode = vi.fn()
const bulkCode = vi.fn()
const setMagnitude = vi.fn()
const listCodeSets = vi.fn()
const selectOnSegment = vi.fn()

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    conversationsApi: {
      ...actual.conversationsApi,
      get: (...a: unknown[]) => getConversation(...a),
      list: (...a: unknown[]) => listConversations(...a),
    },
    segmentsApi: { ...actual.segmentsApi, list: (...a: unknown[]) => listSegments(...a) },
    codesApi: { ...actual.codesApi, list: (...a: unknown[]) => listCodes(...a) },
    categoriesApi: { ...actual.categoriesApi, list: (...a: unknown[]) => listCategories(...a) },
    notesApi: { ...actual.notesApi, listForConversation: (...a: unknown[]) => listNotes(...a) },
    speakersApi: { ...actual.speakersApi, list: (...a: unknown[]) => listSpeakers(...a) },
    projectsApi: { ...actual.projectsApi, get: (...a: unknown[]) => getProject(...a) },
    authApi: { ...actual.authApi, listCoders: (...a: unknown[]) => listCoders(...a) },
    excerptsApi: { ...actual.excerptsApi, list: (...a: unknown[]) => listExcerpts(...a) },
    codeAnalysisApi: { ...actual.codeAnalysisApi, coderCoverage: (...a: unknown[]) => coderCoverage(...a) },
    codeSetsApi: {
      ...actual.codeSetsApi,
      list: (...a: unknown[]) => listCodeSets(...a),
      selectOnSegment: (...a: unknown[]) => selectOnSegment(...a),
    },
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

vi.mock('@/components/VideoPane', () => ({ default: () => null }))

import CodingWorkbench from './CodingWorkbench'

const CONVERSATION: Conversation = {
  id: 9, project_id: 1, name: 'Interview 9', subject_id: null, conversation_date: null,
  status: 'in_progress',
  created_at: '2026-09-02T00:00:00+00:00', updated_at: '2026-09-02T00:00:00+00:00',
  segment_count: 2, coded_segment_count: 1, speaker_count: 1, code_count: 1,
  media_filename: null, media_format: null, media_type: null, media_duration_seconds: null,
  media_offset_seconds: 0, media_is_vbr: null, has_media: false, media_size_bytes: null,
  media_version: null,
}

const segment = (id: number, order: number, text: string, extra: Partial<Segment> = {}): Segment => ({
  id, conversation_id: 9, speaker_id: 1, speaker_name: 'P1', is_facilitator: false,
  speaker_color_index: 0, speaker_color: null, sequence_order: order,
  start_time: null, end_time: null, text, group_id: null, excerpts: [],
  applied_codes: [], applied_code_details: [], attached_notes: [],
  is_merged: false, is_split: false, created_at: '2026-09-02T00:00:00+00:00',
  ...extra,
})

const SEGMENTS = [
  segment(51, 0, 'The first turn of the interview.'),
  // 🔴 Rated ZERO: the falsy-zero fixture rule.
  segment(52, 1, 'The second turn.', {
    applied_codes: [7],
    applied_code_details: [{ code_id: 7, user_id: 1, attribution: null, is_universal: false,
                             magnitude: 0, magnitude_conflict: null }],
  }),
]

const makeCode = (id: number, numericId: number, name: string, extra: Partial<Code> = {}): Code => ({
  id, project_id: 1, numeric_id: numericId, name, description: null, color: null,
  is_universal: false, is_active: true,
  created_at: '2026-09-02T00:00:00+00:00', updated_at: '2026-09-02T00:00:00+00:00',
  usage_count: 0, category_id: null, category_name: null, category_color: null, category_order: null,
  ...extra,
})
const CODES = [
  makeCode(7, 1, 'Engagement', { magnitude_scale: { min: 0, max: 10, step: 1, anchors: [] } }),
  makeCode(8, 2, 'Disruption'),
]

function renderWorkbench(qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(
    <QueryClientProvider client={qc}>
      <ThemeProvider>
        <TooltipProvider>
          <MemoryRouter initialEntries={['/projects/1/conversations/9']}>
            <VirtuosoMockContext.Provider value={{ viewportHeight: 1000, itemHeight: 48 }}>
              <Routes>
                <Route path="/projects/:projectId/conversations/:conversationId" element={<CodingWorkbench />} />
              </Routes>
            </VirtuosoMockContext.Provider>
          </MemoryRouter>
        </TooltipProvider>
      </ThemeProvider>
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
  // jsdom has no matchMedia; ThemeProvider's system-mode listener asks for it.
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }),
  })
  vi.clearAllMocks()
  getConversation.mockResolvedValue(CONVERSATION)
  listConversations.mockResolvedValue([CONVERSATION])
  listSegments.mockResolvedValue({
    segments: SEGMENTS, total: 2, coded_count: 1, participant_total: 2, participant_coded: 1,
  })
  listCodes.mockResolvedValue({ codes: CODES, total: CODES.length })
  listCategories.mockResolvedValue({ categories: [] })
  listNotes.mockResolvedValue([])
  listSpeakers.mockResolvedValue([])
  getProject.mockResolvedValue({ id: 1, name: 'Study', description: null })
  listCoders.mockResolvedValue([{ id: 1, username: 'Alice', display_color: null, archived: false }])
  listExcerpts.mockResolvedValue({ excerpts: [], total: 0 })
  coderCoverage.mockResolvedValue({ coders: [], count: 0 })
  applyCode.mockResolvedValue({ applied: true })
  removeCode.mockResolvedValue({ applied: false })
  bulkCode.mockResolvedValue({ success_count: 0, error_count: 0, failed_segment_ids: [] })
  setMagnitude.mockResolvedValue({ applied: true, magnitude: 7 })
  listCodeSets.mockResolvedValue({ sets: [] })
  selectOnSegment.mockResolvedValue({ set_id: 3, code_id: 7, removed: 1 })
})

afterEach(cleanup)

describe('undo carries the rating (#868 f)', () => {
  it('removing a rated code then Ctrl+Z re-applies WITH the previous rating — a ZERO', async () => {
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    // The row selects on mousedown (button 0) — see SegmentRow.
    fireEvent.mouseDown(rows[1], { button: 0 })   // segment 52: Engagement rated 0 by this coder
    fireEvent.keyDown(window, { key: '1' })         // numeric_id 1 → Engagement → toggle = remove
    await waitFor(() => expect(removeCode).toHaveBeenCalledWith(52, 7))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled())

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })

    // Fourth argument: the captured rating. `undefined` there is the old bug.
    await waitFor(() => expect(applyCode).toHaveBeenCalledWith(52, 7, undefined, 0))
  })
})

/**
 * #1028 — applying a value of a code set REPLACES the coder's other value, at
 * every door, and says which in `replaced_code_ids`. The server is mocked to
 * answer as it does for a set holding Engagement (7) and Disruption (8).
 */
describe('an apply that REPLACED a value, and its undo (#1028)', () => {
  it('paints the replaced chip away, and Ctrl+Z puts it back WITH its rating — a ZERO', async () => {
  // The server swaps BOTH ways while the two are values of one set: the undo's
  // re-apply of 7 reports 8 replaced (#1081 c reads that report).
    applyCode.mockImplementation(async (_seg: number, code: number) =>
      ({ applied: true, replaced_code_ids: code === 8 ? [7] : code === 7 ? [8] : [] }))
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    fireEvent.mouseDown(rows[1], { button: 0 })   // segment 52 holds Engagement, rated 0
    expect(within(rows[1]).getAllByText('Engagement').length).toBeGreaterThan(0)
    fireEvent.keyDown(window, { key: '2' })         // Disruption
    await waitFor(() => expect(applyCode).toHaveBeenCalledWith(52, 8))
    // This page never refetches the segments after an apply (#367), so the chip
    // leaves only because the server's report is painted.
    const row52 = () => screen.getAllByRole('option')[1]
    await waitFor(() => expect(within(row52()).queryByText('Engagement')).toBeNull())

    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled())
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })

    // Re-applying the replaced value is the atomic swap back; the rating is a
    // second call. Removing Disruption by itself would have left NO value.
    await waitFor(() => expect(applyCode).toHaveBeenLastCalledWith(52, 7))
    await waitFor(() => expect(setMagnitude).toHaveBeenCalledWith(52, 7, 0))
    expect(removeCode).not.toHaveBeenCalled()
    await waitFor(() => expect(within(row52()).getAllByText('Engagement').length).toBeGreaterThan(0))
  })

  it('the CONTEXT MENU applies through the shared pair — the undo restores, and a scaled code is rated', async () => {
    // It was a private copy of the pair: no rating strip for a scaled code, and
    // an undo that could only remove (found by a SURVIVING mutant).
    applyCode.mockImplementation(async (_seg: number, code: number) =>
      ({ applied: true, replaced_code_ids: code === 7 ? [8] : code === 8 ? [7] : [] }))
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    fireEvent.contextMenu(rows[0])                                  // segment 51
    fireEvent.keyDown(await screen.findByText('Apply Code'), { key: 'ArrowRight' })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Engagement/ }))
    await waitFor(() => expect(applyCode).toHaveBeenCalledWith(51, 7))
    expect(await screen.findByTestId('magnitude-strip')).toBeInTheDocument()

    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'Escape' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled())
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    await waitFor(() => expect(applyCode).toHaveBeenLastCalledWith(51, 8))
    expect(removeCode).not.toHaveBeenCalled()
  })

  it('the set CHANGED before the undo: nothing was swapped out, so the undone value is removed (#1081 c)', async () => {
    // The set was deleted, or Engagement left it, between the act and Ctrl+Z:
    // re-applying Engagement no longer takes Disruption off, and the passage
    // held BOTH while this page painted one.
    applyCode.mockImplementation(async (_seg: number, code: number) =>
      ({ applied: true, replaced_code_ids: code === 8 ? [7] : [] }))
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    fireEvent.mouseDown(rows[1], { button: 0 })   // segment 52 holds Engagement
    fireEvent.keyDown(window, { key: '2' })         // Disruption
    await waitFor(() => expect(applyCode).toHaveBeenCalledWith(52, 8))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled())

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    await waitFor(() => expect(applyCode).toHaveBeenLastCalledWith(52, 7))
    await waitFor(() => expect(removeCode).toHaveBeenCalledWith(52, 8))
  })

  it('a multi-segment apply’s undo leaves the code on a segment that ALREADY had it', async () => {
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    fireEvent.mouseDown(rows[0], { button: 0 })
    fireEvent.mouseDown(rows[1], { button: 0, shiftKey: true })   // 51 (uncoded) + 52 (holds Engagement)
    fireEvent.keyDown(window, { key: '1' })                         // not all have it → apply to both
    await waitFor(() => expect(bulkCode).toHaveBeenCalledWith([51, 52], 7, 'apply'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled())

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    // It used to be `([51, 52], 7, 'remove')` — deleting a coding the
    // researcher made before the act, by undoing something else.
    await waitFor(() => expect(bulkCode).toHaveBeenLastCalledWith([51], 7, 'remove'))
  })
})

/**
 * #1059 — a rating given while a segments refetch is OUT used to be painted and
 * then overwritten by that response, which left the server before the rating did.
 * The race needs a refetch held open across the commit, so the second list call is
 * a deferred promise carrying the STALE data, released after the rating lands.
 */
describe('a rating is not painted over by a refetch already in flight (#1059)', () => {
  function deferred<T>() {
    let resolve!: (v: T) => void
    const promise = new Promise<T>(r => { resolve = r })
    return { promise, resolve }
  }
  const page = (segments: Segment[]) => ({
    segments, total: segments.length, coded_count: 1, participant_total: 2, participant_coded: 1,
  })
  const rated = (value: number) => segment(52, 1, 'The second turn.', {
    applied_codes: [7],
    applied_code_details: [{ code_id: 7, user_id: 1, attribution: null, is_universal: false,
                             magnitude: value, magnitude_conflict: null }],
  })

  async function rateWhileARefetchIsOut(afterWrite: Segment[]) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const stale = deferred<ReturnType<typeof page>>()
    listSegments.mockReset()
    listSegments
      .mockResolvedValueOnce(page(SEGMENTS))   // first load: 52 rated 0
      .mockReturnValueOnce(stale.promise)      // a strip choice's refetch, held open
      .mockResolvedValue(page(afterWrite))     // what the server holds after the write
    renderWorkbench(qc)
    const rows = await screen.findAllByRole('option')
    fireEvent.mouseDown(rows[1], { button: 0 })   // segment 52, Engagement rated 0
    act(() => { void qc.invalidateQueries({ queryKey: ['segments', 9] }) })
    await waitFor(() => expect(listSegments).toHaveBeenCalledTimes(2))
    fireEvent.keyDown(window, { key: 'r' })
    const group = await screen.findByRole('radiogroup')
    fireEvent.keyDown(group, { key: '5' })
    await waitFor(() => expect(setMagnitude).toHaveBeenCalledWith(52, 7, 5))
    // The stale response lands AFTER the rating, as it did in the race.
    await act(async () => { stale.resolve(page(SEGMENTS)) })
    return () => screen.getAllByRole('option')
  }

  it('the rating survives a stale response that lands WHILE the write is out', async () => {
    // The window the cancel closes: the refetch after the write would cancel a
    // still-pending stale fetch on its own, so only a response landing DURING the
    // write could paint over the rating — "0 out of 10" until the settle, and for
    // good on the code before #1059, which had no settle at all.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const stale = deferred<ReturnType<typeof page>>()
    const write = deferred<{ applied: boolean; magnitude: number }>()
    setMagnitude.mockReturnValueOnce(write.promise)
    listSegments.mockReset()
    listSegments
      .mockResolvedValueOnce(page(SEGMENTS))
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValue(page([SEGMENTS[0], rated(5)]))
    renderWorkbench(qc)
    const rows = await screen.findAllByRole('option')
    fireEvent.mouseDown(rows[1], { button: 0 })
    act(() => { void qc.invalidateQueries({ queryKey: ['segments', 9] }) })
    await waitFor(() => expect(listSegments).toHaveBeenCalledTimes(2))
    fireEvent.keyDown(window, { key: 'r' })
    fireEvent.keyDown(await screen.findByRole('radiogroup'), { key: '5' })
    await waitFor(() => expect(setMagnitude).toHaveBeenCalledWith(52, 7, 5))
    const row52 = () => screen.getAllByRole('option')[1]
    await waitFor(() => expect(row52()).toHaveTextContent(/5 out of 10/))   // painted
    // ⚠️ Let React re-render before reading the row: TanStack notifies observers on
    // a timer, so a read straight after the resolve sees the OLD DOM and passes
    // whether or not the stale data landed (it did, and a mutant survived that way).
    await act(async () => {
      stale.resolve(page(SEGMENTS))                                           // lands mid-write
      await new Promise(r => setTimeout(r, 30))
    })
    expect(row52()).toHaveTextContent(/5 out of 10/)
    expect(row52()).not.toHaveTextContent(/0 out of 10/)
    await act(async () => { write.resolve({ applied: true, magnitude: 5 }) })
    await waitFor(() => expect(row52()).toHaveTextContent(/5 out of 10/))
  })

  it('a later truth the cancelled refetch would have carried still lands — the refetch after the write', async () => {
    // Cancelling reverts to the state at that fetch's start, so what IT would have
    // delivered (here, Disruption on segment 51 from a strip choice) must come
    // from the one refetch after the write.
    const withChoice = segment(51, 0, 'The first turn of the interview.', {
      applied_codes: [8],
      applied_code_details: [{ code_id: 8, user_id: 1, attribution: null, is_universal: false,
                               magnitude: null, magnitude_conflict: null }],
    })
    const rowsNow = await rateWhileARefetchIsOut([withChoice, rated(5)])
    await waitFor(() => expect(within(rowsNow()[0]).getAllByText('Disruption').length).toBeGreaterThan(0))
    expect(rowsNow()[1]).toHaveTextContent(/5 out of 10/)
  })
})

describe('the rating strip on the conversation workbench', () => {
  it('a digit typed into the open strip rates and does NOT apply a second code (#870 a)', async () => {
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    fireEvent.mouseDown(rows[0], { button: 0 })   // segment 51, uncoded
    fireEvent.keyDown(window, { key: '1' })         // apply Engagement, which declares a scale
    await waitFor(() => expect(applyCode).toHaveBeenCalledWith(51, 7))

    const strip = await screen.findByTestId('magnitude-strip')
    expect(screen.getByRole('listbox').contains(strip)).toBe(false)
    const group = screen.getByRole('radiogroup')
    expect(document.activeElement).toBe(group)

    fireEvent.keyDown(group, { key: '7' })
    await waitFor(() => expect(setMagnitude).toHaveBeenCalledWith(51, 7, 7))
    expect(applyCode).toHaveBeenCalledTimes(1)
  })
})

/**
 * #964 — measured live: with the coder roster held back, a multi-coder
 * transcript rendered 19 chips instead of 5 and no blind toggle. An unanswered
 * roster read as a one-person one, so blind mode was off.
 */
describe('#964 — an unanswered coder roster keeps colleagues hidden', () => {
  // Segment 51 carries ONLY a colleague's code; 52 carries mine.
  const WITH_COLLEAGUE = [
    segment(51, 0, 'The first turn of the interview.', {
      applied_codes: [8],
      applied_code_details: [{ code_id: 8, user_id: 2, attribution: null, is_universal: false,
                               magnitude: null, magnitude_conflict: null }],
    }),
    SEGMENTS[1],
  ]

  it.each([
    ['loading', () => listCoders.mockReturnValue(new Promise(() => {}))],
    ['failed', () => listCoders.mockRejectedValue(new Error('network'))],
  ] as const)('roster %s: my chip renders, the colleague\'s does not, and the gauge counts only mine', async (_s, arrange) => {
    arrange()
    listSegments.mockResolvedValue({
      segments: WITH_COLLEAGUE, total: 2, coded_count: 2, participant_total: 2, participant_coded: 2,
    })
    renderWorkbench()

    const rows = await screen.findAllByRole('option')
    await waitFor(() => expect(within(rows[1]).getByText('Engagement')).toBeInTheDocument())
    expect(within(rows[0]).queryByText('Disruption')).not.toBeInTheDocument()
    const gauge = screen.getAllByRole('progressbar', { name: 'Coding progress' })[0]
    expect(gauge).toHaveAttribute('aria-valuetext', '1 of 2 participant segments coded by visible coders')
    // The claim waits: no toggle, and the gauge does not say "(colleagues hidden)".
    expect(screen.queryByRole('button', { name: /Colleagues/ })).not.toBeInTheDocument()
  })

  // Found by #964's review: "View all — N archived" outlived re-blinding, and the
  // blind set is built from the NON-archived roster.
  it('re-blinding hides an archived colleague\'s chips even after "View all" was switched on', async () => {
    listCoders.mockResolvedValue([
      { id: 1, username: 'Alice', display_color: null, archived: false },
      { id: 2, username: 'Bob', display_color: null, archived: false },
    ])
    coderCoverage.mockResolvedValue({
      coders: [{ user_id: 3, username: 'Carla', display_color: null, archived: true, coding_count: 1 }],
      count: 1,
    })
    listSegments.mockResolvedValue({
      segments: [
        segment(51, 0, 'The first turn of the interview.', {
          applied_codes: [8],
          applied_code_details: [{ code_id: 8, user_id: 3, attribution: null, is_universal: false,
                                   magnitude: null, magnitude_conflict: null }],
        }),
        SEGMENTS[1],
      ],
      total: 2, coded_count: 2, participant_total: 2, participant_coded: 2,
    })
    localStorage.setItem('mm-blind-revealed-1-1', '1')
    renderWorkbench()

    fireEvent.click(await screen.findByRole('button', { name: 'Filter codes by coder' }))
    fireEvent.click(await screen.findByRole('button', { name: /View all — 1 archived/ }))
    expect(await screen.findByText(/coded by Carla/)).toBeInTheDocument() // positive control

    fireEvent.click(screen.getByRole('button', { name: 'Colleagues shown' }))
    expect(await screen.findByRole('button', { name: 'Colleagues hidden' })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText(/coded by Carla/)).not.toBeInTheDocument())
  })
})

/**
 * #1029 — the gauge counts PEOPLE's coding. Before the fix a turn only a model had
 * labelled counted as coded here, while the conversation card (the server's
 * `coding_counts`) did not. The model's chip still renders: attribution is the
 * point of the machine layer; the COUNT is what leaves it out.
 */
describe('#1029 — a machine coder never makes a turn coded on the gauge', () => {
  const MACHINE_ONLY = [
    segment(51, 0, 'The first turn of the interview.', {
      applied_codes: [8],
      applied_code_details: [{ code_id: 8, user_id: 9, attribution: null, is_universal: false,
                               magnitude: null, magnitude_conflict: null }],
    }),
    SEGMENTS[1],
  ]

  it('an ACTIVE machine: its turn is uncoded, and its chip still shows', async () => {
    listCoders.mockResolvedValue([
      { id: 1, username: 'Alice', display_color: null, archived: false },
      { id: 9, username: 'GPT-4o', display_color: null, archived: false, coder_type: 'ai' },
    ])
    listSegments.mockResolvedValue({
      segments: MACHINE_ONLY, total: 2, coded_count: 1, participant_total: 2, participant_coded: 1,
    })
    renderWorkbench()

    const rows = await screen.findAllByRole('option')
    await waitFor(() => expect(within(rows[0]).getByText('Disruption')).toBeInTheDocument())
    const bar = await screen.findByRole('progressbar', { name: 'Coding progress' })
    expect(bar).toHaveAttribute('aria-valuenow', '1')
    expect(bar).toHaveAttribute('aria-valuetext', expect.stringContaining('1 of 2 participant segments coded'))
  })

  it('an ARCHIVED machine, which only the archive-inclusive roster names, is still left out', async () => {
    // The ordinary roster excludes archived coders; `useMachineCoderIds` asks for
    // them too. Without that second list this turn would count again.
    listCoders.mockImplementation((includeArchived?: boolean) => Promise.resolve(
      includeArchived === true
        ? [{ id: 1, username: 'Alice', display_color: null, archived: false },
           { id: 9, username: 'GPT-4o', display_color: null, archived: true, coder_type: 'ai' }]
        : [{ id: 1, username: 'Alice', display_color: null, archived: false }],
    ))
    listSegments.mockResolvedValue({
      segments: MACHINE_ONLY, total: 2, coded_count: 1, participant_total: 2, participant_coded: 1,
    })
    renderWorkbench()

    await waitFor(() => expect(listCoders).toHaveBeenCalledWith(true))
    await waitFor(() => expect(
      screen.getByRole('progressbar', { name: 'Coding progress' }),
    ).toHaveAttribute('aria-valuenow', '1'))
  })
})

/**
 * #1077 (c) — the orange "uncoded" ring on a turn marks exactly the turns `j`
 * jumps to. It tested `applied_codes.length === 0` on the row itself, so a turn
 * only a MODEL labelled, or only a universal marker touched, had no ring while the
 * gauge called it uncoded — and while BLIND a turn only a colleague had coded had
 * neither a chip nor a ring, which told the coder someone had (confirmed live by
 * the 2026-09-28 /ux-audit).
 */
describe('#1077 (c) — the uncoded ring is the workbench\'s decision', () => {
  const ringed = (row: HTMLElement) => row.className.includes('ring-orange-200')
  const one = (codeId: number, userId: number, universal = false) => ({
    applied_codes: [codeId],
    applied_code_details: [{ code_id: codeId, user_id: userId, attribution: null,
                             is_universal: universal, magnitude: null, magnitude_conflict: null }],
  })

  it('a turn only a MODEL labelled is ringed, like the gauge counts it; my turn is not', async () => {
    listCoders.mockResolvedValue([
      { id: 1, username: 'Alice', display_color: null, archived: false },
      { id: 9, username: 'GPT-4o', display_color: null, archived: false, coder_type: 'ai' },
    ])
    listSegments.mockResolvedValue({
      segments: [segment(51, 0, 'The first turn.', one(8, 9)), SEGMENTS[1]],
      total: 2, coded_count: 1, participant_total: 2, participant_coded: 1,
    })
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    await waitFor(() => expect(within(rows[0]).getByText('Disruption')).toBeInTheDocument())
    await waitFor(() => expect(ringed(rows[0])).toBe(true))
    expect(ringed(rows[1])).toBe(false)   // coded by me — the positive control
  })

  it('a turn carrying only a UNIVERSAL marker is ringed (#400\'s definition)', async () => {
    const universal = makeCode(12, 3, 'Unclear', { is_universal: true })
    listCodes.mockResolvedValue({ codes: [...CODES, universal], total: 3 })
    listSegments.mockResolvedValue({
      segments: [segment(51, 0, 'The first turn.', one(12, 1, true)), SEGMENTS[1]],
      total: 2, coded_count: 1, participant_total: 2, participant_coded: 1,
    })
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    await waitFor(() => expect(ringed(rows[0])).toBe(true))
    expect(ringed(rows[1])).toBe(false)
  })

  it('BLIND: a turn only a colleague coded shows the ring, so its absence reveals nothing', async () => {
    listCoders.mockResolvedValue([
      { id: 1, username: 'Alice', display_color: null, archived: false },
      { id: 2, username: 'Bob', display_color: null, archived: false },
    ])
    listSegments.mockResolvedValue({
      segments: [segment(51, 0, 'The first turn.', one(8, 2)), SEGMENTS[1]],
      total: 2, coded_count: 2, participant_total: 2, participant_coded: 2,
    })
    renderWorkbench()
    expect(await screen.findByRole('button', { name: 'Colleagues hidden' })).toBeInTheDocument()
    const rows = await screen.findAllByRole('option')
    await waitFor(() => expect(ringed(rows[0])).toBe(true))
    expect(within(rows[0]).queryByText('Disruption')).not.toBeInTheDocument()
  })

  it('REVEALED (positive control): the same colleague-coded turn is not ringed', async () => {
    listCoders.mockResolvedValue([
      { id: 1, username: 'Alice', display_color: null, archived: false },
      { id: 2, username: 'Bob', display_color: null, archived: false },
    ])
    listSegments.mockResolvedValue({
      segments: [segment(51, 0, 'The first turn.', one(8, 2)), SEGMENTS[1]],
      total: 2, coded_count: 2, participant_total: 2, participant_coded: 2,
    })
    localStorage.setItem('mm-blind-revealed-1-1', '1')
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    await waitFor(() => expect(within(rows[0]).getByText('Disruption')).toBeInTheDocument())
    expect(ringed(rows[0])).toBe(false)
  })
})

/**
 * #963 Tier 2 — the coverage gauge and the transcript measure ONE list, and
 * neither may speak for it before it answers.
 *
 * MEASURED before the fix (dev corpus, conversation 9, `/segments` held back by
 * an in-page `fetch` wrapper): the toolbar announced `aria-valuenow="0"` /
 * `aria-valuemax="0"` and *"0 of 0 participant segments coded"* while the
 * transcript said *"No segments found"*. With the request failing instead, both
 * said the same thing PERMANENTLY — two requests, then silence — and the only
 * reading available to a researcher is that their transcript is gone.
 *
 * ⚠️ These cases render with the app's own retry policy, NOT the `retry: false`
 * the rest of this file uses: under `retry: false` deleting `retryUnanswered`
 * from the query changes nothing and the assertion below cannot fail (#961 §4).
 */
function renderWithAppRetry() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: 1, retryDelay: 0 } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <ThemeProvider>
        <TooltipProvider>
          <MemoryRouter initialEntries={['/projects/1/conversations/9']}>
            <VirtuosoMockContext.Provider value={{ viewportHeight: 1000, itemHeight: 48 }}>
              <Routes>
                <Route path="/projects/:projectId/conversations/:conversationId" element={<CodingWorkbench />} />
              </Routes>
            </VirtuosoMockContext.Provider>
          </MemoryRouter>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  )
}

const gauge = () => screen.queryByRole('progressbar', { name: 'Coding progress' })

describe('#963 — the gauge and the transcript wait for the segment list', () => {
  it('READY: the gauge states the real coverage and the transcript renders (positive control)', async () => {
    renderWithAppRetry()

    const bar = await screen.findByRole('progressbar', { name: 'Coding progress' })
    expect(bar).toHaveAttribute('aria-valuenow', '1')
    expect(bar).toHaveAttribute('aria-valuemax', '2')
    expect(bar).toHaveAttribute('aria-valuetext', expect.stringContaining('1 of 2 participant segments coded'))
    expect(screen.queryByText('Loading segments…')).not.toBeInTheDocument()
    expect(screen.queryByText('No segments found')).not.toBeInTheDocument()
  })

  it('LOADING: no progressbar at all, and the transcript says it is loading', async () => {
    listSegments.mockReturnValue(new Promise(() => {})) // never settles
    renderWithAppRetry()

    // The page gate resolves first (project + conversation), so the toolbar is up.
    expect(await screen.findByRole('button', { name: 'Codebook' })).toBeInTheDocument()

    // A fake 0-of-0 is worse than no gauge: `aria-valuemax="0"` is a degenerate
    // range AND the number is false.
    expect(gauge()).toBeNull()
    expect(screen.queryByText(/participant segments coded/)).not.toBeInTheDocument()
    expect(screen.queryByText('No segments found')).not.toBeInTheDocument()

    const notice = await screen.findByText('Loading segments…')
    expect(notice.closest('[role="status"]')).not.toBeNull()
  })

  it('LOADING: exactly ONE status line — the toolbar slot stays silent beside it', async () => {
    listSegments.mockReturnValue(new Promise(() => {}))
    renderWithAppRetry()

    await screen.findByText('Loading segments…')
    const spoken = screen.getAllByRole('status').map(n => n.textContent?.trim()).filter(Boolean)
    expect(spoken).toEqual(['Loading segments…'])
  })

  it('FAILED: says the LOAD failed, offers a Retry, and never claims the transcript is empty', async () => {
    listSegments.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }))
    renderWithAppRetry()

    expect(await screen.findByText('This transcript could not be loaded')).toBeInTheDocument()
    expect(screen.getByText(/Nothing in your project has changed/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.queryByText('No segments found')).not.toBeInTheDocument()
    expect(gauge()).toBeNull()
    // The gauge slot explains itself rather than sitting blank.
    expect(screen.getByText('Coding progress unavailable')).toBeInTheDocument()
  })

  it('FAILED: the server settled it, so it is asked ONCE — not retried', async () => {
    listSegments.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }))
    renderWithAppRetry()

    await screen.findByText('This transcript could not be loaded')
    expect(listSegments).toHaveBeenCalledTimes(1)
  })

  it('a dropped connection IS retried — the case a retry exists for', async () => {
    // No `status`: nothing answered, so asking again is not asking twice.
    listSegments.mockRejectedValue(new Error('network down'))
    renderWithAppRetry()

    await screen.findByText('This transcript could not be loaded')
    await waitFor(() => expect(listSegments).toHaveBeenCalledTimes(2))
  })

  it('ONE gauge, not two — the bar inside the region carries no semantics of its own', async () => {
    // #351/#352 gave `SegmentProgressBar` its own `role="progressbar"` named
    // "Coding progress"; J1 3c wrapped it in a region with the SAME role and
    // name. Two nested progressbars stated the same count, and only the OUTER
    // one carries the blind-scope qualifier. Pinned as an ARITY check: a
    // `length > 0` assertion is satisfied by exactly the state that was wrong.
    renderWithAppRetry()

    await screen.findByRole('progressbar', { name: 'Coding progress' })
    expect(screen.getAllByRole('progressbar')).toHaveLength(1)
  })

  it('"Jump to uncoded" cannot act on an unknown list, so it is not operable', async () => {
    listSegments.mockReturnValue(new Promise(() => {}))
    renderWithAppRetry()

    const jump = await screen.findByRole('button', { name: /Jump to uncoded/ })
    expect(jump).toBeDisabled()
  })

  it('"Jump to uncoded" is operable once the list answers (positive control)', async () => {
    renderWithAppRetry()

    const jump = await screen.findByRole('button', { name: /Jump to uncoded/ })
    await waitFor(() => expect(jump).not.toBeDisabled())
  })
})

/**
 * #1070 — a single act on a segment GROUP fans out to every sibling, and the
 * siblings routinely differ (grouping does not unify codings). The undo is
 * captured over the group and runs through the BULK door, which acts on exactly
 * the segments it is given — never the single door, which fans out again.
 * X = 61 is the sibling, Y = 62 the pressed segment.
 */
describe('undo on a segment GROUP whose siblings differ (#1070)', () => {
  const grouped = (xDetails: Segment['applied_code_details'], yDetails: Segment['applied_code_details']) => {
    listSegments.mockResolvedValue({
      segments: [
        segment(61, 0, 'The sibling.', {
          group_id: 5, applied_codes: xDetails.map((d) => d.code_id), applied_code_details: xDetails,
        }),
        segment(62, 1, 'The pressed turn.', {
          group_id: 5, applied_codes: yDetails.map((d) => d.code_id), applied_code_details: yDetails,
        }),
      ],
      total: 2, coded_count: 1, participant_total: 2, participant_coded: 1,
    })
  }
  const detail = (code_id: number, magnitude: number | null = null) =>
    ({ code_id, user_id: 1, attribution: null, is_universal: false, magnitude, magnitude_conflict: null })

  it('(a) the undo of an apply leaves a sibling’s EARLIER coding alone', async () => {
    grouped([detail(8)], [])
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    fireEvent.mouseDown(rows[1], { button: 0 })   // Y
    fireEvent.keyDown(window, { key: '2' })         // Disruption: Y lacks it → apply (fans out)
    await waitFor(() => expect(applyCode).toHaveBeenCalledWith(62, 8))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled())

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    // `removeCode(62, 8)` would fan out and take X's earlier Disruption with it.
    await waitFor(() => expect(bulkCode).toHaveBeenCalledWith([62], 8, 'remove'))
    expect(removeCode).not.toHaveBeenCalled()
  })

  it('(b) each sibling gets back ITS OWN replaced value, with its rating', async () => {
    grouped([detail(7, 0)], [])
    // The bulk re-apply of 7 on X swaps 8 off it and says so (#1081 c).
    bulkCode.mockImplementation(async (ids: number[], code: number, action: string) => (
      action === 'apply' && code === 7
        ? { results: ids.map((id) => ({ segment_id: id, replaced_code_ids: [8] })),
            success_count: ids.length, error_count: 0, failed_segment_ids: [] }
        : { success_count: 0, error_count: 0, failed_segment_ids: [] }))
    applyCode.mockImplementation(async (_seg: number, code: number) => (code === 8
      ? { applied: true, replaced_code_ids: [7], replaced_by_target: [{ segment_id: 61, replaced_code_ids: [7] }] }
      : { applied: true, replaced_code_ids: [], replaced_by_target: [] }))
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    fireEvent.mouseDown(rows[1], { button: 0 })   // Y
    fireEvent.keyDown(window, { key: '2' })         // Disruption replaces X's Engagement
    await waitFor(() => expect(applyCode).toHaveBeenCalledWith(62, 8))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled())

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    await waitFor(() => expect(bulkCode).toHaveBeenCalledWith([61], 7, 'apply'))
    await waitFor(() => expect(bulkCode).toHaveBeenCalledWith([62], 8, 'remove'))
    await waitFor(() => expect(setMagnitude).toHaveBeenCalledWith(61, 7, 0))
    // The old undo: `applyCode(62, 7)` — a value Y never had, fanned out, unrated.
    expect(applyCode).toHaveBeenCalledTimes(1)
  })

  it('the undo of a REMOVE gives the code back only to the siblings that held it', async () => {
    grouped([], [detail(7, 0)])
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    fireEvent.mouseDown(rows[1], { button: 0 })   // Y holds Engagement, rated 0
    fireEvent.keyDown(window, { key: '1' })         // → remove (fans out)
    await waitFor(() => expect(removeCode).toHaveBeenCalledWith(62, 7))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled())

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    await waitFor(() => expect(bulkCode).toHaveBeenCalledWith([62], 7, 'apply'))
    await waitFor(() => expect(setMagnitude).toHaveBeenCalledWith(62, 7, 0))
    // `applyCode(62, 7, …, 0)` would fan out and give X a code it never held.
    expect(applyCode).not.toHaveBeenCalled()
  })
})

describe('a code-set choice on a GROUP, undone from the workbench (#1070)', () => {
  it('hands the strip the group, so each member gets its OWN value back', async () => {
    const member = (id: number, name: string) =>
      ({ id, numeric_id: id, name, description: null, color: null, is_active: true, is_universal: false })
    listCodeSets.mockResolvedValue({ sets: [{
      id: 3, project_id: 1, label: 'Tone', description: null, exhaustive: false,
      members: [member(7, 'Engagement'), member(8, 'Disruption')],
      set_basis: 'inclusive_with_none', composition_warnings: [],
      claimants: [7, 8].map((id) => ({ code_id: id, value_id: id })),
      created_at: '', updated_at: '',
    }] })
    const detail = (code_id: number, magnitude: number | null = null) =>
      ({ code_id, user_id: 1, attribution: null, is_universal: false, magnitude, magnitude_conflict: null })
    listSegments.mockResolvedValue({
      segments: [
        segment(61, 0, 'The sibling.', { group_id: 5, applied_codes: [7], applied_code_details: [detail(7, 0)] }),
        segment(62, 1, 'The pressed turn.', { group_id: 5, applied_codes: [8], applied_code_details: [detail(8)] }),
      ],
      total: 2, coded_count: 2, participant_total: 2, participant_coded: 2,
    })
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    fireEvent.mouseDown(rows[1], { button: 0 })   // Y holds Disruption; X holds Engagement
    fireEvent.click(await screen.findByRole('radio', { name: /Engagement/ }))
    await waitFor(() => expect(selectOnSegment).toHaveBeenCalledWith(62, 3, 7))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled())

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    // Y gets Disruption back; X, which already held Engagement, is left alone.
    await waitFor(() => expect(bulkCode).toHaveBeenCalledWith([62], 8, 'apply'))
    // Re-selecting Disruption through the set's door would fan out and take X's Engagement.
    expect(selectOnSegment).toHaveBeenCalledTimes(1)
    expect(bulkCode).toHaveBeenCalledTimes(1)
  })
})
