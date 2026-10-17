/**
 * Settings › Data protection — what the recovery-key hint promises (#1120).
 *
 * The hint said the key is "the only way to recover your data if this computer's
 * keychain is lost or you move to a new machine". A move is a project file's job:
 * the encryption plan decided that backups stay on the machine that made them, and
 * SECURITY.md names `.mmproject` as the way between machines, so the hint sent a
 * researcher to the one thing that cannot help them move. It now says what can, in
 * step with the recovery file's own text (`electron/key-manager.js`).
 */
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ encryptionEnabled: true }),
}))

import { SecuritySection } from './SettingsPage'

afterEach(() => {
  cleanup()
  delete window.mmDesktop
})

describe('SecuritySection — the recovery-key hint (#1120)', () => {
  it('does not send a researcher to a new machine with the key; a project file is the way', () => {
    window.mmDesktop = {
      isDesktop: true,
      saveRecoveryKey: vi.fn(async () => ({ ok: true as const, path: '/tmp/key' })),
    }
    render(<SecuritySection />)

    // The hint renders only beside the button, so its presence is checked first:
    // a hint that is not on screen would pass the absence check below vacuously.
    expect(screen.getByRole('button', { name: /Save recovery key/ })).toBeInTheDocument()
    const hint = screen.getByText(/It is the only way to recover your data/)
    expect(hint).toHaveTextContent(/keychain is lost or reset\./)
    expect(hint).toHaveTextContent(/Export Project \(\.mmproject\)/)
    expect(hint).not.toHaveTextContent(/new machine/i)
  })
})
