/**
 * #1324 — overlapping and nested quotes are ALLOWED (decided 2026-10-31), so the
 * transcript row must draw every character of the turn exactly ONCE whatever quote
 * set it carries.
 *
 * Before the fix `renderTextWithExcerpts` walked the quotes in start order and set
 * `lastEnd = end`, which moves BACKWARDS for a nested quote, so the shared words were
 * drawn twice. The duplicated text is what `lib/text-offsets.ts::charOffsetInElement`
 * reads, so every later selection in that turn landed on other words — and the row's
 * accessible name (role="option" is name-from-content) read the passage twice too.
 *
 * ⚠️ Written over a SEEDED random population, with astral text, rather than the four
 * hand-picked shapes: the defect is a property of the rendering ("each character
 * once"), and a property is only pinned by a population. The hand-picked shapes below
 * are the filed ones, kept so a failure names something a person can picture.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import SegmentRow from './SegmentRow'
import type { Segment } from '@/lib/api'
import { charOffsetInElement, codePointLength, sliceByCodePoints } from '@/lib/text-offsets'
import { mulberry32, randomQuoteSet } from '@/test-support/seeded-random'
import { quoteRunClass, quoteLabel } from '@/lib/quote-runs'

vi.mock('@/lib/theme-context', () => ({
  useTheme: () => ({ isDark: false, mode: 'light', setMode: vi.fn() }),
}))

type Q = { id: number; start_offset: number | null; end_offset: number | null; has_note?: boolean; note_preview?: string | null }

function makeSegment(text: string, excerpts: Q[]): Segment {
  return {
    id: 1,
    conversation_id: 7,
    text,
    speaker_id: 3,
    speaker_name: 'P1',
    speaker_color: null,
    speaker_color_index: 0,
    speaker_is_facilitator: false,
    sequence_order: 2,
    start_time: 73,
    end_time: 88,
    applied_codes: [],
    applied_code_details: [],
    excerpts: excerpts.map(e => ({ has_note: false, note_id: null, note_preview: null, ...e })),
    attached_notes: [],
  } as unknown as Segment
}

function renderRow(text: string, excerpts: Q[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const utils = render(
    <QueryClientProvider client={qc}>
      <SegmentRow
        segment={makeSegment(text, excerpts)}
        isSelected={false}
        isUncoded={false}
        onClick={vi.fn()}
        conversationId={7}
        codes={[]}
        codesStatus="ready"
        positionInSet={1}
        setSize={1}
      />
    </QueryClientProvider>,
  )
  const textEl = utils.container.querySelector('[data-segment-id="1"]') as HTMLElement
  return { ...utils, textEl }
}

afterEach(cleanup)

// 47 code points, ASCII — the filed shapes are [4,23), [15,34), [0,47), [10,14).
const TURN = 'We rolled it out in March and nobody was ready.'

describe('#1324 — the filed shapes draw each character once', () => {
  it.each([
    ['two overlapping quotes', [{ id: 1, start_offset: 4, end_offset: 23 }, { id: 2, start_offset: 15, end_offset: 34 }]],
    ['a nested quote', [{ id: 1, start_offset: 0, end_offset: 47 }, { id: 2, start_offset: 10, end_offset: 14 }]],
    ['all four filed ranges', [
      { id: 1, start_offset: 4, end_offset: 23 }, { id: 2, start_offset: 15, end_offset: 34 },
      { id: 3, start_offset: 0, end_offset: 47 }, { id: 4, start_offset: 10, end_offset: 14 },
    ]],
    ['two quotes sharing a start', [{ id: 1, start_offset: 3, end_offset: 30 }, { id: 2, start_offset: 3, end_offset: 12 }]],
    ['two quotes sharing an end', [{ id: 1, start_offset: 3, end_offset: 30 }, { id: 2, start_offset: 20, end_offset: 30 }]],
  ])('%s', (_label, quotes) => {
    expect(codePointLength(TURN)).toBe(47)
    const { textEl } = renderRow(TURN, quotes)
    expect(textEl.textContent).toBe(TURN)
  })

  it('the row\'s accessible name carries the passage once, not twice', () => {
    renderRow(TURN, [{ id: 1, start_offset: 0, end_offset: 47 }, { id: 2, start_offset: 10, end_offset: 14 }])
    const option = screen.getByRole('option')
    // role="option" is name-from-content: the duplicated words were in the NAME.
    const name = option.textContent ?? ''
    expect(name.split('nobody').length - 1).toBe(1)
  })
})

describe('#1324 — nothing but the passage sits in the text element', () => {
  /**
   * WIDENED past the filed entry: the shared `TooltipContent` renders IN PLACE, so a
   * quote's note tooltip, while open, put its preview — twice, with Radix's
   * visually-hidden copy — inside `[data-segment-id]`. One quote with a note was
   * enough; no overlap needed. Measured on HEAD:
   * "We rolledNOTE-PREVIEWNOTE-PREVIEW it out in March…".
   */
  it('an OPEN note tooltip leaves the rendered text equal to the stored text', async () => {
    const { textEl } = renderRow(TURN, [
      { id: 1, start_offset: 3, end_offset: 9, has_note: true, note_preview: 'NOTE-PREVIEW' },
    ])
    const mark = textEl.querySelector('mark')!
    vi.useFakeTimers()
    fireEvent.pointerMove(mark, { pointerType: 'mouse' })
    await act(async () => { vi.advanceTimersByTime(1000) })
    vi.useRealTimers()
    // Positive control: the tooltip really opened (else this passes by not opening).
    expect(screen.getAllByText('NOTE-PREVIEW').length).toBeGreaterThan(0)
    expect(textEl.textContent).toBe(TURN)
  })
})

