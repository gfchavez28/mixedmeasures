/**
 * #1319 on the conversation workbench — a text edit carries the turn's quotes.
 *
 * Before: the editor closed and "Saved" flashed BEFORE the PATCH resolved, a
 * failed save lost the typed text, and nothing said a quote was about to move.
 * Now: preview → (the quotes dialog, when an edit touches, crosses or removes a
 * quote) → save; the editor stays open with the typed text until the server has
 * answered, and the undo entry carries every quote's captured offsets (#1023: act
 * → move to another turn → undo → the call targets the FIRST turn).
 *
 * Harness mirrors `CodingWorkbench.test.tsx`; a separate file so the two can grow
 * independently.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import { VirtuosoMockContext } from 'react-virtuoso'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ThemeProvider } from '@/lib/theme-context'
import type { Conversation, Segment } from '@/lib/api'
import type { TextEditPlan, TextEditQuote } from '@/lib/api/segments'

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
const listCodeSets = vi.fn()
const previewTextEdit = vi.fn()
const updateSegment = vi.fn()
const createExcerpt = vi.fn()

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    conversationsApi: {
      ...actual.conversationsApi,
      get: (...a: unknown[]) => getConversation(...a),
      list: (...a: unknown[]) => listConversations(...a),
    },
    segmentsApi: {
      ...actual.segmentsApi,
      list: (...a: unknown[]) => listSegments(...a),
      previewTextEdit: (...a: unknown[]) => previewTextEdit(...a),
      updateSegment: (...a: unknown[]) => updateSegment(...a),
    },
    codesApi: { ...actual.codesApi, list: (...a: unknown[]) => listCodes(...a) },
    categoriesApi: { ...actual.categoriesApi, list: (...a: unknown[]) => listCategories(...a) },
    notesApi: { ...actual.notesApi, listForConversation: (...a: unknown[]) => listNotes(...a) },
    speakersApi: { ...actual.speakersApi, list: (...a: unknown[]) => listSpeakers(...a) },
    projectsApi: { ...actual.projectsApi, get: (...a: unknown[]) => getProject(...a) },
    authApi: { ...actual.authApi, listCoders: (...a: unknown[]) => listCoders(...a) },
    excerptsApi: {
      ...actual.excerptsApi,
      list: (...a: unknown[]) => listExcerpts(...a),
      create: (...a: unknown[]) => createExcerpt(...a),
    },
    codeAnalysisApi: { ...actual.codeAnalysisApi, coderCoverage: (...a: unknown[]) => coderCoverage(...a) },
    codeSetsApi: { ...actual.codeSetsApi, list: (...a: unknown[]) => listCodeSets(...a) },
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
  segment_count: 2, coded_segment_count: 0, speaker_count: 1, code_count: 0,
  media_filename: null, media_format: null, media_type: null, media_duration_seconds: null,
  media_offset_seconds: 0, media_is_vbr: null, has_media: false, media_size_bytes: null,
  media_version: null,
}

const OLD = 'Honestly, it was not helpfull at all.'
const NEW = 'Honestly, it was not helpful at all.'

const segment = (id: number, order: number, text: string): Segment => ({
  id, conversation_id: 9, speaker_id: 1, speaker_name: 'P1', is_facilitator: false,
  speaker_color_index: 0, speaker_color: null, sequence_order: order,
  start_time: null, end_time: null, text, group_id: null, excerpts: [],
  applied_codes: [], applied_code_details: [], attached_notes: [],
  is_merged: false, is_split: false, created_at: '2026-09-02T00:00:00+00:00',
})

const SEGMENTS = [segment(51, 0, OLD), segment(52, 1, 'The second turn.')]

const quote = (over: Partial<TextEditQuote>): TextEditQuote => ({
  excerpt_id: 300, outcome: 'silent', old_start: 0, old_end: 8, new_start: 0, new_end: 8,
  old_text: 'Honestly', new_text: 'Honestly', has_note: false, removed: false, explicit: false,
  ...over,
})
const EDGE = quote({
  excerpt_id: 301, outcome: 'edge', old_start: 17, old_end: 29, new_start: 17, new_end: 28,
  old_text: 'not helpfull', new_text: 'not helpful',
})
const SILENT = quote({ excerpt_id: 300 })
const PREVIEW: TextEditPlan = {
  text: NEW, quotes: [SILENT, EDGE], needs_confirmation: true, collisions: [], capped: false,
}
const REPORT: TextEditPlan = {
  ...PREVIEW, needs_confirmation: false, quotes: [SILENT, { ...EDGE, explicit: true }],
}

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

/** Open the turn's text editor and type `text` into it. */
async function editTurn(segmentId: number, text: string) {
  const turn = await waitFor(() => {
    const el = document.querySelector(`[data-segment-id="${segmentId}"]`)
    if (!el) throw new Error('turn not rendered')
    return el
  })
  fireEvent.doubleClick(turn)
  const box = await screen.findByRole('textbox', { name: 'Edit segment text' })
  fireEvent.change(box, { target: { value: text } })
  return box
}

/** A pointer press on a dialog button, as the browser sends it: the open editor's
 *  capture-phase outside-click handler sees the mousedown first. */
