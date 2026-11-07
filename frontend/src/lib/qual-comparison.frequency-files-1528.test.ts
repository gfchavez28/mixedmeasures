/**
 * #1528 (D87, D88, 1.5.9) — what the analysis page's two frequency files ask the server for.
 *
 * Both now read the selection by #1297's rule (`comparisonSources`): nothing selected → every
 * source; anything selected → exactly that, an unselected kind as NONE of it.
 *
 * - D87, the Frequencies CSV's request (`codeFrequenciesFileRequest`, a JSON body): an
 *   unselected kind is `[]`, which `get_source_frequencies` reads as none (`is not None`).
 * - D88, the Source Data CSV's query (`sourceDataCsvParams`): an unselected kind is a PRESENT
 *   `''` — the old door OMITTED it, which the route reads as every source of that kind (one
 *   selected interview listed six sources) — and `exclude_facilitator` is ALWAYS sent (the
 *   route defaults to true; the door sent it only when true, so *include interviewer turns*
 *   was dropped).
 */
import { describe, it, expect } from 'vitest'
import { codeFrequenciesFileRequest, sourceDataCsvParams } from './qual-comparison'

const NONE = { conversations: [], textColumns: [], documents: [], observations: [] }
const ONE_INTERVIEW = { ...NONE, conversations: new Set([7]) }

describe('#1528 D87 — the Frequencies CSV’s request', () => {
  const base = { exclude_facilitator: false, aggregation: 'category' as const, coder_ids: [3], layer_scope: 'human' as const }

  it('nothing selected under All: no code list and no source list — every code, every source', () => {
    expect(codeFrequenciesFileRequest([], NONE, 'all', base)).toEqual(base)
  })

  it('one interview selected: exactly it, every other kind sent as none', () => {
    expect(codeFrequenciesFileRequest(new Set([1, 2]), ONE_INTERVIEW, 'all', base)).toEqual({
      ...base, code_ids: [1, 2],
      conversation_ids: [7], text_column_ids: [], document_ids: [], observation_ids: [],
    })
  })

  it('codes and sources are decided apart: codes selected, no source → every source', () => {
    const req = codeFrequenciesFileRequest([5], NONE, 'all', base)
    expect(req.code_ids).toEqual([5])
    expect(req).not.toHaveProperty('conversation_ids')
    expect(req).not.toHaveProperty('document_ids')
  })

  /**
   * Decided at build (driven 2026-11-04): with nothing selected, the file holds every source the
   * sidebar OFFERS under its mode — what *Select all* would choose. Reading every kind put a
   * Text-mode file's interviews beside the co-occurrence CSV, which counts only answers there.
   */
  it('nothing selected under Text: every question, none of the other kinds', () => {
    expect(codeFrequenciesFileRequest([], NONE, 'text', base)).toEqual({
      ...base, conversation_ids: [], document_ids: [], observation_ids: [],
    })
  })

  it('nothing selected under Conversations: every conversation, document and clip, no question', () => {
    expect(codeFrequenciesFileRequest([], NONE, 'conversations', base)).toEqual({ ...base, text_column_ids: [] })
  })

  it('a selection is the table’s request whatever the mode (the table does not read it)', () => {
    expect(codeFrequenciesFileRequest([], ONE_INTERVIEW, 'text', base))
      .toEqual(codeFrequenciesFileRequest([], ONE_INTERVIEW, 'all', base))
  })
})

describe('#1528 D88 — the Source Data CSV’s query', () => {
  const opts = { excludeFacilitator: false, participantIds: [] as number[] }

  it('sends an unselected kind PRESENT and empty, never omitted', () => {
    expect(sourceDataCsvParams([], ONE_INTERVIEW, opts)).toEqual({
      conversation_ids: '7', text_column_ids: '', document_ids: '', observation_ids: '',
      exclude_facilitator: 'false',
    })
    // …and `URLSearchParams` keeps an empty value on the wire.
    expect(new URLSearchParams(sourceDataCsvParams([], ONE_INTERVIEW, opts)).toString())
      .toContain('document_ids=&')
  })

  it('always sends exclude_facilitator — false included, which the route would otherwise default to true', () => {
    expect(sourceDataCsvParams([], NONE, opts).exclude_facilitator).toBe('false')
    expect(sourceDataCsvParams([], NONE, { ...opts, excludeFacilitator: true }).exclude_facilitator).toBe('true')
  })

  it('nothing selected sends no source list (every source), and carries the screen’s other scope', () => {
    expect(sourceDataCsvParams([4, 5], NONE, {
      excludeFacilitator: true, participantIds: [8, 9], coderIdsCsv: '3', layerScope: 'consensus',
    })).toEqual({
      exclude_facilitator: 'true', code_ids: '4,5', participant_ids: '8,9', coder_ids: '3', layer_scope: 'consensus',
    })
  })
})
