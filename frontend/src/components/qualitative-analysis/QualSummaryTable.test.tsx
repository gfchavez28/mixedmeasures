/**
 * #679 — the summary table's source-kind columns.
 *
 * The table had exactly two hard-coded column groups, `showConv` and
 * `showComment`, with no `showDoc` and no `showObs`. So an observations-only
 * selection rendered "Conv. · % Conv. · Participants · % Part." and no
 * Observations column at all, and its totals row read "Conv. 1, Participants 11"
 * for a selection containing neither — numbers plausible enough on their face
 * that nobody would look twice.
 *
 * Two separate defects are pinned here:
 *   1. the columns present must follow the SELECTION (the payload's source
 *      kinds), not a mode flag;
 *   2. a count and its percentage must come from the SAME payload — the count
 *      used to be re-derived client-side over `sources` while the percentage
 *      came from `frequencies`, which is how a row showed "0" beside "100.0%".
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { TooltipProvider } from '@/components/ui/tooltip'

import QualSummaryTable from './QualSummaryTable'
import type { SourceFrequenciesResponse, SourceKind } from '@/lib/api'

afterEach(cleanup)

/**
 * DERIVED from the wire type, never re-typed here.
 *
 * This alias is what makes the `it.each` below an arity pin rather than four
 * cases in a loop: `KIND_HEADERS` is a `Record<Kind, …>`, so adding a fifth
 * source kind to `SourceKind` fails to COMPILE here until this table's columns
 * are declared for it. A locally re-typed union (which is what this was) is a
 * copy of the predicate, and a copy proves only that *a* set of four kinds
 * renders — never that the wire's set does (#729's re-typed-falsifier finding,
 * and the #515 → #676 lesson: pin the arity, not the variant).
 */
type Kind = SourceKind

/** Header labels each source kind is responsible for putting on screen. */
const KIND_HEADERS: Record<Kind, string[]> = {
  conversation: ['Conv.', '% Conv.', 'Participants', '% Part.'],
  document: ['Docs', '% Docs'],
  observation: ['Obs.', '% Obs.'],
  text_column: ['Texts', '% Texts', 'Records', '% Rec.'],
}

/**
 * #749 — ONE payload. There is no second fixture, and that is the point: the
 * table used to take its per-kind columns from a `frequencies` prop sourced
 * from a differently-scoped endpoint, so a test could hand it a body and a
 * totals row that described different sets of sources. It no longer can.
 */
function payload(
  kinds: Kind[],
  codeOverrides: Partial<SourceFrequenciesResponse['codes'][number]> = {},
): SourceFrequenciesResponse {
  const count = (k: Kind) => kinds.filter(x => x === k).length
  return {
    codes: [{
      id: 1, name: 'blah', color: '#888', category_id: null, category_name: null,
      category_color: null, is_universal: false, numeric_id: 1,
      participant_count: 0, record_count: 0,
      ...codeOverrides,
    }],
    sources: kinds.map((kind, i) => ({
      source_id: i + 1,
      source_type: kind,
      source_label: `${kind} ${i + 1}`,
      total_segments: 10,
      coded_segments: 4,
      total_word_count: 100,
      code_counts: { '1': { count: 4, word_count: 40 } },
      groups: null,
    })),
    totals: {
      total_segments: 10 * kinds.length,
      total_word_count: 100 * kinds.length,
      coded_segments: 4 * kinds.length,
      total_sources: kinds.length,
      total_conversations: count('conversation'),
      total_documents: count('document'),
      total_observations: count('observation'),
      total_text_columns: count('text_column'),
      coded_transcript_segments: 4 * (kinds.length - count('text_column')),
      coded_texts: 4 * count('text_column'),
      total_participants: 0,
      total_records: 0,
      unlinked_speaker_count: 0,
    },
  } as unknown as SourceFrequenciesResponse
}

function renderTable(kinds: Kind[]) {
  return render(
    <TooltipProvider>
      <QualSummaryTable data={payload(kinds)} />
    </TooltipProvider>,
  )
}

const headerNames = () =>
  screen.getAllByRole('columnheader').map(h => h.textContent?.replace(/[↑↓▲▼\s]+$/, '').trim() ?? '')

