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
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'
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

function renderWorkbench() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
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