function press(button: HTMLElement) {
  fireEvent.mouseDown(button)
  fireEvent.click(button)
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
    segments: SEGMENTS, total: 2, coded_count: 0, participant_total: 2, participant_coded: 0,
  })
  listCodes.mockResolvedValue({ codes: [], total: 0 })
  listCategories.mockResolvedValue({ categories: [] })
  listNotes.mockResolvedValue([])
  listSpeakers.mockResolvedValue([])
  getProject.mockResolvedValue({ id: 1, name: 'Study', description: null })
  listCoders.mockResolvedValue([{ id: 1, username: 'Alice', display_color: null, archived: false }])
  listExcerpts.mockResolvedValue({ excerpts: [], total: 0 })
  coderCoverage.mockResolvedValue({ coders: [], count: 0 })
  listCodeSets.mockResolvedValue({ sets: [] })
  previewTextEdit.mockResolvedValue(PREVIEW)
  updateSegment.mockResolvedValue({ ...SEGMENTS[0], text: NEW, quote_rebase: REPORT })
  createExcerpt.mockResolvedValue({ id: 999 })
})

afterEach(cleanup)

describe('#1319 — a text edit on the conversation workbench', () => {
  it('names the quote it would change, and Cancel goes back to the editor with the typed text', async () => {
    renderWorkbench()
    const box = await editTurn(51, NEW)
    fireEvent.keyDown(box, { key: 'Enter' })

    const dialog = await screen.findByRole('alertdialog', { name: 'This edit changes quoted words' })
    expect(previewTextEdit).toHaveBeenCalledWith(9, 51, NEW)
    expect(dialog).toHaveAccessibleDescription(/“not helpfull”.*“not helpful”/)
    expect(updateSegment).not.toHaveBeenCalled()

    press(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(screen.getByRole('textbox', { name: 'Edit segment text' })).toHaveValue(NEW)
    expect(updateSegment).not.toHaveBeenCalled()
    expect(screen.queryByText('Saved')).not.toBeInTheDocument()
  })

  it('keep as shown saves with the shown span, then closes the editor and says Saved', async () => {
    renderWorkbench()
    const box = await editTurn(51, NEW)
    fireEvent.keyDown(box, { key: 'Enter' })
    const dialog = await screen.findByRole('alertdialog')
    press(within(dialog).getByRole('button', { name: 'Keep as shown and save' }))

    await waitFor(() => expect(updateSegment).toHaveBeenCalledWith(9, 51, {
      text: NEW,
      excerpt_offsets: [{ excerpt_id: 301, start_offset: 17, end_offset: 28 }],
      remove_excerpt_ids: [],
    }))
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Edit segment text' })).not.toBeInTheDocument())
    expect(screen.getByText('Saved')).toBeInTheDocument()
  })

  it('a REFUSED save keeps the editor open with the typed text and never says Saved', async () => {
    previewTextEdit.mockResolvedValue({ ...PREVIEW, quotes: [SILENT], needs_confirmation: false })
    updateSegment.mockRejectedValue(Object.assign(new Error('refused'), {
      status: 409,
      response: { data: { detail: { error: 'quotes_need_confirmation', message: 'nothing was changed' } } },
    }))
    renderWorkbench()
    const box = await editTurn(51, NEW)
    fireEvent.keyDown(box, { key: 'Enter' })

    await waitFor(() => expect(updateSegment).toHaveBeenCalled())
    // Let the refusal settle, then look: still editing, still the typed words.
    await new Promise(r => setTimeout(r, 0))
    expect(screen.getByRole('textbox', { name: 'Edit segment text' })).toHaveValue(NEW)
    expect(screen.queryByText('Saved')).not.toBeInTheDocument()
  })

  it('a failed preview saves nothing and keeps the typed text', async () => {
    previewTextEdit.mockRejectedValue(new TypeError('offline'))
    renderWorkbench()
    const box = await editTurn(51, NEW)
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(previewTextEdit).toHaveBeenCalled())
    await new Promise(r => setTimeout(r, 0))
    expect(updateSegment).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: 'Edit segment text' })).toHaveValue(NEW)
  })

  it('Tab (save, then the speaker editor) does not leave the text editor while the save is undecided', async () => {
    renderWorkbench()
    const box = await editTurn(51, NEW)
    fireEvent.keyDown(box, { key: 'Tab' })
    const dialog = await screen.findByRole('alertdialog')
    // The modal hides the page from the accessibility tree while it is open.
    expect(screen.getByRole('textbox', { name: 'Edit segment text', hidden: true })).toHaveValue(NEW)
    press(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(screen.getByRole('textbox', { name: 'Edit segment text' })).toHaveValue(NEW)
  })

  it('act → move to another turn → undo restores THAT turn with every quote on its captured offsets', async () => {
    renderWorkbench()
    const box = await editTurn(51, NEW)
    fireEvent.keyDown(box, { key: 'Enter' })
    press(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Keep as shown and save' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled())

    // Move the selection to the other turn before undoing.
    const rows = await screen.findAllByRole('option')
    fireEvent.mouseDown(rows[1], { button: 0 })
    updateSegment.mockClear()
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })

    await waitFor(() => expect(updateSegment).toHaveBeenCalledWith(9, 51, {
      text: OLD,
      excerpt_offsets: [
        { excerpt_id: 300, start_offset: 0, end_offset: 8 },
        { excerpt_id: 301, start_offset: 17, end_offset: 29 },
      ],
      remove_excerpt_ids: [],
    }))
  })
})
