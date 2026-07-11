/**
 * #29 S3 — Settings "Software update" section.
 *
 * The load-bearing behaviors under test:
 * - D4: "Restart to update" takes a fresh backup BEFORE asking main to install,
 *   and fails CLOSED — a failed backup means install() is never invoked.
 * - D9: an unsupported install gets the releases-page link, not dead controls.
 * - D10: the auto-check toggle round-trips through the bridge; "Check now"
 *   stays available regardless.
 * - The section renders nothing without the bridge (browser / server deploys /
 *   pre-1.2 desktop builds).
 */
import { it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const backupNow = vi.fn()
vi.mock('@/lib/api', () => ({
  backupApi: { now: (...a: unknown[]) => backupNow(...a) },
}))

const toastError = vi.fn()
vi.mock('sonner', () => ({
  toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn() },
}))

import SoftwareUpdateSection from './SoftwareUpdateSection'

const BASE_STATE: MMDesktopUpdateState = {
  status: 'idle',
  version: null,
  percent: 0,
  message: null,
  autoCheck: true,
  supported: true,
}

// Call-order log shared by the backup and install mocks (the D4 assertion).
let callLog: string[]
let pushState: ((s: MMDesktopUpdateState) => void) | null
// Implementation-typed vi.fn()s so the object satisfies the global bridge type.
let bridge: ReturnType<typeof makeBridge>

function makeBridge(full: MMDesktopUpdateState) {
  return {
    getState: vi.fn(async () => full),
    check: vi.fn(async () => ({ ...full, status: 'checking' as const })),
    setAutoCheck: vi.fn(async (enabled: boolean) => ({ ...full, autoCheck: enabled })),
    install: vi.fn(async () => {
      callLog.push('install')
      return true
    }),
    onState: vi.fn((cb: (s: MMDesktopUpdateState) => void) => {
      pushState = cb
      return () => {
        pushState = null
      }
    }),
  }
}

function installBridge(state: Partial<MMDesktopUpdateState> = {}) {
  bridge = makeBridge({ ...BASE_STATE, ...state })
  window.mmDesktop = {
    isDesktop: true,
    saveRecoveryKey: vi.fn(async () => ({ ok: true as const, path: '/tmp/key' })),
    updates: bridge,
  }
}

beforeEach(() => {
  callLog = []
  pushState = null
  backupNow.mockImplementation(async () => {
    callLog.push('backup')
    return {}
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  delete window.mmDesktop
})

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <SoftwareUpdateSection />
    </QueryClientProvider>,
  )
}

it('renders nothing without the desktop bridge', () => {
  const { container } = renderSection()
  expect(container).toBeEmptyDOMElement()
})

it('seeds from getState and shows the version + Check now when idle', async () => {
  installBridge()
  renderSection()
  expect(await screen.findByText('Software update')).toBeInTheDocument()
  expect(screen.getByText(/You're on version/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /check now/i })).toBeEnabled()
  expect(screen.queryByRole('button', { name: /restart to update/i })).toBeNull()
})

it('unsupported install: releases-page link instead of controls (D9)', async () => {
  installBridge({ status: 'unsupported', supported: false })
  renderSection()
  expect(await screen.findByText(/can't update itself/)).toBeInTheDocument()
  const link = screen.getByRole('link', { name: /releases page/i })
  expect(link).toHaveAttribute('href', expect.stringContaining('/releases'))
  expect(screen.queryByRole('button', { name: /check now/i })).toBeNull()
  expect(screen.queryByRole('checkbox')).toBeNull()
})

it('Check now invokes the bridge check', async () => {
  installBridge()
  renderSection()
  fireEvent.click(await screen.findByRole('button', { name: /check now/i }))
  await waitFor(() => expect(bridge.check).toHaveBeenCalledTimes(1))
})

it('auto-check toggle reflects state and round-trips setAutoCheck (D10)', async () => {
  installBridge()
  renderSection()
  const box = await screen.findByRole('checkbox', { name: /check for updates automatically/i })
  expect(box).toBeChecked()
  fireEvent.click(box)
  await waitFor(() => expect(bridge.setAutoCheck).toHaveBeenCalledWith(false))
  await waitFor(() => expect(box).not.toBeChecked())
})

it('a state push re-renders the section (downloading progress)', async () => {
  installBridge()
  renderSection()
  await screen.findByText('Software update')
  pushState?.({ ...BASE_STATE, status: 'downloading', version: '9.9.9', percent: 41 })
  expect(await screen.findByText(/Downloading version 9\.9\.9.*41%/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /check now/i })).toBeDisabled()
})

it('Restart to update takes the backup BEFORE install (D4)', async () => {
  installBridge({ status: 'downloaded', version: '9.9.9', percent: 100 })
  renderSection()
  fireEvent.click(await screen.findByRole('button', { name: /restart to update/i }))
  await waitFor(() => expect(callLog).toEqual(['backup', 'install']))
})

it('a failed backup blocks the install (D4 fails closed)', async () => {
  installBridge({ status: 'downloaded', version: '9.9.9', percent: 100 })
  backupNow.mockRejectedValue(new Error('disk full'))
  renderSection()
  fireEvent.click(await screen.findByRole('button', { name: /restart to update/i }))
  await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/not installed/i)))
  expect(bridge.install).not.toHaveBeenCalled()
  // The button recovers so the user can retry.
  expect(screen.getByRole('button', { name: /restart to update/i })).toBeEnabled()
})

it('install returning false (nothing staged) surfaces an error and recovers', async () => {
  installBridge({ status: 'downloaded', version: '9.9.9', percent: 100 })
  bridge.install.mockResolvedValue(false)
  renderSection()
  fireEvent.click(await screen.findByRole('button', { name: /restart to update/i }))
  await waitFor(() =>
    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/no longer ready/i)),
  )
  expect(screen.getByRole('button', { name: /restart to update/i })).toBeEnabled()
})
