/**
 * #957 — reliability is asked with the EXPORT budget, not the client's 30 s.
 *
 * Pooled reliability measured 46.4 s on a 1.2M-application project: the 30 s
 * default aborted a computation that was going to succeed, and the Reliability
 * tab then told the researcher the statistic was "unavailable for this project".
 *
 * This is a JSON read, so `blob-download-budget.test.ts` — a scan over
 * `responseType: 'blob'` — cannot see it by construction. Asserted at the call
 * instead: what the api namespace actually hands the client.
 *
 * ⚠️ `IrrMatrix`'s timeout message derives its "N minutes" from the same
 * constant, so this pin is also what keeps that sentence true.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const get = vi.fn()
vi.mock('./client', async () => {
  const actual = await vi.importActual<typeof import('./client')>('./client')
  return { ...actual, default: { get: (...a: unknown[]) => get(...a) } }
})

import { codeAnalysisApi } from './code-analysis'
import { EXPORT_TIMEOUT_MS } from './download'

beforeEach(() => {
  get.mockReset()
  get.mockResolvedValue({ data: { available: false }, headers: {} })
})

describe('#957 — codeAnalysisApi.irr', () => {
  it('states the export budget on the pooled request', async () => {
    await codeAnalysisApi.irr(7)
    expect(get).toHaveBeenCalledTimes(1)
    const [path, config] = get.mock.calls[0] as [string, { timeout?: number }]
    expect(path).toBe('/projects/7/code-analysis/irr')
    expect(config.timeout).toBe(EXPORT_TIMEOUT_MS)
  })

  it('states it on a source-scoped request too, and still sends the scope', async () => {
    await codeAnalysisApi.irr(7, { source: 'col:62' })
    const [, config] = get.mock.calls[0] as [string, { timeout?: number; params?: unknown }]
    expect(config.timeout).toBe(EXPORT_TIMEOUT_MS)
    expect(config.params).toEqual({ source: 'col:62' })
  })

  it('the budget is longer than the pooled cost that was measured', () => {
    // Self-check on the premise, not the wiring: if the shared budget were ever
    // cut below the measured 46.4 s, this call would be back where it started.
    expect(EXPORT_TIMEOUT_MS).toBeGreaterThan(46_400)
  })
})