describe('#679 — columns follow the selection', () => {
  it('gives an observations-only selection Observations columns and no conversation ones', () => {
    renderTable(['observation'])
    const names = headerNames()
    expect(names).toEqual(expect.arrayContaining(['Obs.', '% Obs.']))
    // The reported symptom: these were rendered for a selection containing none.
    expect(names).not.toEqual(expect.arrayContaining(['Conv.']))
    expect(names).not.toEqual(expect.arrayContaining(['Participants']))
  })

  it('gives a conversations-only selection conversation columns and no observation ones', () => {
    renderTable(['conversation'])
    const names = headerNames()
    expect(names).toEqual(expect.arrayContaining(['Conv.', '% Conv.', 'Participants']))
    expect(names).not.toEqual(expect.arrayContaining(['Obs.']))
  })

  it('renders documents as their own group rather than folding them into conversations', () => {
    renderTable(['document'])
    const names = headerNames()
    expect(names).toEqual(expect.arrayContaining(['Docs', '% Docs']))
    expect(names).not.toEqual(expect.arrayContaining(['Conv.']))
  })

  /**
   * The durable pin: derived from the KINDS, not written as four cases. A fifth
   * source kind added to `KIND_HEADERS` fails here until the table learns it —
   * the `test_all_notes_arity.py` shape, which exists because the previous
   * guard pinned the variant and so guaranteed a next instance (#515 → #676).
   */
  it.each(Object.keys(KIND_HEADERS) as Kind[])(
    'every source kind in the payload contributes its own columns: %s',
    (kind) => {
      renderTable([kind])
      const names = headerNames()
      for (const header of KIND_HEADERS[kind]) {
        expect(names).toContain(header)
      }
    },
  )

  it('shows every kind when all four are selected', () => {
    renderTable(['conversation', 'document', 'observation', 'text_column'])
    const names = headerNames()
    for (const headers of Object.values(KIND_HEADERS)) {
      for (const h of headers) expect(names).toContain(h)
    }
  })
})

/**
 * #749 — the per-kind columns come from `sources`, and the two grains that
 * cannot be derived from `sources` come from `codes`.
 *
 * #679 pinned the opposite: that the per-kind counts came from the SECOND
 * payload rather than a client re-derivation. That was right at the time — the
 * re-derivation was buggy — but the second payload turned out to be scoped
 * differently from the first, and could not be scoped at all for text columns
 * (`/frequencies` declares no `text_column_ids`). So the derivation returns,
 * this time over the payload that answers the researcher's actual selection.
 */
describe('#749 — every column comes from one payload', () => {
  function cellUnder(label: string): string {
    const names = headerNames()
    const row = screen.getAllByRole('row').find(r => within(r).queryByText('blah'))!
    const cells = within(row).getAllByRole('cell').map(c => c.textContent?.trim() ?? '')
    return cells[names.indexOf(label)]
  }

  it('counts the conversations the code actually appears in', () => {
    render(
      <TooltipProvider>
        <QualSummaryTable data={payload(['conversation', 'conversation', 'conversation'])} />
      </TooltipProvider>,
    )
    expect(cellUnder('Conv.')).toBe('3')
    expect(cellUnder('% Conv.')).toBe('100.0%')
  })

  it('leaves a conversation the code never reaches out of the count', () => {
    const data = payload(['conversation', 'conversation'])
    data.sources[1].code_counts = {}          // coded, but not with this code
    render(<TooltipProvider><QualSummaryTable data={data} /></TooltipProvider>)
    expect(cellUnder('Conv.')).toBe('1')
    expect(cellUnder('% Conv.')).toBe('50.0%')
  })

  it('sums TEXTS across columns rather than counting the columns', () => {
    // Texts have always been a count of coded responses, not of source columns
    // — two columns holding 4 coded texts each is 8, not 2.
    render(
      <TooltipProvider>
        <QualSummaryTable data={payload(['text_column', 'text_column'])} />
      </TooltipProvider>,
    )
    expect(cellUnder('Texts')).toBe('8')
  })

  it('takes participants and records from the payload, not from the sources', () => {
    // Neither is derivable: one participant speaks across conversations, one
    // record can be coded in several columns. A client that summed per-source
    // counts would double-count both.
    // ⚠️ Both values are deliberately unequal to the SOURCE count (2) and to
    // each other. A first draft used 2, which a client-side derivation over
    // `sources` reproduced exactly — the mutant passed. Coinciding numbers hide
    // the bug they are meant to expose.
    const data = payload(['conversation', 'text_column'],
      { participant_count: 3, record_count: 5 })
    data.totals.total_participants = 6
    data.totals.total_records = 20
    render(<TooltipProvider><QualSummaryTable data={data} /></TooltipProvider>)
    expect(cellUnder('Participants')).toBe('3')
    expect(cellUnder('% Part.')).toBe('50.0%')
    expect(cellUnder('Records')).toBe('5')
    expect(cellUnder('% Rec.')).toBe('25.0%')
  })

  it('shows an em dash for a share with no denominator, and 0.0% for a measured zero', () => {
    // #689's convention, on the per-kind columns: "no sources of this kind in
    // the selection" is not "this code reached none of them".
    const data = payload(['conversation'])
    data.totals.total_participants = 0        // no linked participants at all
    render(<TooltipProvider><QualSummaryTable data={data} /></TooltipProvider>)
    expect(cellUnder('% Part.')).toBe('—')

    cleanup()
    const measured = payload(['conversation'])
    measured.totals.total_participants = 5    // people exist; this code reached none
    render(<TooltipProvider><QualSummaryTable data={measured} /></TooltipProvider>)
    expect(cellUnder('% Part.')).toBe('0.0%')
  })

  it('names the unlinked speakers as EXCLUDED, not as an Unknown bucket', () => {
    const data = payload(['conversation'])
    data.totals.unlinked_speaker_count = 2
    render(<TooltipProvider><QualSummaryTable data={data} /></TooltipProvider>)
    // The participant queries require a non-null participant_id, so an unlinked
    // speaker is in neither the numerator nor the denominator. The old copy
    // said they were "counted as Unknown", which overstated the coverage.
    expect(screen.getByText(/not linked to a participant/)).toBeInTheDocument()
    expect(screen.queryByText(/counted as "Unknown"/)).toBeNull()
  })
})

