/**
 * #1526 D79 (1.5.9) — a universal code's row keeps its counts and has no share of the
 * coded total.
 *
 * The coded total (`totals.coded_segments` for *% of Coded*, `totals.coded_texts` for
 * *% Texts*) leaves out a unit marked only with universal codes (invariant J-A), and a
 * universal code's own count is made of exactly such units — so on the review's probe
 * "Unclear" read *% of Coded* 150% and "Unsubstantive/Artifact" *% Texts* 200%. The other
 * shares divide by what the SELECTION holds (#749) and stay shares on every row.
 *
 * The fixture is the probe's payload AFTER D80 (the 2026-11-03e review's
 * git-ignored kit): D1 = {A, Unclear, —}, D2 = {Unclear}, one survey question whose substantive
 * answers are a1 (A), a2 (Unclear), a3 (Unsubstantive), a4 (uncoded).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { TooltipProvider } from '@/components/ui/tooltip'

import QualSummaryTable from './QualSummaryTable'
import { UNIVERSAL_SHARE_CELL, UNIVERSAL_SHARE_NOTE } from '@/lib/universal-share'
import type { SourceFrequenciesResponse } from '@/lib/api'

afterEach(cleanup)

const A = 15261
const UNCLEAR = 15262
const UNSUB = 15263

const code = (id: number, name: string, isUniversal: boolean, recordCount: number) => ({
  id, name, color: '#888', category_id: null, category_name: null, category_color: null,
  is_universal: isUniversal, numeric_id: id, participant_count: 0, record_count: recordCount,
})

function payload(codes = [code(UNSUB, 'Unsubstantive/Artifact', true, 1),
  code(UNCLEAR, 'Unclear', true, 1), code(A, 'A theme', false, 1)]): SourceFrequenciesResponse {
  const ids = new Set(codes.map(c => c.id))
  const keep = (cc: Record<string, { count: number; word_count: number }>) =>
    Object.fromEntries(Object.entries(cc).filter(([k]) => ids.has(Number(k))))
  return {
    codes,
    sources: [
      { source_type: 'document', source_id: 1, source_label: 'D1', dataset_id: null,
        dataset_name: null, total_segments: 3, total_word_count: 6, coded_segments: 1,
        import_order: 1, groups: null,
        code_counts: keep({ [A]: { count: 1, word_count: 2 }, [UNCLEAR]: { count: 1, word_count: 2 } }) },
      { source_type: 'document', source_id: 2, source_label: 'D2', dataset_id: null,
        dataset_name: null, total_segments: 1, total_word_count: 2, coded_segments: 0,
        import_order: 2, groups: null,
        code_counts: keep({ [UNCLEAR]: { count: 1, word_count: 2 } }) },
      { source_type: 'text_column', source_id: 3, source_label: 'Survey › Q1', dataset_id: 9,
        dataset_name: 'Survey', total_segments: 4, total_word_count: 9, coded_segments: 1,
        import_order: null, groups: null,
        code_counts: keep({ [A]: { count: 1, word_count: 3 }, [UNCLEAR]: { count: 1, word_count: 3 },
          [UNSUB]: { count: 1, word_count: 1 } }) },
    ],
    totals: {
      total_segments: 8, total_word_count: 17, coded_segments: 2, total_sources: 3,
      total_conversations: 0, total_documents: 2, total_observations: 0, total_text_columns: 1,
      coded_transcript_segments: 1, coded_texts: 1, total_participants: 0, total_records: 4,
      unlinked_speaker_count: 0,
    },
    group_by: null,
  } as unknown as SourceFrequenciesResponse
}

function renderTable(data = payload()) {
  return render(<TooltipProvider><QualSummaryTable data={data} /></TooltipProvider>)
}

/** The body cell under a header, for the row whose first cell names `codeName`. */
function cell(codeName: string, header: string): HTMLElement {
  const table = screen.getAllByRole('table')[0]
  const headers = within(table).getAllByRole('columnheader')
    .map(h => h.textContent?.replace(/[↑↓\s]+$/, '').trim() ?? '')
  const col = headers.indexOf(header)
  expect(col, `header ${header} in ${headers.join(' | ')}`).toBeGreaterThanOrEqual(0)
  const row = within(table).getAllByRole('row').find(r => r.querySelector('td')?.textContent === codeName)
  expect(row, codeName).toBeTruthy()
  return row!.querySelectorAll('td')[col] as HTMLElement
}

