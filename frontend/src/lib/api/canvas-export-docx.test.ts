/**
 * #1406 D5 — the `.docx` export renders the CLIENT's tables. The server's own
 * (`canvas_export.py::_get_chart_table_data`, deleted) read a grouped metric's
 * missing-group bucket as the variable's value, so a chart with no captured
 * image must reach the server with its table, keyed by material id, beside the
 * images — and the download name must still be the canvas's.
 *
 * Asserted at the call: what the api namespace actually hands the client.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const post = vi.fn()
vi.mock('./client', async () => {
  const actual = await vi.importActual<typeof import('./client')>('./client')
  return { ...actual, default: { post: (...a: unknown[]) => post(...a) } }
})

import { canvasApi } from './canvas'
import { docxChartTables } from '../canvas-export'

beforeEach(() => {
  post.mockReset()
  post.mockResolvedValue({ data: new Blob(['x']), headers: {} })
  URL.createObjectURL = vi.fn(() => 'blob:x')
  URL.revokeObjectURL = vi.fn()
})

describe('canvasApi.exportDocx', () => {
  it('posts each chart table beside the images, keyed by material id', async () => {
    const table = { headers: ['Metric', 'Group', 'Value', 'N'], rows: [['score', 'A', '3', '3']] }
    await canvasApi.exportDocx(3, 9, new Map([[5, 'data:image/png;base64,QUJD']]), new Map([[7, table]]), 'Report')
    const [url, body] = post.mock.calls[0] as [string, Record<string, unknown>]
    expect(url).toBe('/projects/3/canvases/9/export-docx')
    expect(body).toEqual({ chart_images: { 5: 'QUJD' }, chart_tables: { 7: table }, display_tables: {} })
  })

  it('posts the note printed under a chart’s table, so Word can print it too', async () => {
    // The sentence the Markdown and HTML exports print under the table (`ExportTable.note`):
    // a comparison's method note and the groups its tests left out (#1329).
    const table = { headers: ['Group', 'n'], rows: [['A', '6']], note: 'C (n = 1) was left out of the tests.' }
    const tables = docxChartTables(new Map([[7, { md: '', html: '', table }]]))
    await canvasApi.exportDocx(3, 9, undefined, tables, 'Report')
    const [, body] = post.mock.calls[0] as [string, { chart_tables: Record<string, unknown> }]
    expect(body.chart_tables).toEqual({ 7: table })
  })

  it('posts each joint display’s report table keyed by its displayKey (D174)', async () => {
    const report = {
      title: 'Side-by-side joint display by construct: T', message: null, headers: ['Construct', 'A (2 participants)'],
      rows: [['Training', 'Coded: x 1 of 2.'], ['Beside “Training”: …']], span_rows: [1], note: 'Groups: …', appendix: [],
    }
    await canvasApi.exportDocx(3, 9, undefined, undefined, 'Report', new Map([['k-1', report]]))
    const [, body] = post.mock.calls[0] as [string, Record<string, unknown>]
    expect(body).toEqual({ chart_images: {}, chart_tables: {}, display_tables: { 'k-1': report } })
  })

  it('names the download after the canvas, not a table argument', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('Report.docx')
    })
    await canvasApi.exportDocx(3, 9, undefined, undefined, 'Report')
    expect(click).toHaveBeenCalledTimes(1)
    expect((post.mock.calls[0] as [string, Record<string, unknown>])[1]).toEqual({ chart_images: {}, chart_tables: {}, display_tables: {} })
    click.mockRestore()
  })
})
