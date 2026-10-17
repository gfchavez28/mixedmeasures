/**
 * #1035 / #1054 — a project delete and Link by column are asked with NO client
 * timeout, for the withdraw's reason (#1025): giving up does not stop the server.
 *
 * Measured on the scale corpus after the fixes: a delete 11-24 s (and up to 11 min
 * before #1035), a link of 122,382 records 7 s — and the link COMMITS in batches,
 * so a client that gave up would report a failure over a half-linked dataset.
 * The preview reads only (0.8 s) and keeps the default.
 *
 * Asserted at the call: what the api namespace actually hands the client.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const del = vi.fn()
const post = vi.fn()
vi.mock('./client', async () => {
  const actual = await vi.importActual<typeof import('./client')>('./client')
  return {
    ...actual,
    default: { delete: (...a: unknown[]) => del(...a), post: (...a: unknown[]) => post(...a) },
  }
})

import { projectsApi } from './projects'
import { datasetsApi } from './datasets'

beforeEach(() => {
  del.mockReset(); post.mockReset()
  del.mockResolvedValue({ data: {}, headers: {} })
  post.mockResolvedValue({ data: {}, headers: {} })
})

describe('the long project requests are never timed out by the client', () => {
  it('a project delete turns the client timeout off', async () => {
    await projectsApi.delete(4)
    const [path, config] = del.mock.calls[0] as [string, { timeout?: number }]
    expect(path).toBe('/projects/4')
    // 0 disables it (`client.ts`); an absent config inherits the 30 s default.
    expect(config?.timeout).toBe(0)
  })

  it('Link by column turns it off; its dry run keeps the default', async () => {
    await datasetsApi.linkByColumn(3, 11, 49)
    await datasetsApi.previewLinkByColumn(3, 11, 49)
    const [linkPath, linkBody, linkConfig] = post.mock.calls[0] as [string, unknown, { timeout?: number }]
    expect(linkPath).toBe('/projects/3/datasets/11/link-by-column')
    expect(linkBody).toEqual({ column_id: 49 })
    expect(linkConfig?.timeout).toBe(0)
    const [previewPath, , previewConfig] = post.mock.calls[1] as [string, unknown, { timeout?: number } | undefined]
    expect(previewPath).toBe('/projects/3/datasets/11/link-by-column/preview')
    expect(previewConfig?.timeout).toBeUndefined()
  })
})
