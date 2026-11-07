/**
 * #1530 D98 (1.5.9) — the export doors carry a coder scope when asked, and only then.
 *
 * `codedSegments` is the door the review's table MISSED (found at its close-out): the analysis
 * page's *Exports › Segments CSV* passes `filterParams`, which carry the blind-forced
 * `coder_ids`, and the door dropped it — the file held every coder's rows while the page beside
 * it counted only hers. Every scoped case has its unscoped twin: an absent scope must leave the
 * URL exactly as before (the server reads absent as every coder).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { downloadFromApi } = vi.hoisted(() => ({ downloadFromApi: vi.fn(() => Promise.resolve()) }))
vi.mock('./download', () => ({ downloadFromApi, EXPORT_TIMEOUT_MS: 900_000 }))

import { exportApi } from './export'
import { textCodingApi } from './text-coding'
import type { CodedSegmentsParams } from '@/lib/qual-comparison'

function sentUrl(): string {
  return (downloadFromApi.mock.calls[0] as unknown as [string])[0]
}
function sentQuery(): URLSearchParams {
  return new URLSearchParams(sentUrl().split('?')[1] ?? '')
}

beforeEach(() => downloadFromApi.mockClear())

describe('exportApi — coder_ids rides along when given (#1530 D98)', () => {
  it('codedSegments forwards the scope its params carry, beside its other filters', async () => {
    // A wider object than the route's names (the page's `filterParams` once were): #1535 D111 made
    // the door an allow-list of the route's own names, so the layer still cannot ride along.
    await exportApi.codedSegments(3, { coder_ids: '2', code_ids: '7', layer_scope: 'human' } as CodedSegmentsParams)
    const q = sentQuery()
    expect(q.get('coder_ids')).toBe('2')
    expect(q.get('code_ids')).toBe('7')
    // The file is the human layer by J2-B; a layer is not forwarded (#1060's question).
    expect(q.has('layer_scope')).toBe(false)
  })

  it('codedSegments with no scope sends none', async () => {
    await exportApi.codedSegments(3, { code_ids: '7' })
    expect(sentQuery().has('coder_ids')).toBe(false)
  })

  it('the workbook keeps its include_ options and gains the scope', async () => {
    await exportApi.excelWithOptions(3, { coded_data: true, audit: false }, '2')
    const q = sentQuery()
    expect(q.get('include_coded_data')).toBe('true')
    expect(q.get('include_audit')).toBe('false')
    expect(q.get('coder_ids')).toBe('2')
  })

  it('the workbook with no scope is the URL it always was', async () => {
    await exportApi.excelWithOptions(3, { coded_data: true })
    expect(sentUrl()).toBe('/projects/3/export/excel?include_coded_data=true')
  })

  it('the Study CSV and the R export take the scope as their only parameter', async () => {
    await exportApi.csv(3, '2')
    expect(sentUrl()).toBe('/projects/3/export/csv?coder_ids=2')
    downloadFromApi.mockClear()
    await exportApi.rData(3, '2')
    expect(sentUrl()).toBe('/projects/3/export/r-data?coder_ids=2')
  })

  it('…and with none they are the URLs they always were', async () => {
    await exportApi.csv(3)
    expect(sentUrl()).toBe('/projects/3/export/csv')
    downloadFromApi.mockClear()
    await exportApi.rData(3)
    expect(sentUrl()).toBe('/projects/3/export/r-data')
  })

  it('the Text Coding export forwards it too, and only when given', async () => {
    await textCodingApi.exportCoded(3, { column_ids: '10', coder_ids: '2' })
    expect(sentQuery().get('coder_ids')).toBe('2')
    downloadFromApi.mockClear()
    await textCodingApi.exportCoded(3, { column_ids: '10' })
    expect(sentQuery().has('coder_ids')).toBe(false)
  })
})
