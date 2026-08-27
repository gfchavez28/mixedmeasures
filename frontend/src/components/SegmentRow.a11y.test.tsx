/**
 * #785 / #790 — the transcript row's own controls.
 *
 * ⚠️ **Written as a POPULATION assertion on purpose.** #771's rule has now shipped
 * partial three times, every time because the guard named the controls somebody had
 * thought of: the observations Delete, then the shared `InlineCodeActions`, then this
 * row's quote gutter and note badges. *Every* button in an unselected row must be out of
 * the tab order — asserting the set, not its members, is the only form that catches the
 * fourth control before a user does.
 *
 * ⚠️ **The fixture carries notes AND a quote for a reason.** The filed measurement for
 * #785 said "20 rows, 20 stops, one per row" — taken on a conversation with no notes, so
 * the note-badge arm never rendered and was invisible to the count. The real cost is
 * **1 + N** per segment. A fixture that does not render an arm cannot measure it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import SegmentRow from './SegmentRow'
import type { Segment } from '@/lib/api'

// The row only reads `isDark` for speaker tints; the real provider touches
// localStorage, which this environment does not supply.
vi.mock('@/lib/theme-context', () => ({
  useTheme: () => ({ isDark: false, mode: 'light', setMode: vi.fn() }),
}))

/** A segment carrying BOTH extra arms: two notes and a whole-segment quote. */
function makeSegment(over: Partial<Segment> = {}): Segment {
  return {
    id: 1,
    conversation_id: 7,
    text: 'What made the implementation uneven?',
    speaker_id: 3,
    speaker_name: 'Facilitator',
    speaker_color: null,
    speaker_color_index: 0,
    speaker_is_facilitator: true,
    sequence_order: 2,
    start_time: 73,
    end_time: 88,
    applied_codes: [],
    applied_code_details: [],
    excerpts: [],
    attached_notes: [
      { id: 11, sequence_number: 1 },
      { id: 12, sequence_number: 2 },
    ],
    ...over,
  } as unknown as Segment
}

function renderRow(over: Partial<Segment> = {}, isSelected = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const utils = render(
    <QueryClientProvider client={qc}>
      <>
        <SegmentRow
          segment={makeSegment(over)}
          isSelected={isSelected}
          onClick={vi.fn()}
          conversationId={7}
          codes={[]}
          positionInSet={3}
          setSize={20}
          onToggleQuote={vi.fn()}
          onNoteClick={vi.fn()}
        />
      </>
    </QueryClientProvider>
  )
  return utils
}

afterEach(cleanup)

describe('#785 — an unselected transcript row costs no tab stops', () => {
  it('EVERY button in an unselected row is out of the tab order', () => {
    renderRow()
    const row = screen.getByRole('option')

    const buttons = within(row).getAllByRole('button')
    // The fixture must actually render the arms, or this passes vacuously —
    // which is precisely how the filed count came in low.
    expect(buttons.length).toBeGreaterThanOrEqual(3)

    for (const btn of buttons) {
      expect(btn).toHaveAttribute('tabindex', '-1')
    }
  })

  it('the same controls ARE reachable once the row is selected', () => {
    renderRow({}, true)
    const row = screen.getByRole('option')

    const reachable = within(row).getAllByRole('button')
      .filter(b => b.getAttribute('tabindex') !== '-1')
      .map(b => b.getAttribute('aria-label'))

    expect(reachable).toEqual(expect.arrayContaining([
      'Quote segment 3',
      'Note 1 on segment 3',
      'Note 2 on segment 3',
    ]))
  })

  it('names every row control by its segment — twenty identical names name nothing', () => {
    renderRow()
    const row = screen.getByRole('option')
    const names = within(row).getAllByRole('button').map(b => b.getAttribute('aria-label'))

    // `tabindex="-1"` does NOT remove a control from the accessibility tree, so a
    // browse-mode reader still meets all of them — the name has to carry the row.
    for (const name of names) {
      expect(name).toMatch(/segment 3$/)
    }
  })
})

describe('#790 — the quote button announces the state its press actually changes', () => {
  const WHOLE = { id: 90, start_offset: null, end_offset: null, start_time: null, end_time: null }
  const CHAR_RANGE = { id: 91, start_offset: 0, end_offset: 5, start_time: null, end_time: null }

  it('is not pressed with no quotes at all', () => {
    renderRow({ excerpts: [] as never })
    expect(screen.getByRole('button', { name: 'Quote segment 3' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('is pressed for a WHOLE-segment quote — what the toggle deletes', () => {
    renderRow({ excerpts: [WHOLE] as never })
    expect(screen.getByRole('button', { name: 'Quote segment 3' })).toHaveAttribute('aria-pressed', 'true')
  })

  /**
   * 🔴 The defect. The button read `excerpts.length > 0` — shape-AGNOSTIC — while its
   * handler acts on the whole-segment excerpt only. So a segment carrying nothing but a
   * character-range quote announced itself as quoted, and pressing it ADDED a
   * whole-segment quote rather than removing anything. The context menu one screen down,
   * firing the SAME handler, had the shape-exact test all along.
   *
   * ⚠️ NOT live-reproducible on dev.db — no segment there is in this state, and the
   * CSRF token is module-held so one could not be constructed from the page. This test
   * IS the reproduction, which is the right place for it: the state is easy to reach in
   * the product (quote a phrase, never the whole turn) and impossible to stumble on in
   * the fixture.
   */
  it('is NOT pressed for a char-range-only quote — the press would CREATE one', () => {
    renderRow({ excerpts: [CHAR_RANGE] as never })
    expect(screen.getByRole('button', { name: 'Quote segment 3' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('still shows the amber fill for a char-range quote — display stays shape-agnostic', () => {
    // The two facts are deliberately different (#790). The indicator answers "does this
    // segment carry any quote"; the pressed state answers "will this press remove one".
    renderRow({ excerpts: [CHAR_RANGE] as never })
    const btn = screen.getByRole('button', { name: 'Quote segment 3' })
    expect(btn.className).toContain('text-amber-400')
  })
})
