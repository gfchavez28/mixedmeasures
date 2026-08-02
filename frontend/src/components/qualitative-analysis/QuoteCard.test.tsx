/**
 * QuoteCard — the FIRST tests for this component (slab 5c).
 *
 * Scoped to what 5c changed and to the defects it fixed: the observation
 * navigation branch (all three affordances were SILENT no-ops for a clip
 * because neither conversation_id nor document_id is set), the unlabeled-clip
 * render + accessible name (which degenerated to the literal
 * "Quoted excerpt: "), the sub-clip quote-range line, and the clip attribution
 * that replaced `source_name`'s interim ` · {timecode}` suffix.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { QuotedExcerptItem } from '@/lib/api'

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }))

vi.mock('react-router', async (orig) => ({
  ...(await orig() as object),
  useNavigate: () => navigateMock,
}))

// The card renders InlineCodeActions/SendToCanvasMenu only when their optional
// callbacks are passed; the tests below omit them, so `@/lib/api` need not be
// mocked at all — the component imports only TYPES from it.
import QuoteCard, { formatAttribution } from './QuoteCard'

afterEach(() => { cleanup(); navigateMock.mockClear() })

/** A quoted excerpt as the wire sends it, defaulting to a whole-clip quote. */
function clipExcerpt(over: Partial<QuotedExcerptItem> = {}): QuotedExcerptItem {
  return {
    excerpt_id: 1, source_type: 'segment', segment_id: 2001, dataset_value_id: null,
    text: 'Small-group transition', full_segment_text: 'Small-group transition',
    is_sub_segment: false, start_offset: null, end_offset: null,
    start_time: null, end_time: null,
    segment_start_time: 65, segment_end_time: 92.4,
    speaker_name: null, speaker_is_facilitator: false,
    participant_id: null, participant_name: null,
    source_name: 'Classroom', sequence_order: 2,
    conversation_id: null, conversation_date: null, conversation_sort_key: null,
    document_id: null, document_name: null,
    observation_id: 7, observation_name: 'Classroom',
    dataset_id: null, dataset_name: null, column_id: null, column_name: null,
    applied_code_ids: [], applied_codes: [],
    excerpt_note: null, context_before: null, context_before_speaker: null,
    created_at: '2026-07-18T00:00:00+00:00',
    ...over,
  }
}

function renderCard(excerpt: QuotedExcerptItem) {
  return render(
    <QuoteCard
      excerpt={excerpt}
      projectId={1}
      density="quote"
      showNotes={false}
      showCodes={false}
      showSpeaker={false}
      onUnquote={vi.fn()}
      onCopy={vi.fn()}
    />,
  )
}

describe('clip navigation (was a silent no-op)', () => {
  it('navigates to the observation workbench, deep-linked at the clip and its start', () => {
    renderCard(clipExcerpt())
    fireEvent.click(screen.getByRole('button', { name: /go to source/i }))
    expect(navigateMock).toHaveBeenCalledWith(
      '/projects/1/observations/7?clip=2001&t=65',
    )
  })

  it('uses the QUOTE’s own start when the excerpt is a sub-clip range', () => {
    renderCard(clipExcerpt({ start_time: 70.5, end_time: 80 }))
    fireEvent.click(screen.getByRole('button', { name: /go to source/i }))
    expect(navigateMock).toHaveBeenCalledWith(
      '/projects/1/observations/7?clip=2001&t=70.5',
    )
  })

  it('routes the Enter key through the same branch', () => {
    renderCard(clipExcerpt())
    fireEvent.keyDown(screen.getByRole('article'), { key: 'Enter' })
    expect(navigateMock).toHaveBeenCalledWith(
      '/projects/1/observations/7?clip=2001&t=65',
    )
  })

  it('still routes a conversation excerpt to its conversation', () => {
    renderCard(clipExcerpt({
      observation_id: null, observation_name: null,
      conversation_id: 3, source_name: 'Interview 1',
      segment_start_time: null, segment_end_time: null,
    }))
    fireEvent.click(screen.getByRole('button', { name: /go to source/i }))
    expect(navigateMock).toHaveBeenCalledWith('/projects/1/conversations/3?segment=2001')
  })
})

describe('an unlabeled clip is never blank', () => {
  it('renders a placeholder naming the range instead of empty quote marks', () => {
    renderCard(clipExcerpt({ text: '', full_segment_text: '' }))
    expect(screen.getByText('Unlabeled clip (1:05.0–1:32.4)')).toBeInTheDocument()
  })

  it('gives the card a real accessible name', () => {
    // It used to announce the literal "Quoted excerpt: " — a blank name.
    renderCard(clipExcerpt({ text: '', full_segment_text: '' }))
    expect(screen.getByRole('article'))
      .toHaveAttribute('aria-label', 'Quoted excerpt: Unlabeled clip (1:05.0–1:32.4)')
  })
})

describe('the quote-range line', () => {
  it('states which moment a sub-clip quote marked', () => {
    renderCard(clipExcerpt({ start_time: 70.5, end_time: 80 }))
    expect(screen.getByText('Quoted 1:10.5–1:20.0')).toBeInTheDocument()
  })

  it('shows no range line for a whole-clip quote, which has none', () => {
    renderCard(clipExcerpt())
    expect(screen.queryByText(/^Quoted /)).not.toBeInTheDocument()
  })
})

describe('formatAttribution for clips', () => {
  it('carries the clip range as real data and calls the unit a Clip', () => {
    // Before 5c the timecode arrived baked into source_name; dropping that
    // suffix without this would have made every clip of one observation read
    // identically.
    expect(formatAttribution(clipExcerpt(), false, true))
      .toBe('Classroom, 1:05.0–1:32.4, Clip 3')
  })

  it('collapses a point-event clip to a single timecode', () => {
    expect(formatAttribution(clipExcerpt({ segment_end_time: 65 }), false, true))
      .toBe('Classroom, 1:05.0, Clip 3')
  })

  it('leaves conversation attribution untouched', () => {
    expect(formatAttribution(clipExcerpt({
      observation_id: null, conversation_id: 3, source_name: 'Interview 1',
      speaker_name: 'Ana',
    }), true, true)).toBe('Ana, Interview 1, Seg 3')
  })
})