describe('the source-kind label is a total map, not a ternary chain', () => {
  /**
   * The ARITY here is guaranteed by the compiler, not by this test: the label
   * map is a `Record<SourceKind, string>`, so a fifth kind cannot reach the
   * screen without being named (the old chain ended `: 'Conversation'`, which
   * would have silently RENAMED it). What these cases pin is that the four
   * names are the right ones — the half a type cannot check.
   */
  const EXPECTED: Record<Kind, string> = {
    conversation: 'Conversation',
    document: 'Document',
    observation: 'Observation',
    text_column: 'Comments',
  }

  it.each(Object.keys(EXPECTED) as Kind[])('names %s in the Per Source table', (kind) => {
    renderTable([kind])
    fireEvent.click(screen.getByRole('tab', { name: 'Per Source' }))
    const row = screen.getAllByRole('row').find(r => within(r).queryByText(`${kind} 1`))!
    const typeCell = within(row).getAllByRole('cell')[1]
    expect(typeCell.textContent?.trim()).toBe(EXPECTED[kind])
  })
})

describe('sorting is operable without a mouse', () => {
  /**
   * Every sortable header was a `<th onClick>`: no tab stop, and Enter/Space
   * did nothing, so the table could not be sorted by keyboard at all (WCAG
   * 2.1.1). The fix is a real `<button>` inside the `<th>` — asserted as the
   * MECHANISM, because Enter-activates-a-button is the browser's native
   * behaviour and jsdom does not synthesise it from a key event.
   */
  it('puts a focusable button in every sortable column header', () => {
    renderTable(['conversation', 'observation'])
    const headers = screen.getAllByRole('columnheader')
    expect(headers.length).toBeGreaterThan(6)
    for (const th of headers) {
      const button = within(th).getByRole('button')
      button.focus()
      expect(document.activeElement).toBe(button)
    }
  })

  it('activating the control sorts, and the column announces its direction', () => {
    renderTable(['conversation'])
    const countHeader = screen.getByRole('columnheader', { name: /^Count/ })
    expect(countHeader).toHaveAttribute('aria-sort', 'descending')

    fireEvent.click(within(countHeader).getByRole('button'))
    expect(countHeader).toHaveAttribute('aria-sort', 'ascending')
  })

  it('leaves the info tooltip outside the sort button, so reading it does not re-sort', () => {
    renderTable(['conversation'])
    const pctHeader = screen.getByRole('columnheader', { name: /% of Coded/ })
    const sortButton = within(pctHeader).getByRole('button')
    expect(sortButton.textContent).toContain('% of Coded')
    expect(sortButton.querySelector('svg')).toBeNull()
  })
})

/**
 * #745 — `Count` and `% of Coded` were the LAST pair still sourced apart, and
 * the disagreement was one of SCOPE rather than of arithmetic.
 *
 * The two endpoints read an empty id list oppositely: `get_source_frequencies`
 * uses `is not None` ("none of that kind"), while `get_code_frequencies` uses a
 * truthiness check ("all of that kind"). The UI sends `[]` to the first and
 * `undefined` to the second for the very same "nothing selected here", so a
 * conversations-only selection had its Count summed over 2 conversations and its
 * percentage computed over those conversations PLUS every observation in the
 * project.
 *
 * ⚠️ **The fixture is the test.** Measured on the dev corpus: every code read
 * `Count 0` beside `25.0%` with `Sources 0/2`. A fixture whose selection covers
 * every source that carries coding cannot see this at all — the two scopes
 * coincide there, which is exactly why it survived #679's own "same payload"
 * pass.
 */
