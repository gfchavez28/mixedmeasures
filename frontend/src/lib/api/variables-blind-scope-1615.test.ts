/**
 * #1615 (r4) — the Variables view's *Observed values* and the computed-variable preview carry
 * the viewer's scope when asked, and only then. A participant score's distribution IS the
 * scores, and a preview prints the cells it reads, so while blind mode withholds the server
 * must be told whose view this is (it sends no values for a rating column, D198's rule).
 * Every scoped case has its unscoped twin: absent leaves the request exactly as before.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const get = vi.fn()
const post = vi.fn()
vi.mock('./client', async () => {
  const actual = await vi.importActual<typeof import('./client')>('./client')
  return { ...actual, default: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) } }
})

import { datasetsApi, recodeApi } from './datasets'

beforeEach(() => {
  for (const f of [get, post]) {
    f.mockReset()
    f.mockResolvedValue({ data: {}, headers: {} })
  }
})

describe('the scope rides along when given (#1615)', () => {
  it('getFrequencies sends coder_ids', async () => {
    await recodeApi.getFrequencies(3, 5, 9, '2')
    expect(get).toHaveBeenCalledWith('/projects/3/datasets/5/columns/9/frequencies',
      { params: { coder_ids: '2' } })
  })
  it('getFrequencies with no scope sends none', async () => {
    await recodeApi.getFrequencies(3, 5, 9)
    expect(get).toHaveBeenCalledWith('/projects/3/datasets/5/columns/9/frequencies', undefined)
  })
  it('previewComputedColumn sends coder_ids beside its body', async () => {
    const body = { column_text: 'B', expression: '[x] * 2', column_type: 'numeric' }
    await datasetsApi.previewComputedColumn(3, 5, body, '2')
    expect(post).toHaveBeenCalledWith('/projects/3/datasets/5/columns/computed/preview', body,
      { params: { coder_ids: '2' } })
  })
  it('previewComputedColumn with no scope sends none', async () => {
    const body = { column_text: 'B', expression: '[x] * 2', column_type: 'numeric' }
    await datasetsApi.previewComputedColumn(3, 5, body)
    expect(post).toHaveBeenCalledWith('/projects/3/datasets/5/columns/computed/preview', body, undefined)
  })
})
