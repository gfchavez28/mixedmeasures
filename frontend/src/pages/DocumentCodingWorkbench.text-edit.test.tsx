/**
 * #1319 on the document workbench — a paragraph edit carries its quotes.
 *
 * Same flow as the conversation workbench (`hooks/useTextEditSave`), plus the one
 * thing only this editor does: it saves on BLUR, and the quotes dialog opening
 * blurs it. That second save must not start a second preview, and the editor must
 * survive it with the typed text.
 *
 * Harness mirrors `DocumentCodingWorkbench.test.tsx`; a separate file so the two
 * can grow independently.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import { VirtuosoMockContext } from 'react-virtuoso'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { DocumentDetailResponse, DocumentSegmentResponse } from '@/lib/api'
import type { TextEditPlan, TextEditQuote } from '@/lib/api/segments'

const getDetail = vi.fn()
const listDocuments = vi.fn()
const listNotes = vi.fn()
const listCodes = vi.fn()
const listCategories = vi.fn()
const listCoders = vi.fn()
const listExcerpts = vi.fn()
const coderCoverage = vi.fn()
const previewSegmentEdit = vi.fn()
const updateSegment = vi.fn()
const createExcerpt = vi.fn()

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    documentsApi: {
      ...actual.documentsApi,
      getDetail: (...a: unknown[]) => getDetail(...a),
      list: (...a: unknown[]) => listDocuments(...a),
      listNotes: (...a: unknown[]) => listNotes(...a),
      previewSegmentEdit: (...a: unknown[]) => previewSegmentEdit(...a),
      updateSegment: (...a: unknown[]) => updateSegment(...a),
    },
    codesApi: { ...actual.codesApi, list: (...a: unknown[]) => listCodes(...a) },
    categoriesApi: { ...actual.categoriesApi, list: (...a: unknown[]) => listCategories(...a) },
    authApi: { ...actual.authApi, listCoders: (...a: unknown[]) => listCoders(...a) },
    excerptsApi: {
      ...actual.excerptsApi,
      list: (...a: unknown[]) => listExcerpts(...a),
      create: (...a: unknown[]) => createExcerpt(...a),
    },
    codeAnalysisApi: { ...actual.codeAnalysisApi, coderCoverage: (...a: unknown[]) => coderCoverage(...a) },
  }
})

vi.mock('@/layouts/ProjectLayout', () => ({
  useProjectLayout: () => ({ projectId: 1, setBreadcrumbLabel: vi.fn(), openCodebook: vi.fn() }),
}))

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 1, username: 'Alice' }, refreshAuth: vi.fn() }),
}))

import DocumentCodingWorkbench from './DocumentCodingWorkbench'

const OLD = 'The new policy was not popular with staff.'
const NEW = 'The policy was not popular.'

const segment = (id: number, order: number, text: string): DocumentSegmentResponse => ({
  id, sequence_order: order, text, word_count: text.split(' ').length,
  page_number: null, heading_level: null, codes: [], has_note: false,
  attached_notes: [], excerpt_info: { has_whole_segment: false, sub_segment_count: 1 },
  merged_into_id: null, is_merge_result: 0, split_into_id: null, is_split_result: 0,
})

const DOC: DocumentDetailResponse = {
  id: 5, name: 'Field notes', description: null,
  source_format: 'docx', segmentation_mode: 'paragraph',
  segment_count: 2, coded_segment_count: 0, page_count: null,
  created_at: '2026-09-02T00:00:00+00:00', updated_at: '2026-09-02T00:00:00+00:00',
  participant_id: null, participant_label: null,
  segments: [segment(51, 0, OLD), segment(52, 1, 'The second paragraph.')],
  image_positions: [],
}

const quote = (over: Partial<TextEditQuote>): TextEditQuote => ({
  excerpt_id: 400, outcome: 'silent', old_start: 19, old_end: 30, new_start: 15, new_end: 26,
  old_text: 'not popular', new_text: 'not popular', has_note: false, removed: false, explicit: false,
  ...over,
})
const SILENT = quote({})
const GONE = quote({
  excerpt_id: 401, outcome: 'gone', old_start: 31, old_end: 41, new_start: null, new_end: null,
  old_text: 'with staff', new_text: null,
})
const PREVIEW: TextEditPlan = {
  text: NEW, quotes: [SILENT, GONE], needs_confirmation: true, collisions: [], capped: false,
}
const REPORT: TextEditPlan = {
  ...PREVIEW, needs_confirmation: false, quotes: [SILENT, { ...GONE, removed: true }],
}

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

async function editParagraph(index: number, text: string) {
  const rows = await screen.findAllByRole('option')
  fireEvent.doubleClick(rows[index])
  const box = await screen.findByRole('textbox', { name: 'Edit segment text' })
  fireEvent.change(box, { target: { value: text } })
  return box
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
  listCodes.mockResolvedValue({ codes: [], total: 0 })
  listCategories.mockResolvedValue({ categories: [] })
  listCoders.mockResolvedValue([{ id: 1, username: 'Alice', display_color: null, archived: false }])
  listExcerpts.mockResolvedValue({ excerpts: [], total: 0 })
  coderCoverage.mockResolvedValue({ coders: [], count: 0 })
  previewSegmentEdit.mockResolvedValue(PREVIEW)
  updateSegment.mockResolvedValue({ id: 51, text: NEW, word_count: 5, quote_rebase: REPORT })
  createExcerpt.mockResolvedValue({ id: 999 })
})

afterEach(cleanup)

describe('#1319 — a paragraph edit on the document workbench', () => {
  it('the blur the dialog causes does not start a second save, and Cancel keeps the typed text', async () => {
    renderWorkbench()
    const box = await editParagraph(0, NEW)
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true })
    const dialog = await screen.findByRole('alertdialog', { name: 'This edit changes quoted words' })
    // The editor saves on blur; the dialog taking focus is exactly that.
    fireEvent.blur(screen.getByRole('textbox', { name: 'Edit segment text', hidden: true }))
    await new Promise(r => setTimeout(r, 0))
    expect(previewSegmentEdit).toHaveBeenCalledTimes(1)
    expect(previewSegmentEdit).toHaveBeenCalledWith(1, 5, 51, NEW)
    expect(dialog).toHaveAccessibleDescription(/“with staff”.*removed/)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(screen.getByRole('textbox', { name: 'Edit segment text' })).toHaveValue(NEW)
    expect(updateSegment).not.toHaveBeenCalled()
  })

  it('remove saves with the gone quote named, then closes the editor and says Saved', async () => {
    renderWorkbench()
    const box = await editParagraph(0, NEW)
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true })
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove the quote and save' }))
    await waitFor(() => expect(updateSegment).toHaveBeenCalledWith(1, 5, 51, {
      text: NEW, remove_excerpt_ids: [401], excerpt_offsets: [],
    }))
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Edit segment text' })).not.toBeInTheDocument())
    expect(screen.getByText('Saved')).toBeInTheDocument()
  })

  it('a refused save keeps the editor open with the typed text and never says Saved', async () => {
    previewSegmentEdit.mockResolvedValue({ ...PREVIEW, quotes: [SILENT], needs_confirmation: false })
    updateSegment.mockRejectedValue(Object.assign(new Error('refused'), {
      status: 409, response: { data: { detail: { message: 'nothing was changed' } } },
    }))
    renderWorkbench()
    const box = await editParagraph(0, NEW)
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(updateSegment).toHaveBeenCalled())
    await new Promise(r => setTimeout(r, 0))
    expect(screen.getByRole('textbox', { name: 'Edit segment text' })).toHaveValue(NEW)
    expect(screen.queryByText('Saved')).not.toBeInTheDocument()
  })

  it('act → move to another paragraph → undo restores THAT paragraph and re-creates the removed quote', async () => {
    renderWorkbench()
    const box = await editParagraph(0, NEW)
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true })
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove the quote and save' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled())

    const rows = await screen.findAllByRole('option')
    fireEvent.mouseDown(rows[1], { button: 0 })
    updateSegment.mockClear()
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })

    await waitFor(() => expect(updateSegment).toHaveBeenCalledWith(1, 5, 51, {
      text: OLD,
      excerpt_offsets: [{ excerpt_id: 400, start_offset: 19, end_offset: 30 }],
      remove_excerpt_ids: [],
    }))
    await waitFor(() => expect(createExcerpt).toHaveBeenCalledWith(1, {
      segment_id: 51, start_offset: 31, end_offset: 41,
    }))
  })
})