describe('#1526 D79 — a universal row has no share of the coded total', () => {
  it('withholds *% of Coded* and *% Texts* on both universal rows, and says why to a reader', () => {
    renderTable()
    for (const name of ['Unclear', 'Unsubstantive/Artifact']) {
      for (const header of ['% of Coded', '% Texts']) {
        const c = cell(name, header)
        expect(c).toHaveTextContent(`— ${UNIVERSAL_SHARE_CELL}`)
        expect(c.textContent).not.toMatch(/%/)
      }
    }
  })

  it('keeps every count, and the shares whose base is what the selection holds', () => {
    renderTable()
    expect(cell('Unclear', 'Count')).toHaveTextContent('3')
    expect(cell('Unclear', 'Docs')).toHaveTextContent('2')
    expect(cell('Unclear', '% Docs')).toHaveTextContent('100.0%')
    expect(cell('Unclear', 'Texts')).toHaveTextContent('1')
    expect(cell('Unsubstantive/Artifact', 'Records')).toHaveTextContent('1')
    expect(cell('Unsubstantive/Artifact', '% Rec.')).toHaveTextContent('25.0%')
  })

  it('leaves a real code’s coded shares as they were (the positive control)', () => {
    renderTable()
    expect(cell('A theme', '% of Coded')).toHaveTextContent('100.0%')   // 2 of 2 coded units
    expect(cell('A theme', '% Texts')).toHaveTextContent('100.0%')      // 1 of 1 coded text
    expect(cell('A theme', '% Texts').textContent).not.toContain(UNIVERSAL_SHARE_CELL)
  })

  /**
   * Technique only (jsdom computes no layout): the withheld cell's reason is an `sr-only`,
   * i.e. ABSOLUTE, span, so the table's scroll box must be its containing block (#1156) or the
   * span escapes the box. Found by driving: at 640×360 the window scrolled sideways to 1,324 px.
   */
  it('scrolls the table in a POSITIONED box, so the cells’ reasons cannot escape it', () => {
    renderTable()
    const box = screen.getAllByRole('table')[0].parentElement!
    expect(box.className).toMatch(/\boverflow-x-auto\b/)
    expect(box.className).toMatch(/\brelative\b/)
    expect(box.querySelectorAll('td .sr-only').length).toBe(4)   // the population it protects
  })

  it('says the reason once, under the table, when a universal row is on it', () => {
    renderTable()
    expect(screen.getAllByText(UNIVERSAL_SHARE_NOTE)).toHaveLength(1)
  })

  it('says nothing when no universal row is on the table', () => {
    renderTable(payload([code(A, 'A theme', false, 1)]))
    expect(screen.queryByText(UNIVERSAL_SHARE_NOTE)).not.toBeInTheDocument()
    expect(cell('A theme', '% of Coded')).toHaveTextContent('100.0%')   // the table rendered
  })

  it('says nothing in the Per Source view, which shows no code shares', () => {
    renderTable()
    fireEvent.click(screen.getByRole('tab', { name: 'Per Source' }))
    expect(screen.getByRole('table', { name: /Source frequency summary/ })).toBeInTheDocument()
    expect(screen.queryByText(UNIVERSAL_SHARE_NOTE)).not.toBeInTheDocument()
  })

  it('sorts by *% of Coded* without crashing on the withheld rows', () => {
    renderTable()
    fireEvent.click(screen.getByRole('button', { name: /% of Coded/ }))
    expect(cell('A theme', '% of Coded')).toHaveTextContent('100.0%')
    expect(cell('Unclear', '% of Coded')).toHaveTextContent(`— ${UNIVERSAL_SHARE_CELL}`)
  })

  /**
   * A withheld share sorts as NO share, never by the number it does not show. Found by a
   * surviving mutant: `% Texts` computed without the rule still RENDERED "—" (the cell checks
   * the flag itself) while every universal row sorted as 100%. Here all three rows hold 1 of
   * the 1 coded text, so only the rule separates them.
   */
  it('a withheld share sorts as no share: % Texts descending puts the real code first', () => {
    renderTable()
    fireEvent.click(screen.getByRole('button', { name: /^% Texts/ }))
    const firstBodyRow = within(screen.getAllByRole('table')[0]).getAllByRole('row')[1]
    expect(firstBodyRow.querySelector('td')).toHaveTextContent('A theme')
  })
})
