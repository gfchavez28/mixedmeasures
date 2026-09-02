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
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
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
  status: 'in_progress', summary: null,
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
