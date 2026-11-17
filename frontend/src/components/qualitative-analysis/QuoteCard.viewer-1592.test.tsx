/**
 * #1592 — on the Quote Board, a card's chip offers *Remove code* only where the VIEWER holds that
 * code on the quote, and the `+ Add code` list leaves a code only a colleague applied open.
 *
 * The board's read carried bare `applied_code_ids` (one per application), so the card's chips —
 * the quote's DISTINCT codes — could not be told apart, every one offered a remove, and the
 * remove door deletes the caller's application alone (on a colleague's chip it did nothing, and
 * the toast's *Undo* applied the code as the viewer's). The read now says who applied each
 * (`applied_code_details`, the board's coder scope while blind, #1531 D99).
 *
 * Fixture: the viewer is coder 1, the colleague 2. *Pacing* by both, *Bob theme* by the
 * colleague only, *Legacy* unattributed (merged legacy data — no door can remove it). Both card
 * kinds (a turn and a survey answer). Positive control: viewed as the colleague.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Code, QuotedExcerptItem } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  codingApi: { removeCode: vi.fn(), applyCode: vi.fn() },
  textCodingApi: { removeCode: vi.fn(), applyCode: vi.fn() },
  codesApi: { create: vi.fn() },
}))
vi.mock('react-router', async (orig) => ({ ...(await orig() as object), useNavigate: () => vi.fn() }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))

import QuoteCard from './QuoteCard'

const ME = 1
const COLLEAGUE = 2
const PACING = 20
const BOB = 30
const LEGACY = 40
const CODES = [
  { id: PACING, name: 'Pacing', color: '#22c55e', is_active: true, is_universal: false },
  { id: BOB, name: 'Bob theme', color: '#f97316', is_active: true, is_universal: false },
  { id: LEGACY, name: 'Legacy', color: '#a855f7', is_active: true, is_universal: false },
] as unknown as Code[]

function quote(kind: 'segment' | 'text'): QuotedExcerptItem {
  return {
    excerpt_id: kind === 'segment' ? 1 : 2, source_type: kind,
    segment_id: kind === 'segment' ? 252 : null, dataset_value_id: kind === 'text' ? 101 : null,
    text: `a ${kind} quote`, full_segment_text: `a ${kind} quote`,
    is_sub_segment: false, start_offset: null, end_offset: null, start_time: null, end_time: null,
    segment_start_time: null, segment_end_time: null,
    speaker_name: 'Ana', speaker_is_facilitator: false, participant_id: null, participant_name: null,
    source_name: 'Interview 1', sequence_order: 1,
    conversation_id: kind === 'segment' ? 5 : null, conversation_date: null, conversation_sort_key: 5,
    document_id: null, document_name: null, observation_id: null, observation_name: null,
    dataset_id: null, dataset_name: null, column_id: null, column_name: null,
    // One per APPLICATION, as the board's read sends them.
    applied_code_ids: [PACING, PACING, BOB, LEGACY],
    applied_codes: [],
    applied_code_details: [
      { code_id: PACING, user_id: ME },
      { code_id: PACING, user_id: COLLEAGUE },
      { code_id: BOB, user_id: COLLEAGUE },
      { code_id: LEGACY, user_id: null },
    ],
    excerpt_note: null, context_before: null, context_before_speaker: null,
    created_at: '2026-11-08T00:00:00+00:00',
  }
}

function renderCard(excerpt: QuotedExcerptItem, viewerId: number | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <QuoteCard
        viewerId={viewerId}
        excerpt={excerpt}
        projectId={1}
        density="quote"
        showNotes={false}
        showCodes
        showSpeaker={false}
        onUnquote={vi.fn()}
        onCopy={vi.fn()}
        allCodes={CODES}
        codesStatus="ready"
        onCodeChange={vi.fn()}
      />
    </QueryClientProvider>,
  )
}

const removes = (name: string) => screen.queryAllByRole('button', { name: `Remove code ${name}` })

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('Quote Board: a remove only where the viewer holds the code (#1592)', () => {
  for (const kind of ['segment', 'text'] as const) {
    it(`a ${kind} card: the shared code keeps ONE remove; the colleague-only and the unattributed have none`, () => {
      renderCard(quote(kind), ME)
      // One chip per distinct code, as before — the two Pacing applications are one chip.
      expect(screen.getAllByText('Pacing')).toHaveLength(1)
      expect(screen.getByText('Bob theme')).toBeInTheDocument()
      expect(screen.getByText('Legacy')).toBeInTheDocument()
      expect(removes('Pacing')).toHaveLength(1)
      expect(removes('Bob theme')).toHaveLength(0)
      expect(removes('Legacy')).toHaveLength(0)
    })
  }

  it('positive control: viewed as the colleague, their two codes offer a remove', () => {
    renderCard(quote('segment'), COLLEAGUE)
    expect(removes('Pacing')).toHaveLength(1)
    expect(removes('Bob theme')).toHaveLength(1)
    expect(removes('Legacy')).toHaveLength(0)
  })

  it('the add list leaves the colleague-only code open to the viewer, and marks the viewer’s own', () => {
    renderCard(quote('segment'), ME)
    fireEvent.click(screen.getByRole('button', { name: 'Add code' }))
    const list = screen.getByRole('dialog', { name: 'Add a code' })
    expect(within(list).getByRole('button', { name: 'Bob theme' })).toBeEnabled()
    expect(within(list).getByRole('button', { name: 'Legacy' })).toBeEnabled()
    expect(within(list).getByRole('button', { name: 'Pacing' })).toBeDisabled()
  })
})