describe('#1324 — the overlap is visible and nameable', () => {
  it('the words under two quotes are one highlight carrying both, drawn deeper than one', () => {
    const { textEl } = renderRow(TURN, [
      { id: 1, start_offset: 0, end_offset: 47 }, { id: 2, start_offset: 10, end_offset: 14 },
    ])
    const marks = [...textEl.querySelectorAll('mark')]
    expect(marks.map(m => [m.textContent, m.getAttribute('data-quote-ids')])).toEqual([
      ['We rolled ', '1'], ['it o', '1 2'], ['ut in March and nobody was ready.', '1'],
    ])
    // Compare the DEPTH recipe, not the whole class string: the outer runs also carry
    // their edge rounding, so "different className" passes at equal depth (a mutant
    // giving every depth one tint survived that weaker form).
    const classes = (el: Element) => el.className.split(/\s+/)
    expect(classes(marks[1])).toEqual(expect.arrayContaining(quoteRunClass(2).split(' ')))
    expect(classes(marks[0])).toEqual(expect.arrayContaining(quoteRunClass(1).split(' ')))
    expect(quoteRunClass(2)).not.toBe(quoteRunClass(1))
  })

  it('hovering words under two quotes names BOTH quotes, with each one\'s note', async () => {
    // Crossing and nested pairs draw the same tints; the words are what tell them apart.
    const { textEl } = renderRow(TURN, [
      { id: 1, start_offset: 4, end_offset: 23, has_note: true, note_preview: 'OUTER-NOTE' },
      { id: 2, start_offset: 15, end_offset: 34 },
    ])
    const shared = [...textEl.querySelectorAll('mark')].find(m => m.getAttribute('data-quote-ids') === '1 2')!
    vi.useFakeTimers()
    fireEvent.pointerMove(shared, { pointerType: 'mouse' })
    await act(async () => { vi.advanceTimersByTime(1000) })
    vi.useRealTimers()
    const tip = screen.getAllByText(/2 quotes overlap here/)[0].parentElement!
    expect(tip.textContent).toContain(`“${TURN.slice(4, 23)}”`)
    expect(tip.textContent).toContain(`“${TURN.slice(15, 34)}”`)
    expect(tip.textContent).toContain('OUTER-NOTE')
    expect(textEl.textContent).toBe(TURN)
  })

  it('the row menu names two nested quotes that share a start differently', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <SegmentRow
          segment={makeSegment(TURN, [
            { id: 1, start_offset: 0, end_offset: 47 }, { id: 2, start_offset: 0, end_offset: 36 },
          ])}
          isSelected
          isUncoded={false}
          onClick={vi.fn()}
          conversationId={7}
          codes={[]}
          codesStatus="ready"
          positionInSet={1}
          setSize={1}
          onDeleteExcerpt={vi.fn()}
        />
      </QueryClientProvider>,
    )
    fireEvent.contextMenu(screen.getByRole('option'))
    const items = screen.getAllByRole('menuitem').map(i => i.textContent ?? '').filter(t => t.startsWith('Remove Excerpt'))
    expect(items).toHaveLength(2)
    expect(new Set(items).size).toBe(2)
  })

  it('both of the menu\'s quote lists name the quotes in passage order, outer first (D25)', () => {
    // The server's order (by id) is inner-first here, so a list that is not sorted
    // reads differently from one that is. The prototype sorted only the Remove list.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <SegmentRow
          segment={makeSegment(TURN, [
            { id: 1, start_offset: 10, end_offset: 14 },
            { id: 2, start_offset: 0, end_offset: 36 },
            { id: 3, start_offset: 0, end_offset: 47 },
          ])}
          isSelected
          isUncoded={false}
          onClick={vi.fn()}
          conversationId={7}
          codes={[]}
          codesStatus="ready"
          positionInSet={1}
          setSize={1}
          onDeleteExcerpt={vi.fn()}
          onAddNoteToExcerpt={vi.fn()}
        />
      </QueryClientProvider>,
    )
    fireEvent.contextMenu(screen.getByRole('option'))
    const texts = screen.getAllByRole('menuitem').map(i => i.textContent ?? '')
    const quoted = (prefix: string) =>
      texts.filter(t => t.startsWith(prefix)).map(t => t.slice(prefix.length))
    const removeList = quoted('Remove Excerpt: ')
    const noteList = quoted('Add Note to Excerpt: ')
    const outerFirst = [[0, 47], [0, 36], [10, 14]].map(([s, e]) => `“${quoteLabel(TURN, s, e)}”`)
    expect(removeList).toEqual(outerFirst)
    expect(noteList).toEqual(outerFirst)
  })
})

