/**
 * #1025 — a withdrawal is asked with NO client timeout, for the restore's reason
 * (#1024): giving up does not stop the server.
 *
 * The request takes a full backup (video included) before it removes anyone; a
 * withdrawal measured 38.7 s over HTTP (~60 s in a browser) on a 546 MB database.
 * Under the client's 30 s default the request expired mid-withdrawal, and the page
 * then said "Could not remove this
 * participant. Nothing was changed." about a person the server went on to remove.
 *
 * Asserted at the call: what the api namespace actually hands the client.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const post = vi.fn()
vi.mock('./client', async () => {
  const actual = await vi.importActual<typeof import('./client')>('./client')
  return { ...actual, default: { post: (...a: unknown[]) => post(...a) } }
})

import { participantsApi } from './participants'

beforeEach(() => {
  post.mockReset()
  post.mockResolvedValue({ data: { identifier: 'P07', backup_filename: 'x' }, headers: {} })
})

describe('#1025 — participantsApi.withdraw', () => {
  it('turns the client timeout off', async () => {
    await participantsApi.withdraw(3, 9)
    expect(post).toHaveBeenCalledTimes(1)
    const [path, , config] = post.mock.calls[0] as [string, unknown, { timeout?: number }]
    expect(path).toBe('/projects/3/participants/9/withdraw')
    // 0 disables it (`client.ts`: a zero/negative timeout skips the abort signal);
    // an absent config would inherit the 30 s default.
    expect(config?.timeout).toBe(0)
  })
})
