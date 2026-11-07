/**
 * #1528 D87 (1.5.9) — the Frequencies CSV is the Descriptives summary table's own rows.
 *
 * The server file it replaced read another payload (`get_code_frequencies`): from the Text
 * source it wrote every count as 0, under All it had no text column, under a selection it
 * counted every source of a kind the researcher selected nothing from, and its text counts
 * would still have disagreed with the table (a coded "N/A", #1526 D80). Measured on the
 * 2026-11-04 review's probe (the internal design notes,
 * git-ignored).
 *
 * 🔴 The guard is the TABLE AGAINST THE FILE, both rendered from one payload: the headers, the
 * rows in the table's opening order, every number and the notes. The two media differ in format
 * only (the table draws a zero count as "—" and a reach as "3/5"; the file keeps 0 and writes
 * "3 of 5"), and `sameValue` below states that mapping OUTSIDE the column module — so a column
 * whose table cell and file cell drift apart fails here, whoever wrote both.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { TooltipProvider } from '@/components/ui/tooltip'

import QualSummaryTable from './QualSummaryTable'
import { codeSummaryCsv, frequencyFileScope, unlinkedSpeakerNote } from './qual-summary-columns'
import { UNIVERSAL_SHARE_CELL, UNIVERSAL_SHARE_NOTE } from '@/lib/universal-share'
import { UTF8_BOM } from '@/lib/csv'
import type { SourceFrequenciesResponse } from '@/lib/api'

afterEach(cleanup)

const A = 1, B = 2, U = 3, EVIL = 4

const code = (id: number, name: string, o: { cat?: string; universal?: boolean; parts?: number; recs?: number } = {}) => ({
  id, name, color: '#888', category_id: o.cat ? 90 : null, category_name: o.cat ?? null,
  category_color: null, is_universal: !!o.universal, numeric_id: id,
  participant_count: o.parts ?? 0, record_count: o.recs ?? 0,
})

const source = (type: string, id: number, label: string, counts: Record<number, number>, total = 5) => ({
  source_type: type, source_id: id, source_label: label, dataset_id: type === 'text_column' ? 9 : null,
  dataset_name: type === 'text_column' ? 'Survey' : null, total_segments: total, total_word_count: total * 4,
  coded_segments: 2, import_order: id, groups: null,
  code_counts: Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, { count: n, word_count: n * 3 }])),
})

/** Every kind; a universal row; a category; a share with no denominator (% Part., no
 *  participants); a real 0.0% (A's % Obs.); a zero count drawn "—" (A's Obs.); unlinked
 *  speakers; and a code whose name is a formula. Counts all differ, so the order is decided. */
function payload(): SourceFrequenciesResponse {
  return {
    codes: [
      code(U, 'Unclear', { universal: true, recs: 1 }),
      code(A, 'Access', { recs: 3 }),
      code(B, 'Barriers', { cat: 'Structural' }),
      code(EVIL, '=HYPERLINK("http://x")', { cat: '@cat' }),
    ],
    sources: [
      source('conversation', 11, 'Interview 1', { [A]: 2, [U]: 1, [EVIL]: 1 }),
      source('document', 21, 'Policy', { [A]: 1, [B]: 2 }),
      source('observation', 31, 'Clips', { [B]: 1 }),
      source('text_column', 41, 'Survey › Q1', { [A]: 3, [U]: 1 }),
    ],
    totals: {
      total_segments: 20, total_word_count: 80, coded_segments: 9, total_sources: 4,
      total_conversations: 1, total_documents: 1, total_observations: 1, total_text_columns: 1,
      coded_transcript_segments: 4, coded_texts: 3, total_participants: 0, total_records: 4,
      unlinked_speaker_count: 2,
    },
    group_by: null,
  } as unknown as SourceFrequenciesResponse
}

function parseCsv(text: string): string[][] {
  // RFC 4180, as `lib/csv.ts::toCsv` writes it (CRLF, double-quoted fields).
  const rows: string[][] = []
  let row: string[] = [], field = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { row.push(field); field = '' }
    else if (ch === '\r' && text[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++ }
    else field += ch
  }
  row.push(field); rows.push(row)
  return rows
}

/** The file, its notes split from the table part: [notes, header, body rows, totals row]. */
function fileParts(data: SourceFrequenciesResponse, categoryMode = false, scope: string | null = null) {
  const text = codeSummaryCsv(data, { categoryMode, scope })
  expect(text.startsWith(UTF8_BOM)).toBe(true)
  const rows = parseCsv(text.slice(UTF8_BOM.length))
  const h = rows.findIndex(r => r.length > 1)
  return { notes: rows.slice(0, h).map(r => r[0]), header: rows[h], body: rows.slice(h + 1, -1), totals: rows[rows.length - 1] }
}

/** The table as rendered: header texts, body cell texts (a withheld cell's sr-only reason
 *  stripped back to its visible "—"), totals cell texts. */
function tableParts(data: SourceFrequenciesResponse, categoryMode = false) {
  render(<TooltipProvider><QualSummaryTable data={data} categoryMode={categoryMode} /></TooltipProvider>)
  const table = screen.getByRole('table', { name: /Code frequency summary/ })
  const header = within(table).getAllByRole('columnheader').map(th => th.textContent!.replace(/[↑↓]/g, '').trim())
  const rows = within(table).getAllByRole('row').slice(1)
  const text = (td: Element) => td.textContent!.replace(` ${UNIVERSAL_SHARE_CELL}`, '').trim()
  const body = rows.slice(0, -1).map(r => [...r.querySelectorAll('td')].map(text))
  const totals = [...rows[rows.length - 1].querySelectorAll('td')]
  return { header, body, totals, totalsSpan: Number(totals[0].getAttribute('colspan') ?? 1), totalsText: totals.map(text) }
}

