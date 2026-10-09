/**
 * #1084 (a) — the hold that keeps a restore's outcome on screen.
 *
 * Two holes in #1024's hold, each closed here and each pinned against the shape
 * that had it: TanStack's `online` listener set the page back online on the next
 * reconnect, and a request outside React Query still met `client.ts`'s 401 reload.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, onlineManager } from '@tanstack/react-query'

const reload = vi.fn()
vi.mock('@/lib/api/session-lapse', () => ({ reloadForLapsedSession: () => reload() }))

import api from '@/lib/api/client'
import { browserOnlineListener, holdPageForRestoreOutcome } from './restore-outcome-hold'

function answer401() {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: 'Not authenticated' }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  })))
}

afterEach(() => {
  vi.unstubAllGlobals()
  reload.mockReset()
  onlineManager.setEventListener(browserOnlineListener)
  onlineManager.setOnline(true)
})

describe('holdPageForRestoreOutcome', () => {
  it('holds React Query offline through a browser `online` event', () => {
    // A subscriber, as the app has: the library only listens while someone does.
    const client = new QueryClient()
    client.mount()
    const release = holdPageForRestoreOutcome()
    expect(onlineManager.isOnline()).toBe(false)

    window.dispatchEvent(new Event('online'))
    expect(onlineManager.isOnline()).toBe(false)

    release()
    expect(onlineManager.isOnline()).toBe(true)
    // The listener is BACK: the browser's events count again.
    window.dispatchEvent(new Event('offline'))
    expect(onlineManager.isOnline()).toBe(false)
    window.dispatchEvent(new Event('online'))
    expect(onlineManager.isOnline()).toBe(true)
    client.unmount()
  })

  it('holds the 401 reload for a request made outside React Query', async () => {
    answer401()
    const release = holdPageForRestoreOutcome()
    await expect(api.get('/auth/status')).rejects.toMatchObject({ status: 401 })
    expect(reload).not.toHaveBeenCalled()

    release()
    // The positive control: unheld, a lapsed session still reloads.
    await expect(api.get('/auth/status')).rejects.toMatchObject({ status: 401 })
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('a release is idempotent, and one holder cannot release another’s hold', async () => {
    answer401()
    const first = holdPageForRestoreOutcome()
    const second = holdPageForRestoreOutcome()
    first()
    first()
    await expect(api.get('/x')).rejects.toMatchObject({ status: 401 })
    expect(reload).not.toHaveBeenCalled()
    expect(onlineManager.isOnline()).toBe(false)
    second()
    expect(onlineManager.isOnline()).toBe(true)
    await expect(api.get('/x')).rejects.toMatchObject({ status: 401 })
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
