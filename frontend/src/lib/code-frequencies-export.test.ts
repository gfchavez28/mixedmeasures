/**
 * #1528 D87 (1.5.9) — the Frequencies CSV's door: one read of the summary table's payload, the
 * file written from it, saved under the old server file's name, a failure said the way every
 * export says one — and never a rejection (the doors are fire-and-forget).
 *
 * 🔴 The read carries `EXPORT_TIMEOUT_MS` (#820): it IS the export now, and its cost is the
 * project's. The server file it replaced ran under that budget; the screen's 30 s default would
 * have turned a large project's working export into a failure (BES's read: 10.7 s, #1526 D82).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const sourceFrequencies = vi.fn()
const downloadBlob = vi.fn()
const reportExportFailure = vi.fn()
vi.mock('@/lib/api', () => ({
  codeAnalysisApi: { sourceFrequencies: (...a: unknown[]) => sourceFrequencies(...a) },
  downloadBlob: (...a: unknown[]) => downloadBlob(...a),
  reportExportFailure: (...a: unknown[]) => reportExportFailure(...a),
  EXPORT_TIMEOUT_MS: 900_000,
}))

import { codeFrequenciesFilename, exportCodeFrequenciesCsv } from './code-frequencies-export'

const DATA = {
  codes: [{ id: 1, name: 'Access', color: '#888', category_id: null, category_name: null,
    category_color: null, is_universal: false, numeric_id: 1, participant_count: 0, record_count: 2 }],
  sources: [{ source_type: 'text_column', source_id: 4, source_label: 'Q1', dataset_id: 9,
    dataset_name: 'S', total_segments: 3, total_word_count: 9, coded_segments: 2, import_order: null,
    groups: null, code_counts: { 1: { count: 2, word_count: 6 } } }],
  totals: { total_segments: 3, total_word_count: 9, coded_segments: 0, total_sources: 1,
    total_conversations: 0, total_documents: 0, total_observations: 0, total_text_columns: 1,
    coded_transcript_segments: 0, coded_texts: 2, total_participants: 0, total_records: 3,
    unlinked_speaker_count: 0 },
  group_by: null,
}

beforeEach(() => vi.clearAllMocks())

describe('exportCodeFrequenciesCsv (#1528 D87)', () => {
  const opts = { request: { exclude_facilitator: true }, categoryMode: false, scope: 'Scope: coders: Ben', projectName: 'Ferns' }

  it('reads the summary table’s payload under the export budget and saves the table as a CSV', async () => {
    sourceFrequencies.mockResolvedValue(DATA)
    await exportCodeFrequenciesCsv(7, opts)
    expect(sourceFrequencies).toHaveBeenCalledWith(7, { exclude_facilitator: true }, { timeout: 900_000 })
    const [blob, name] = downloadBlob.mock.calls[0] as [Blob, string]
    expect(name).toMatch(/^Ferns_code_frequencies_\d{8}\.csv$/)
    expect(blob.type).toBe('text/csv;charset=utf-8;')
    // The UTF-8 BOM (Excel reads non-ASCII names right) — in the BYTES: `Blob.text()` drops it.
    expect([...new Uint8Array(await blob.arrayBuffer()).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    const text = await blob.text()
    expect(text.split('\r\n')[0]).toBe('Scope: coders: Ben')
    expect(text).toContain('Access,,2,')          // Count 2 — survey answers, not zeros
    expect(reportExportFailure).not.toHaveBeenCalled()
  })

  it('writes the Per Category table when asked for it', async () => {
    sourceFrequencies.mockResolvedValue(DATA)
    await exportCodeFrequenciesCsv(7, { ...opts, scope: null, categoryMode: true })
    const text = await (downloadBlob.mock.calls[0][0] as Blob).text()
    expect(text.split('\r\n')[0]).toMatch(/^Category,Count,/)
  })

  it('says a failure as every export does, and never rejects', async () => {
    const err = new Error('boom')
    sourceFrequencies.mockRejectedValue(err)
    await expect(exportCodeFrequenciesCsv(7, opts)).resolves.toBeUndefined()
    expect(reportExportFailure).toHaveBeenCalledWith(err, 'The frequencies export')
    expect(downloadBlob).not.toHaveBeenCalled()
  })
})

describe('codeFrequenciesFilename', () => {
  const day = new Date(2026, 10, 4)   // local 4 November 2026
  it('keeps the server file’s name: <project>_code_frequencies_<YYYYMMDD>.csv', () => {
    expect(codeFrequenciesFilename('Ferns', day)).toBe('Ferns_code_frequencies_20261104.csv')
  })
  it('keeps a non-Latin project name (the client rule, not the header’s ASCII one)', () => {
    expect(codeFrequenciesFilename('Évaluation Française', day)).toBe('Évaluation_Française_code_frequencies_20261104.csv')
  })
  it('names the file without a project', () => {
    expect(codeFrequenciesFilename(undefined, day)).toBe('code_frequencies_20261104.csv')
  })
})
