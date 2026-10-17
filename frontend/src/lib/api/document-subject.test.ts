/**
 * #1152 — a document's subject is sent through its own named request, so the
 * participant-link door scan (`participant-link-cache.test.ts`) can find every
 * caller. The null is the UNLINK and must reach the wire as an explicit `null`:
 * the server reads `model_dump(exclude_unset=True)`, so an omitted key leaves the
 * link alone.
 *
 * Asserted at the call: what the api namespace actually hands the client.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const patch = vi.fn()
vi.mock('./client', async () => {
  const actual = await vi.importActual<typeof import('./client')>('./client')
  return { ...actual, default: { patch: (...a: unknown[]) => patch(...a) } }
})

import { documentsApi } from './documents'

beforeEach(() => {
  patch.mockReset()
  patch.mockResolvedValue({ data: {}, headers: {} })
})

describe('documentsApi.setSubject', () => {
  it('sends the participant', async () => {
    await documentsApi.setSubject(3, 12, 7)
    expect(patch).toHaveBeenCalledWith('/projects/3/documents/12', { participant_id: 7 })
  })

  it('sends an explicit null to unlink — never an omitted key', async () => {
    await documentsApi.setSubject(3, 12, null)
    const [, body] = patch.mock.calls[0] as [string, Record<string, unknown>]
    expect(body).toHaveProperty('participant_id', null)
  })
})
