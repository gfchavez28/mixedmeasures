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
    expect(body).toEqual({ chart_images: { 5: 'QUJD' }, chart_tables: { 7: table } })
  })

  it('names the download after the canvas, not a table argument', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('Report.docx')
    })
    await canvasApi.exportDocx(3, 9, undefined, undefined, 'Report')
    expect(click).toHaveBeenCalledTimes(1)
    expect((post.mock.calls[0] as [string, Record<string, unknown>])[1]).toEqual({ chart_images: {}, chart_tables: {} })
    click.mockRestore()
  })
})
