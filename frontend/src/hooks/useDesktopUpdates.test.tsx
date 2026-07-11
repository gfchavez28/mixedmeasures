/**
 * #29 S3 — `useDesktopUpdates`, the renderer's single lens on the updater bridge.
 *
 * The one behavior here that no other test covers, and the reason this file exists
 * (#554 test rider): **subscribe-then-seed precedence**. The hook registers the
 * `onState` listener FIRST and then seeds from `getState()`, applying the seed with
 * `setState(prev => prev ?? s)` — so a push that lands while the seed promise is
 * still in flight WINS, and the (older) seed cannot overwrite it.
 *
 * That `prev ?? s` had no biting test: mutating it to a plain `setState(s)` passed
 * the entire suite, because every other test resolves getState before any push. The
 * race it guards is the real one — main pushes on every transition, and a launch
 * check can complete inside the await.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

import { useDesktopUpdates } from './useDesktopUpdates'

const BASE: MMDesktopUpdateState = {
  status: 'idle',
  version: null,
  percent: 0,
  message: null,
  autoCheck: true,
  supported: true,
}

let pushState: ((s: MMDesktopUpdateState) => void) | null = null

/** Bridge whose getState() resolves only when the test says so. */
function installBridge(getStateImpl: () => Promise<MMDesktopUpdateState>) {
  const bridge = {
    getState: vi.fn(getStateImpl),
    check: vi.fn(async () => ({ ...BASE, status: 'checking' as const })),
    setAutoCheck: vi.fn(async (enabled: boolean) => ({ ...BASE, autoCheck: enabled })),
    install: vi.fn(async () => true),
    onState: vi.fn((cb: (s: MMDesktopUpdateState) => void) => {
      pushState = cb
      return () => { pushState = null }
    }),
  }
  window.mmDesktop = {
    isDesktop: true,
    saveRecoveryKey: vi.fn(async () => ({ ok: true as const, path: '/tmp/key' })),
    updates: bridge,
  }
  return bridge
}

beforeEach(() => { pushState = null })
afterEach(() => {
  vi.clearAllMocks()
  delete window.mmDesktop
})

describe('useDesktopUpdates — subscribe-then-seed', () => {
  it('a push that lands DURING the seed read is not clobbered by the seed', async () => {
    // getState hangs until we release it — the window in which main can push.
    let releaseSeed: (s: MMDesktopUpdateState) => void = () => {}
    installBridge(() => new Promise<MMDesktopUpdateState>(res => { releaseSeed = res }))

    const { result } = renderHook(() => useDesktopUpdates())
    await waitFor(() => expect(pushState).not.toBeNull())

    // Main transitions to downloading while the seed is still in flight.
    act(() => pushState!({ ...BASE, status: 'downloading', version: '1.3.0', percent: 42 }))
    expect(result.current.state?.status).toBe('downloading')

    // NOW the (stale) seed arrives. It must NOT overwrite the fresher push —
    // this is the assertion that `setState(s)` fails and `prev ?? s` passes.
    await act(async () => { releaseSeed({ ...BASE, status: 'idle' }) })

    await waitFor(() => expect(result.current.state?.status).toBe('downloading'))
    expect(result.current.state?.percent).toBe(42)
  })

  it('the seed still applies when nothing has been pushed yet', async () => {
    installBridge(async () => ({ ...BASE, status: 'downloaded', version: '1.3.0' }))
    const { result } = renderHook(() => useDesktopUpdates())
    await waitFor(() => expect(result.current.state?.status).toBe('downloaded'))
    expect(result.current.state?.version).toBe('1.3.0')
  })

  it('a push AFTER the seed always wins (pushes are the source of truth)', async () => {
    installBridge(async () => ({ ...BASE, status: 'idle' }))
    const { result } = renderHook(() => useDesktopUpdates())
    await waitFor(() => expect(result.current.state?.status).toBe('idle'))

    act(() => pushState!({ ...BASE, status: 'error', message: 'Could not download the update.' }))
    expect(result.current.state?.status).toBe('error')
    expect(result.current.state?.message).toMatch(/download/)
  })
})

describe('useDesktopUpdates — degradation', () => {
  it('no bridge (browser / server / pre-1.2 desktop) → state stays null', () => {
    const { result } = renderHook(() => useDesktopUpdates())
    expect(result.current.state).toBeNull()
  })

  it('a rejecting getState (main registered no handlers) degrades to null, never throws', async () => {
    installBridge(() => Promise.reject(new Error('no handler')))
    const { result } = renderHook(() => useDesktopUpdates())
    await waitFor(() => expect(result.current.state).toBeNull())
  })

  it('unsubscribes on unmount so a late push cannot setState on a dead component', async () => {
    const bridge = installBridge(async () => ({ ...BASE }))
    const { unmount } = renderHook(() => useDesktopUpdates())
    await waitFor(() => expect(bridge.onState).toHaveBeenCalled())
    unmount()
    expect(pushState).toBeNull()
  })
})
