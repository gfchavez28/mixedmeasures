/**
 * #968 / #969 — the Content tab's coded passages PAGE, and every section says how
 * much of its list is on screen.
 *
 * #968: *Load more* put a larger limit in the query key — a new query with nothing
 * in hand — so all three sections were replaced by a loading notice until it
 * answered, and the researcher lost their place. #969: the document and clip
 * sections had no Load more and said nothing when their list ended at a page.
 *
 * ⚠️ The page size is mocked to 2 (`CONTENT_PAGE_SIZE`): the rule is the same at
 * any size, and rendering 200 passage cards per page in jsdom is #1040's class.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import type { Code, CodeSegmentsWithContextResponse } from '@/lib/api'
import type { ListStatus } from '@/lib/list-status'

const api = vi.hoisted(() => ({ segmentsWithContext: vi.fn(), textsWithContext: vi.fn() }))
vi.mock('@/lib/api', () => ({
  codeAnalysisApi: {
    segmentsWithContext: api.segmentsWithContext,
    textsWithContext: api.textsWithContext,
  },
}))
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 1, username: 'Ada' }, refreshAuth: vi.fn() }),
}))
vi.mock('@/lib/content-pages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/content-pages')>()
  return { ...actual, CONTENT_PAGE_SIZE: 2 }
})

import ContentByCode from './ContentByCode'
import { mergeContentPages } from '@/lib/content-pages'

const CODES = [
  { id: 10, name: 'Pacing', color: '#3b82f6', is_active: true, is_universal: false },
] as unknown as Code[]

const focal = (id: number, text: string) => ({
  id, sequence_order: id, speaker_name: 'P1', speaker_color_index: 0, speaker_color: null,
  is_facilitator: false, text, start_time: null, end_time: null, is_quoted: false, quote_ranges: [],
  applied_code_ids: [10], preceding_context: [], following_context: [],
  participant_id: null, participant_name: null,
})

function page(
  conv: [number, string][], docs: [number, string][], hasMore: boolean,
): CodeSegmentsWithContextResponse {
  return {
    code_id: 10, code_name: 'Pacing', code_color: null, category_name: null,
    total_segments: 6, conversation_total: 3, document_total: 3, observation_total: 0,
    has_more: hasMore,
    conversations: conv.length
      ? [{ conversation_id: 5, conversation_name: 'Interview 1', segment_count: conv.length,
          segments: conv.map(([id, t]) => focal(id, t)) }]
      : [],
    documents: docs.length
      ? [{ document_id: 8, document_name: 'Handbook', segment_count: docs.length,
          segments: docs.map(([id, t]) => focal(id, t)) }]
      : [],
    observations: [],
  }
}

const PAGE_1 = page([[1, 'turn one'], [2, 'turn two']], [[11, 'para one'], [12, 'para two']], true)
const PAGE_2 = page([[3, 'turn three']], [[13, 'para three']], false)

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ContentByCode
          projectId={1} codes={CODES} codesStatus={'ready' as ListStatus} frequencies={[]}
          selectedContentCodeId={10} onCodeSelect={() => {}} filterParams={{ source: 'all' }}
          source="all" hasConversations hasCommentColumns={false} hasDocuments hasObservations={false}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(cleanup)
beforeEach(() => {
  api.segmentsWithContext.mockReset()
  api.textsWithContext.mockReset()
  api.textsWithContext.mockResolvedValue({ datasets: [], total_texts: 0, has_more: false })
})

describe('#968 — Load more APPENDS, and the rows stay on screen while it runs', () => {
  it('keeps every row through the request, then adds the next page to BOTH sections', async () => {
    let release!: (v: CodeSegmentsWithContextResponse) => void
    api.segmentsWithContext
      .mockResolvedValueOnce(PAGE_1)
      .mockReturnValueOnce(new Promise(r => { release = r }))
    renderTab()
    expect(await screen.findByText('turn one')).toBeInTheDocument()
    expect(screen.getByText('Showing 2 of 3 passages')).toBeInTheDocument()
    expect(screen.getByText('Showing 2 of 3 document segments')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Load more document segments — 1 remaining' }))
    // The page is an OFFSET of the one request behind all three sections.
    await waitFor(() => expect(api.segmentsWithContext).toHaveBeenCalledTimes(2))
    expect(api.segmentsWithContext.mock.calls[1][2]).toMatchObject({ limit: 2, offset: 2 })
    // Nothing was replaced by a loading notice while it ran.
    expect(screen.getByText('turn one')).toBeInTheDocument()
    expect(screen.getByText('para one')).toBeInTheDocument()
    expect(screen.queryByText('Loading coded passages…')).toBeNull()

    await act(async () => { release(PAGE_2) })
    expect(await screen.findByText('turn three')).toBeInTheDocument()
    expect(screen.getByText('para three')).toBeInTheDocument()
    expect(screen.getByText('All 3 passages loaded')).toBeInTheDocument()
    expect(screen.getByText('All 3 document segments loaded')).toBeInTheDocument()
    // One group, continued — not a second "Interview 1" card.
    expect(screen.getAllByText('Interview 1')).toHaveLength(1)
  })

  it('a next page that FAILS keeps the rows and says so beside the button', async () => {
    api.segmentsWithContext
      .mockResolvedValueOnce(PAGE_1)
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }))
    renderTab()
    await screen.findByText('turn one')
    fireEvent.click(screen.getByRole('button', { name: 'Load more passages — 1 remaining' }))
    expect(await screen.findByText(/the next passages could not be loaded/)).toBeInTheDocument()
    expect(screen.getByText('turn one')).toBeInTheDocument()
  })

  it('#969 — a section of one page says nothing about paging', async () => {
    api.segmentsWithContext.mockResolvedValueOnce({
      ...page([[1, 'turn one']], [[11, 'para one']], false),
      conversation_total: 1, document_total: 1, total_segments: 2,
    })
    renderTab()
    await screen.findByText('turn one')
    expect(screen.queryByText(/loaded$/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Load more/ })).toBeNull()
  })
})

describe('#968 review — the search line names what was searched', () => {
  it('says the search ran over the LOADED rows while more remain', async () => {
    api.segmentsWithContext.mockResolvedValueOnce(PAGE_1)
    renderTab()
    await screen.findByText('turn one')
    fireEvent.change(screen.getByPlaceholderText('Search segments and texts…'), { target: { value: 'two' } })
    expect(await screen.findByText(
      '1 match among the 2 loaded of 3 passages — load more to search the rest',
    )).toBeInTheDocument()
  })
})

describe('mergeContentPages', () => {
  it('continues a group across pages, in first-seen order, and drops a repeated row', () => {
    const merged = mergeContentPages([
      PAGE_1,
      // A coding added between two requests can shift a row onto the next page.
      page([[2, 'turn two'], [3, 'turn three']], [[13, 'para three']], false),
    ])!
    expect(merged.conversations).toHaveLength(1)
    expect(merged.conversations[0].segments.map(s => s.id)).toEqual([1, 2, 3])
    expect(merged.conversations[0].segment_count).toBe(3)
    expect(merged.documents[0].segments.map(s => s.id)).toEqual([11, 12, 13])
    expect(merged.has_more).toBe(false)   // the LAST page's
  })
})