describe('#745 — Count and % of Coded answer the same question', () => {
  /**
   * A named cell of the code row, addressed through its COLUMN HEADER.
   *
   * ⚠️ Not `expect(cells).toContain(…)`: the Text Coverage column sits directly
   * beside this one and renders an unconditional `0.0%`, so a whole-row
   * `toContain('0.0%')` passes no matter what "% of Coded" says — measured, by
   * mutation, on the first draft of these tests.
   */
  function cell(label: string): string {
    const headers = screen.getAllByRole('columnheader').map(h => h.textContent?.trim() ?? '')
    const idx = headers.findIndex(h => h.includes(label))
    expect(idx, `no column header contains "${label}"`).toBeGreaterThanOrEqual(0)
    const row = screen.getByRole('row', { name: /blah/ })
    return within(row).getAllByRole('cell')[idx].textContent?.trim() ?? ''
  }

  it('reads the percentage from the payload the count came from', () => {
    // A conversations-only selection in which nothing is coded. The frequencies
    // payload still reports 25% — from observation clips the selection excludes.
    const data = payload(['conversation'])
    data.sources[0].code_counts = {}
    data.sources[0].coded_segments = 0
    data.totals.coded_segments = 0

    render(
      <TooltipProvider>
        <QualSummaryTable data={data} />
      </TooltipProvider>,
    )

    expect(cell('Count')).toBe('0')
    // No coded segments in the selection ⇒ the share is undefined, not zero,
    // and certainly not the excluded sources' 25%.
    expect(cell('% of Coded'), 'the excluded sources’ percentage reached the row').toBe('—')
  })

  it('prints a measured 0.0% rather than an em dash', () => {
    // The falsy-zero trap: this code appears nowhere, but the selection HAS
    // coded segments, so "0.0% of them" is a real measurement.
    const data = payload(['conversation'])
    data.sources[0].code_counts = {}

    render(
      <TooltipProvider>
        <QualSummaryTable data={data} />
      </TooltipProvider>,
    )

    expect(cell('Count')).toBe('0')
    expect(cell('% of Coded')).toBe('0.0%')
  })

  it('scales the percentage against the selection’s coded segments', () => {
    const data = payload(['conversation'])          // coded_segments: 4
    data.sources[0].code_counts = { '1': { count: 1, word_count: 10 } }

    render(
      <TooltipProvider>
        <QualSummaryTable data={data} />
      </TooltipProvider>,
    )

    expect(cell('Count')).toBe('1')
    expect(cell('% of Coded')).toBe('25.0%')   // 1 of the selection's 4 coded
  })

  it('totals the selection’s coded segments, not the project’s', () => {
    const data = payload(['conversation'])
    data.sources[0].coded_segments = 0
    data.totals.coded_segments = 0

    render(
      <TooltipProvider>
        <QualSummaryTable data={data} />
      </TooltipProvider>,
    )

    // The totals row used to print `total_coded_segments` off the frequencies
    // payload — "4" under a column of zeroes.
    const totals = screen.getByRole('row', { name: /Totals/ })
    expect(within(totals).getAllByRole('cell')[1].textContent?.trim()).toBe('0')
  })
})

describe('the sorted column cannot go invisible', () => {
  it('falls back to the default when the selection drops the sorted kind', () => {
    const { rerender } = render(
      <TooltipProvider>
        <QualSummaryTable data={payload(['conversation', 'observation'])} />
      </TooltipProvider>,
    )
    const obsHeader = screen.getByRole('columnheader', { name: /^Obs\./ })
    fireEvent.click(within(obsHeader).getByRole('button'))
    expect(obsHeader).toHaveAttribute('aria-sort', 'descending')

    // The researcher narrows to conversations: the Obs. column is gone, and
    // with it any way to see or change the order the rows are actually in.
    rerender(
      <TooltipProvider>
        <QualSummaryTable data={payload(['conversation'])} />
      </TooltipProvider>,
    )
    expect(screen.queryByRole('columnheader', { name: /^Obs\./ })).toBeNull()
    expect(screen.getByRole('columnheader', { name: /^Count/ })).toHaveAttribute('aria-sort', 'descending')
  })
})
