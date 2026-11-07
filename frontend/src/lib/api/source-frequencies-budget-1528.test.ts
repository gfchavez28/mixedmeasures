/**
 * #1528 D87 — the summary table's read carries the budget its caller states.
 *
 * The Frequencies CSV is written from `POST …/source-frequencies` and passes `EXPORT_TIMEOUT_MS`
 * (#820); the screen passes nothing and keeps the client's default. Asserted at the call — what
 * the api namespace hands the client — because a namespace that dropped `config` would leave the
 * export on the screen's 30 s while every test of the export (which mocks this module) passed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const post = vi.fn()
vi.mock('./client', async () => {
  const actual = await vi.importActual<typeof import('./client')>('./client')
  return { ...actual, default: { post: (...a: unknown[]) => post(...a) } }
})

import { codeAnalysisApi } from './code-analysis'
import { EXPORT_TIMEOUT_MS } from './download'

beforeEach(() => {
  post.mockReset()
  post.mockResolvedValue({ data: { codes: [] }, headers: {} })
})

describe('#1528 — codeAnalysisApi.sourceFrequencies', () => {
  it('hands the client the budget the export states', async () => {
    await codeAnalysisApi.sourceFrequencies(7, { code_ids: [1] }, { timeout: EXPORT_TIMEOUT_MS })
    const [path, body, config] = post.mock.calls[0] as [string, unknown, { timeout?: number }]
    expect(path).toBe('/projects/7/code-analysis/source-frequencies')
    expect(body).toEqual({ code_ids: [1] })
    expect(config.timeout).toBe(EXPORT_TIMEOUT_MS)
  })

  it('states none for the screen, which keeps the client default', async () => {
    await codeAnalysisApi.sourceFrequencies(7, {})
    expect(post.mock.calls[0][2]).toBeUndefined()
  })
})
