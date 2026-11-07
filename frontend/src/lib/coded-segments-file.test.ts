/**
 * #1535 (1.5.9, D111–D114) — the analysis page's Segments CSV request, and the screen it must equal.
 *
 * ONE table for both suites: `coded-segments-file.cases.json`. Here, each case's `file` is what
 * `codedSegmentsFileRequest` builds and its `screen` is what `codeFrequenciesFileRequest` builds (the
 * Descriptives summary table's read, #1528 D87). `backend/tests/test_coded_segments_selection_1535.py`
 * sends both over HTTP and requires the file's passages to EQUAL the screen's counts — so the chain
 * page → these functions → the table → the server is held at every link, and the only hand-written
 * part is the table itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import cases from './coded-segments-file.cases.json'
import {
  codedSegmentsFileRequest, codeFrequenciesFileRequest, type QualSourceMode,
} from './qual-comparison'

const { downloadFromApi } = vi.hoisted(() => ({ downloadFromApi: vi.fn(() => Promise.resolve()) }))
vi.mock('./api/download', () => ({ downloadFromApi, EXPORT_TIMEOUT_MS: 900_000 }))

import { exportApi } from './api/export'

interface Case {
  name: string
  selection: { codes: number[]; conversations: number[]; textColumns: number[]; documents: number[]; observations: number[] }
  mode: QualSourceMode
  excludeFacilitator: boolean
  participantIds: number[]
  coderIds: string | null
  file: { query: Record<string, string>; answersLeftOut: boolean } | null
  screen: Record<string, unknown>
}

const CASES = cases.cases as Case[]

function fileOf(c: Case) {
  return codedSegmentsFileRequest(c.selection.codes, c.selection, c.mode, {
    excludeFacilitator: c.excludeFacilitator,
    participantIds: c.participantIds,
    coderIdsCsv: c.coderIds ?? undefined,
  })
}

function screenOf(c: Case) {
  return codeFrequenciesFileRequest(c.selection.codes, c.selection, c.mode, {
    exclude_facilitator: c.excludeFacilitator,
    participant_ids: c.participantIds.length ? c.participantIds : undefined,
    coder_ids: c.coderIds ? c.coderIds.split(',').map(Number) : undefined,
  })
}

describe('#1535 — the shared case table', () => {
  it('holds every decision\'s case (a floor, and unique names)', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(14)
    expect(new Set(CASES.map(c => c.name)).size).toBe(CASES.length)
    // Both D114 arms and the participant, code and coder arms are present.
    expect(CASES.filter(c => c.file === null).length).toBeGreaterThanOrEqual(2)
    expect(CASES.some(c => c.file?.answersLeftOut)).toBe(true)
    expect(CASES.some(c => c.participantIds.length)).toBe(true)
    expect(CASES.some(c => c.selection.codes.length)).toBe(true)
    expect(CASES.some(c => c.coderIds)).toBe(true)
  })
})

describe('#1535 — codedSegmentsFileRequest builds the table\'s file request', () => {
  it.each(CASES.map(c => [c.name, c] as const))('%s', (_name, c) => {
    const got = fileOf(c)
    if (c.file === null) {
      expect(got).toEqual({ passages: false })
    } else {
      // `toStrictEqual`: a key sent as `undefined` would be a different request from one never sent.
      expect(got).toStrictEqual({ passages: true, params: c.file.query, answersLeftOut: c.file.answersLeftOut })
    }
  })

  it('an unselected passage kind is a PRESENT empty list, never an omitted one (#1297)', () => {
    const got = codedSegmentsFileRequest([], { conversations: [], textColumns: [], documents: [201], observations: [] },
      'conversations', { excludeFacilitator: true, participantIds: [] })
    expect(got.passages && got.params.conversation_ids).toBe('')
    expect(got.passages && got.params.observation_ids).toBe('')
  })

  it('a question is never a source list of the file (D114: answers never join)', () => {
    for (const c of CASES) {
      const got = fileOf(c)
      if (got.passages) expect(Object.keys(got.params)).not.toContain('text_column_ids')
    }
  })

  it('no request ever names `source` or a layer — the route declares neither (D111, J2-B)', () => {
    for (const c of CASES) {
      const got = fileOf(c)
      if (got.passages) {
        expect(Object.keys(got.params)).not.toContain('source')
        expect(Object.keys(got.params)).not.toContain('layer_scope')
      }
    }
  })
})

describe('#1535 — exportApi.codedSegments sends the table\'s query, and only it', () => {
  beforeEach(() => downloadFromApi.mockClear())

  it.each(CASES.filter(c => c.file).map(c => [c.name, c] as const))('%s', async (_name, c) => {
    await exportApi.codedSegments(7, c.file!.query)
    const url = (downloadFromApi.mock.calls[0] as unknown as [string])[0]
    const [path, qs = ''] = url.split('?')
    expect(path).toBe('/projects/7/export/coded-segments')
    // Every key, a present '' included — `URLSearchParams` keeps an empty value (#1297), and the
    // backend test sends exactly this query.
    expect(Object.fromEntries(new URLSearchParams(qs))).toEqual(c.file!.query)
  })

  it('the Export dialog\'s door (no params) is the bare route', async () => {
    await exportApi.codedSegments(7)
    expect((downloadFromApi.mock.calls[0] as unknown as [string])[0]).toBe('/projects/7/export/coded-segments')
  })
})

describe('#1535 — the screen each case is compared with is the summary table\'s read', () => {
  it.each(CASES.map(c => [c.name, c] as const))('%s', (_name, c) => {
    expect(screenOf(c)).toEqual(c.screen)
  })
})