/** One fact, two formats — stated here, independently of the column module. */
function sameValue(tableCell: string, fileCell: string): boolean {
  if (tableCell === fileCell) return true
  if (tableCell === '—') return fileCell === '' || fileCell === '0'
  if (tableCell === '–') return fileCell === ''                         // no category
  const reach = tableCell.match(/^(\d+)\/(\d+)$/)
  return !!reach && fileCell === `${reach[1]} of ${reach[2]}`
}

describe('#1528 D87 — the Frequencies CSV is the summary table', () => {
  for (const categoryMode of [false, true]) {
    it(`has the table's columns, rows, order and numbers (${categoryMode ? 'Per Category' : 'Per Code'})`, () => {
      const data = payload()
      const t = tableParts(data, categoryMode)
      const f = fileParts(data, categoryMode)
      expect(f.header).toEqual(t.header)
      // The table's opening order (a defanged name carries its leading "'" in the file).
      expect(f.body.map(r => r[0].replace(/^'/, ''))).toEqual(t.body.map(r => r[0]))
      expect(f.body).toHaveLength(t.body.length)
      t.body.forEach((row, i) => row.forEach((cell, j) => {
        expect(sameValue(cell, f.body[i][j].replace(/^'/, '')), `${t.header[j]} of ${row[0]}: table "${cell}", file "${f.body[i][j]}"`).toBe(true)
      }))
      // The totals: "Totals" over the naming columns, then each column's base.
      expect(f.totals[0]).toBe('Totals')
      const fileTotals = f.totals.slice(t.totalsSpan)
      expect(fileTotals).toHaveLength(t.totalsText.length - 1)
      t.totalsText.slice(1).forEach((cell, j) => expect(sameValue(cell, fileTotals[j])).toBe(true))
    })
  }

  it('discriminates: every kind is in the file, and a format difference is all that separates them', () => {
    // #707a — the fixture must exercise each mapping, or `sameValue` proves nothing.
    const t = tableParts(payload())
    const f = fileParts(payload())
    const flat = t.body.flat()
    expect(flat).toContain('—')                 // a zero drawn as a dash, and a share with no base
    expect(flat.some(c => /^\d+\/\d+$/.test(c))).toBe(true)
    expect(f.header).toEqual(expect.arrayContaining(['Conv.', 'Docs', 'Obs.', 'Texts', 'Records']))
    const access = f.body.find(r => r[0] === 'Access')!
    expect(access[f.header.indexOf('Obs.')]).toBe('0')       // the table's "—", a real zero
    expect(access[f.header.indexOf('% Obs.')]).toBe('0.0%')  // a measured 0, not blank (#689)
    expect(access[f.header.indexOf('% Part.')]).toBe('')     // no denominator: blank, not 0
    expect(access[f.header.indexOf('Category')]).toBe('')    // no category: blank, not the table's "–"
    // A reach is "3 of 5", never "3/5", which Excel opens as a date.
    for (const row of f.body) expect(row[f.header.indexOf('Sources')]).toMatch(/^\d+ of \d+$/)
  })

  it('writes survey answers from a text-only selection — the old file wrote every count as 0', () => {
    const data = payload()
    data.sources = data.sources.filter(s => s.source_type === 'text_column')
    const f = fileParts(data)
    const access = f.body.find(r => r[0] === 'Access')!
    expect(access[f.header.indexOf('Texts')]).toBe('3')
    expect(access[f.header.indexOf('Count')]).toBe('3')
    expect(f.header).not.toContain('Conv.')
  })

  it('leaves a universal row’s coded shares blank and says why first, as the table says it', () => {
    const f = fileParts(payload())
    const unclear = f.body.find(r => r[0] === 'Unclear')!
    expect(unclear[f.header.indexOf('% of Coded')]).toBe('')
    expect(unclear[f.header.indexOf('% Texts')]).toBe('')
    expect(unclear[f.header.indexOf('% Rec.')]).toBe('25.0%')   // a selection-based share stays
    expect(f.notes).toEqual([UNIVERSAL_SHARE_NOTE, unlinkedSpeakerNote(2)])
    // …in the table's own words, which it renders under itself.
    tableParts(payload())
    for (const note of f.notes) expect(screen.getByText(note)).toBeInTheDocument()
  })

  it('carries no note the table would not show', () => {
    const data = payload()
    data.codes = data.codes.filter(c => !c.is_universal)
    data.sources = data.sources.filter(s => s.source_type !== 'conversation')   // unlinked speakers then say nothing
    expect(fileParts(data).notes).toEqual([])
  })

  it('defangs a formula in a code or category name (lib/csv.ts)', () => {
    const f = fileParts(payload())
    const evil = f.body.find(r => r[0].includes('HYPERLINK'))!
    expect(evil[0]).toBe(`'=HYPERLINK("http://x")`)
    expect(evil[f.header.indexOf('Category')]).toBe("'@cat")
  })

  it('opens with its scope when a coder or layer filter narrows it (#499)', () => {
    expect(fileParts(payload(), false, 'Scope: coders: Ben').notes[0]).toBe('Scope: coders: Ben')
    expect(frequencyFileScope('consensus', [])).toBe('Scope: consensus layer')
    expect(frequencyFileScope('machine', ['Ben', 'Ada'])).toBe('Scope: machine layer; coders: Ben, Ada')
    expect(frequencyFileScope(undefined, ['Me'])).toBe('Scope: coders: Me')
    expect(frequencyFileScope('human', [])).toBeNull()      // everyone's coding: nothing to say
    expect(frequencyFileScope(null, [])).toBeNull()
  })
})
