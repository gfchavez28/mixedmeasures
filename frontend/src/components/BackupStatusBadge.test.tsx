/**
 * #1186 — the TopRail backup clock says WHEN the next automatic backup is due, with
 * a date when that is not today. It printed a bare time ("Next auto at 4:30 PM") in
 * both its tooltip and its accessible name, so a projection days old — or one past
 * midnight — read as a plausible time today.
 */
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const status = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({ backupApi: { status } }))

import { BackupStatusBadge } from './TopRail'
import { nextBackupPhrase } from '@/lib/backup-history'

function renderBadge() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><BackupStatusBadge /></MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('BackupStatusBadge', () => {
  it('names the DAY of a next backup that is not today, in its name and its tooltip', async () => {
    const next = '2030-01-02T15:00:00+00:00'
    status.mockResolvedValue({
      last_backup_at: new Date().toISOString(), backup_count: 1, total_size_bytes: 1,
      is_stale: false, next_backup_at: next, auto_backup_interval_hours: 4, auto_backup_max_count: 5,
    })
    renderBadge()
    const link = await screen.findByRole('link', { name: /^Last backup / })
    const phrase = nextBackupPhrase(next)!
    expect(phrase).toMatch(/^on .*2030/)
    expect(link).toHaveAccessibleName(`Last backup just now · Next auto ${phrase}`)
    expect(link).toHaveAttribute('title', `Last backup just now · Next auto ${phrase}`)
  })

  it('says when the FIRST automatic backup is due when there are none yet (#1210)', async () => {
    const next = '2030-01-02T15:00:00+00:00'
    status.mockResolvedValue({
      last_backup_at: null, backup_count: 0, total_size_bytes: 0,
      is_stale: true, next_backup_at: next, auto_backup_interval_hours: 4, auto_backup_max_count: 5,
    })
    renderBadge()
    const phrase = nextBackupPhrase(next)!
    expect(await screen.findByRole('link', { name: `No backups yet · First auto ${phrase}` })).toBeInTheDocument()
  })

  it('says only "No backups yet" when there are none and automatic backups are off', async () => {
    status.mockResolvedValue({
      last_backup_at: null, backup_count: 0, total_size_bytes: 0,
      is_stale: true, next_backup_at: null, auto_backup_interval_hours: 0, auto_backup_max_count: 5,
    })
    renderBadge()
    expect(await screen.findByRole('link', { name: 'No backups yet' })).toBeInTheDocument()
  })

  /**
   * #1199 — the server now gives NO time when every backup is dated more than an hour
   * past this computer's clock (a clock set back; it used to say "just now" for a
   * 2030 file). Backups exist, so "No backups yet" — keyed on that null — was false.
   */
  it('backups that are all dated ahead of the clock: says so, never "No backups yet", and stays amber', async () => {
    const next = '2030-01-02T15:00:00+00:00'
    status.mockResolvedValue({
      last_backup_at: null, backup_count: 3, total_size_bytes: 3,
      is_stale: true, next_backup_at: next, auto_backup_interval_hours: 4, auto_backup_max_count: 5,
    })
    const { container } = renderBadge()
    const phrase = nextBackupPhrase(next)!
    const link = await screen.findByRole('link', {
      name: `Backup dates are ahead of this computer’s clock · Next auto ${phrase}`,
    })
    expect(link).not.toHaveAccessibleName(/No backups yet/)
    expect(container.querySelector('svg')).toHaveClass('text-amber-400')
  })

  it('…and without a schedule says only that', async () => {
    status.mockResolvedValue({
      last_backup_at: null, backup_count: 1, total_size_bytes: 1,
      is_stale: true, next_backup_at: null, auto_backup_interval_hours: 0, auto_backup_max_count: 5,
    })
    renderBadge()
    expect(await screen.findByRole('link', { name: 'Backup dates are ahead of this computer’s clock' })).toBeInTheDocument()
  })

  it('says only the last backup when automatic backups are off', async () => {
    status.mockResolvedValue({
      last_backup_at: new Date().toISOString(), backup_count: 1, total_size_bytes: 1,
      is_stale: false, next_backup_at: null, auto_backup_interval_hours: 0, auto_backup_max_count: 5,
    })
    renderBadge()
    expect(await screen.findByRole('link', { name: 'Last backup just now' })).toBeInTheDocument()
  })
})
