/**
 * #1548 — the code-by-group comparison is asked with the EXPORT budget, not the
 * client's 30 s.
 *
 * It measured 41.0 s on the encrypted D12 corpus (1.2M turns, 225,000 linked
 * participants), so the 30 s default aborted a computation that was going to
 * succeed — and `retry: 1` then asked again, so the server ran it twice while the
 * panel showed nothing. The CSV of the same computation already had this budget.
 *
 * A JSON read, so `blob-download-budget.test.ts` cannot see it: asserted at the call,
 * as `irr-budget.test.ts` does for #957.
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
  post.mockResolvedValue({ data: { groups: [] }, headers: {} })
})

describe('#1548 — codeAnalysisApi.demographicComparison', () => {
  it('states the export budget, and still sends the request body', async () => {
    const body = { group_by_subtype: 'gender', conversation_ids: [3] }
    await codeAnalysisApi.demographicComparison(7, body)
    expect(post).toHaveBeenCalledTimes(1)
    const [path, sent, config] = post.mock.calls[0] as [string, unknown, { timeout?: number }]
    expect(path).toBe('/projects/7/code-analysis/demographic-comparison')
    expect(sent).toEqual(body)
    expect(config.timeout).toBe(EXPORT_TIMEOUT_MS)
  })

  it('the budget is longer than the measured cost', () => {
    // Self-check on the premise, not the wiring: below the measured 41.0 s this call
    // would be back where it started.
    expect(EXPORT_TIMEOUT_MS).toBeGreaterThan(41_000)
  })
})
