/**
 * #29 S3 — TopRail update indicator. Passive: visible only while an update is
 * downloading or staged; silent in every other state and without the bridge.
 */
import { it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'

import UpdateStatusBadge from './UpdateStatusBadge'

function installBridge(state: Partial<MMDesktopUpdateState>) {
  const full: MMDesktopUpdateState = {
    status: 'idle',
    version: null,
    percent: 0,
    message: null,
    autoCheck: true,
    supported: true,
    ...state,
  }
  window.mmDesktop = {
    isDesktop: true,
    saveRecoveryKey: vi.fn(async () => ({ ok: true as const, path: '/tmp/key' })),
    updates: {
      getState: vi.fn(async () => full),
      check: vi.fn(async () => full),
      setAutoCheck: vi.fn(async () => full),
      install: vi.fn(async () => true),
      onState: vi.fn(() => () => {}),
    },
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  delete window.mmDesktop
})

function renderBadge() {
  return render(
    <MemoryRouter>
      <UpdateStatusBadge />
    </MemoryRouter>,
  )
}

it('renders nothing without the desktop bridge', () => {
  const { container } = renderBadge()
  expect(container).toBeEmptyDOMElement()
})

it('renders nothing in quiet states (idle / checking / error / unsupported)', async () => {
  for (const status of ['idle', 'checking', 'error', 'unsupported'] as const) {
    installBridge({ status, supported: status !== 'unsupported' })
    const { container, unmount } = renderBadge()
    // Let the getState seed land before asserting.
    await Promise.resolve()
    expect(container).toBeEmptyDOMElement()
    unmount()
  }
})

it('shows download progress while downloading', async () => {
  installBridge({ status: 'downloading', version: '9.9.9', percent: 62 })
  renderBadge()
  const link = await screen.findByRole('link', { name: /downloading update 9\.9\.9.*62%/i })
  expect(link).toHaveAttribute('href', '/settings')
})

it('shows ready-to-install and links to Settings when downloaded', async () => {
  installBridge({ status: 'downloaded', version: '9.9.9', percent: 100 })
  renderBadge()
  const link = await screen.findByRole('link', { name: /update 9\.9\.9 ready/i })
  expect(link).toHaveAttribute('href', '/settings')
})