describe('#1324 — PROPERTY: rendered text == stored text over random quote sets', () => {
  // Astral on purpose (#687): offsets are CODE POINTS and the DOM reads UTF-16, so a
  // run boundary that slices in the wrong basis splits a surrogate pair. Mirrors
  // backend/tests/test_text_offsets.py::ASTRAL_CASES' characters.
  const TEXTS = [
    TURN,
    'Reaction 😀 then CODE THIS PHRASE and 𠀀 more 👨‍👩‍👧‍👦 at the end 🇺🇸.',
    '😀😀😀😀😀😀😀😀😀😀',
    'Sym 𝐀 Café́ مرحبا नमस्ते สวัสดี 👋🏽 done',
  ]
  const SEEDS = 120

  it('holds for every seed, and every character resolves back to its stored offset', () => {
    let quotedRuns = 0
    let overlapping = 0
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rnd = mulberry32(seed)
      const text = TEXTS[seed % TEXTS.length]
      const quotes = randomQuoteSet(rnd, codePointLength(text))
      const { textEl, unmount } = renderRow(text, quotes)
      expect(textEl.textContent, `seed ${seed}: ${JSON.stringify(quotes)}`).toBe(text)

      // The producer's view: every DOM position maps to the stored offset of the
      // character after it. Walk every text node and every code-point boundary in it.
      const walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT)
      let expectedCp = 0
      let node: Node | null
      while ((node = walker.nextNode())) {
        const data = (node as Text).data
        let u16 = 0
        for (const ch of data) {
          const cp = charOffsetInElement(textEl, node, u16)
          expect(cp, `seed ${seed}`).toBe(expectedCp)
          expect(sliceByCodePoints(text, cp, cp + 1)).toBe(ch)
          u16 += ch.length
          expectedCp++
        }
      }
      expect(expectedCp).toBe(codePointLength(text))

      quotedRuns += textEl.querySelectorAll('mark').length
      const sorted = [...quotes].sort((a, b) => a.start_offset - b.start_offset)
      if (sorted.some((q, i) => i > 0 && q.start_offset < sorted[i - 1].end_offset)) overlapping++
      unmount()
    }
    // Population floor: a generator that drifted to empty or disjoint sets would pass
    // this property vacuously — the HEAD renderer is correct on disjoint quotes.
    expect(quotedRuns).toBeGreaterThan(SEEDS)
    expect(overlapping).toBeGreaterThan(SEEDS / 2)
  })
})
