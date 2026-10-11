/**
 * #1145 — a bulk type change is asked with NO client timeout, the participant
 * table's reason (#1073 b): giving up does not stop the server.
 *
 * Measured by #1145's review on a 40 × 100,000 dataset: 15 columns took 28.5 s
 * and 40 took 73.7 s against the client's 30 s default — so the client gave up
 * on a change the server went on to finish.
 *
 * Asserted at the call: what the api namespace actually hands the client.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const patch = vi.fn()
vi.mock('./client', async () => {
  const actual = await vi.importActual<typeof import('./client')>('./client')
  return { ...actual, default: { patch: (...a: unknown[]) => patch(...a) } }
})

import { recodeApi } from './datasets'

beforeEach(() => {
  patch.mockReset()
  patch.mockResolvedValue({ data: {}, headers: {} })
})

describe('#1145 — the bulk type change is never timed out by the client', () => {
  it('turns the client timeout off', async () => {
    await recodeApi.bulkTypeUpdate(3, 5, [7, 8], 'ordinal')
    expect(patch).toHaveBeenCalledTimes(1)
    const [path, body, config] = patch.mock.calls[0] as [string, unknown, { timeout?: number }]
    expect(path).toBe('/projects/3/datasets/5/columns/bulk-type')
    expect(body).toEqual({ column_ids: [7, 8], column_type: 'ordinal' })
    // 0 disables it (`client.ts`); an absent config inherits the 30 s default.
    expect(config?.timeout).toBe(0)
  })
})
