/**
 * #1592 — on *By Code*, a chip offers *Remove code* only where the VIEWER holds that code, and the
 * `+ Add code` list leaves a code only a colleague applied open to the viewer.
 *
 * The four lists (turns, answers, document passages, clips) carried bare `applied_code_ids`, so
 * the chips could not be told apart and every one offered a remove — and the remove door deletes
 * the CALLER's application alone (`routers/coding.py::remove_code`), so on a colleague's chip it
 * removed nothing, silently, and its toast's *Undo* applied the code as the viewer's. Each unit
 * now says who applied each code (`applied_code_details`), and the mounts pass it.
 *
 * Fixture: the viewer is coder 1, the colleague coder 2. The focus code (10, excluded from the
 * chips) plus *Pacing* (20, both coders) and *Bob theme* (30, the colleague only), on one unit
 * of each of the four kinds. Positive control: viewed as the colleague, every chip they hold
 * offers its remove.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import type { Code, CodeSegmentsWithContextResponse, CodeTextsResponse } from '@/lib/api'
import type { ListStatus } from '@/lib/list-status'

const api = vi.hoisted(() => ({ segmentsWithContext: vi.fn(), textsWithContext: vi.fn() }))
vi.mock('@/lib/api', () => ({
  codeAnalysisApi: { segmentsWithContext: api.segmentsWithContext, textsWithContext: api.textsWithContext },
  codingApi: { removeCode: vi.fn(), applyCode: vi.fn() },
  textCodingApi: { removeCode: vi.fn(), applyCode: vi.fn() },
  codesApi: { create: vi.fn() },
}))
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 1, username: 'Ada' }, refreshAuth: vi.fn() }),
}))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))

import ContentByCode from './ContentByCode'

const ME = 1
const COLLEAGUE = 2
const FOCUS = 10
const PACING = 20
const BOB = 30
const CODES = [
  { id: FOCUS, name: 'Focus', color: '#3b82f6', is_active: true, is_universal: false },
  { id: PACING, name: 'Pacing', color: '#22c55e', is_active: true, is_universal: false },
  { id: BOB, name: 'Bob theme', color: '#f97316', is_active: true, is_universal: false },
] as unknown as Code[]

const CODE_IDS = [FOCUS, PACING, BOB]
const DETAILS = [
  { code_id: FOCUS, user_id: ME },
  { code_id: PACING, user_id: ME },
  { code_id: PACING, user_id: COLLEAGUE },
  { code_id: BOB, user_id: COLLEAGUE },
]

const focal = (id: number, text: string) => ({
  id, sequence_order: id, speaker_name: 'P1', speaker_color_index: 0, speaker_color: null,
  is_facilitator: false, text, start_time: 1, end_time: 2, is_quoted: false, quote_ranges: [],
  applied_code_ids: CODE_IDS, applied_code_details: DETAILS, preceding_context: [], following_context: [],
  participant_id: null, participant_name: null,
})

const SEGMENTS: CodeSegmentsWithContextResponse = {
  code_id: FOCUS, code_name: 'Focus', code_color: null, category_name: null,
  total_segments: 3, conversation_total: 1, document_total: 1, observation_total: 1, has_more: false,
  conversations: [{ conversation_id: 5, conversation_name: 'Interview 1', segment_count: 1, segments: [focal(1, 'a turn')] }],
  documents: [{ document_id: 8, document_name: 'Handbook', segment_count: 1, segments: [focal(11, 'a paragraph')] }],
  observations: [{
    observation_id: 9, observation_name: 'Session 1', media_duration_seconds: 60, segment_count: 1,
    segments: [focal(21, 'a clip')],
  }],
}

const TEXTS: CodeTextsResponse = {
  code_id: FOCUS, code_name: 'Focus', code_color: null, category_name: null, total_texts: 1, has_more: false,
  datasets: [{
    dataset_id: 3, dataset_name: 'Survey', text_count: 1,
    texts: [{
      dataset_value_id: 101, value_text: 'an answer', word_count: 2, row_identifier: 'R1',
      dataset_name: 'Survey', column_name: 'Q1', applied_code_ids: CODE_IDS, applied_code_details: DETAILS,
      counted_as_no_response: false,
    }],
  }],
}

function renderTab(viewerId: number | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ContentByCode
          viewerId={viewerId}
          projectId={1} codes={CODES} allCodes={CODES} codesStatus={'ready' as ListStatus} frequencies={[]}
          selectedContentCodeId={FOCUS} onCodeSelect={() => {}} filterParams={{ source: 'all' }}
          source="all" hasConversations hasCommentColumns hasDocuments hasObservations
          chipsFollowCoderIds={false} onCodeChange={vi.fn()}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const removes = (name: string) => screen.queryAllByRole('button', { name: `Remove code ${name}` })

afterEach(() => { cleanup(); vi.clearAllMocks() })
beforeEach(() => {
  api.segmentsWithContext.mockResolvedValue(SEGMENTS)
  api.textsWithContext.mockResolvedValue(TEXTS)
})

describe('By Code: a remove only where the viewer holds the code (#1592)', () => {
  it('on all four lists, the shared code keeps one remove and the colleague-only code has none', async () => {
    renderTab(ME)
    expect(await screen.findByText('an answer')).toBeInTheDocument()
    expect(screen.getByText('a clip')).toBeInTheDocument()
    // Every chip is still drawn on each of the four units — only the control moved.
    expect(screen.getAllByText('Bob theme')).toHaveLength(4)
    expect(removes('Pacing')).toHaveLength(4)
    expect(removes('Bob theme')).toHaveLength(0)
  })

  it('positive control: viewed as the colleague, every chip they hold offers its remove', async () => {
    renderTab(COLLEAGUE)
    expect(await screen.findByText('an answer')).toBeInTheDocument()
    expect(removes('Pacing')).toHaveLength(4)
    expect(removes('Bob theme')).toHaveLength(4)
  })

  it('a viewer not known offers no remove anywhere', async () => {
    renderTab(null)
    expect(await screen.findByText('an answer')).toBeInTheDocument()
    expect(screen.queryAllByRole('button', { name: /^Remove code/ })).toHaveLength(0)
  })

  it('the add list leaves the colleague-only code open to the viewer, and marks the viewer’s own', async () => {
    renderTab(ME)
    expect(await screen.findByText('an answer')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'Add code' })[0])
    const list = screen.getByRole('dialog', { name: 'Add a code' })
    expect(within(list).getByRole('button', { name: 'Bob theme' })).toBeEnabled()
    expect(within(list).getByRole('button', { name: 'Pacing' })).toBeDisabled()
  })
})
