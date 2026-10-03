/**
 * #1073 (b) — the participant table's create and refresh are asked with NO client
 * timeout, for the withdraw's reason (#1025): giving up does not stop the server.
 *
 * A first create measured 31.6–33.2 s and a refresh 27–29.5 s on 122,382
 * participants (#1033's record), against the client's 30 s default — so at that
 * scale the page said the table could not be created while the server went on
 * to build and commit it.
 *
 * Asserted at the call: what the api namespace actually hands the client.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const post = vi.fn()
vi.mock('./client', async () => {
  const actual = await vi.importActual<typeof import('./client')>('./client')
  return { ...actual, default: { post: (...a: unknown[]) => post(...a) } }
})

import { datasetsApi } from './datasets'

beforeEach(() => {
  post.mockReset()
  post.mockResolvedValue({ data: {}, headers: {} })
})

describe('#1073 (b) — the participant table is never timed out by the client', () => {
  it.each([
    ['createParticipantsDataset', '/projects/3/datasets/participants'],
    ['refreshParticipantsDataset', '/projects/3/datasets/participants/refresh'],
  ] as const)('%s turns the client timeout off', async (method, expectedPath) => {
    await datasetsApi[method](3)
    expect(post).toHaveBeenCalledTimes(1)
    const [path, , config] = post.mock.calls[0] as [string, unknown, { timeout?: number }]
    expect(path).toBe(expectedPath)
    // 0 disables it (`client.ts`); an absent config inherits the 30 s default.
    expect(config?.timeout).toBe(0)
  })
})
