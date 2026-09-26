/**
 * #971 — Settings › Backup & Data › Backup history.
 *
 * The behaviours under test:
 * - a row says WHICH kind of backup it is and WHEN it was taken, because that is
 *   all that distinguishes five snapshots of the same install;
 * - Restore reaches the shared confirmation with THAT backup — the fix itself:
 *   before it, the only way back was an upload capped at 500 MB while creating a
 *   backup had no cap at all;
 * - Download and Delete are reachable, named per row, and Delete confirms first;
 * - the list says it is loading, and says when the load FAILED, rather than
 *   rendering nothing in both cases.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { BackupInfo } from '@/lib/api'
import { ApiError } from '@/lib/api/client'

const list = vi.fn()
const downloadArchive = vi.fn()
const deleteArchive = vi.fn()
vi.mock('@/lib/api', () => ({
  backupApi: {
    list: (...a: unknown[]) => list(...a),
    downloadArchive: (...a: unknown[]) => downloadArchive(...a),
    deleteArchive: (...a: unknown[]) => deleteArchive(...a),
  },
}))

const toastSuccess = vi.fn()
const toastError = vi.fn()
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}))

import BackupHistorySection from './BackupHistorySection'
import { formatTakenAt } from '@/lib/safety-copies'

const AUTO: BackupInfo = {
  filename: 'auto_20260920_020736.mmbackup',
  created_at: '2026-09-20T02:07:36+00:00',
  size_bytes: 143 * 1024 * 1024,
  backup_type: 'auto',
}

const PRE_RESTORE: BackupInfo = {
  filename: 'pre_restore_20260919_120000.mmbackup',
  created_at: '2026-09-19T12:00:00+00:00',
  size_bytes: 140 * 1024 * 1024,
  backup_type: 'pre_restore',
}

const ON_QUIT: BackupInfo = {
  filename: 'shutdown_20260919_180000.mmbackup',
  created_at: '2026-09-19T18:00:00+00:00',
  size_bytes: 141 * 1024 * 1024,
  backup_type: 'shutdown',
}

function renderSection(onRestore = vi.fn(), restoreBusy = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const utils = render(
    <QueryClientProvider client={client}>
      <BackupHistorySection onRestore={onRestore} restoreBusy={restoreBusy} />
    </QueryClientProvider>,
  )
  return { ...utils, onRestore }
}

async function openHistory() {
  const toggle = await screen.findByRole('button', { name: 'Backup history' })
  fireEvent.click(toggle)
  return toggle
}

beforeEach(() => {
  list.mockReset()
  downloadArchive.mockReset()
  deleteArchive.mockReset()
  toastSuccess.mockReset()
  toastError.mockReset()
})

afterEach(cleanup)

describe('BackupHistorySection', () => {
  it('does not ask for the list until the disclosure is opened', async () => {
    list.mockResolvedValue([AUTO])
    renderSection()
    expect(list).not.toHaveBeenCalled()
    await openHistory()
    await waitFor(() => expect(list).toHaveBeenCalled())
  })

  it('🔴 says a load FAILED rather than rendering nothing', async () => {
    // It used to render nothing while loading AND nothing if the request failed,
    // so a failure was indistinguishable from a folder with no backups — on the
    // one screen whose job is to tell you what you can recover from.
    list.mockRejectedValue(new Error('boom'))
    renderSection()
    await openHistory()
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Your backups could not be listed/,
    )
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('says it is loading rather than claiming there are none', async () => {
    list.mockReturnValue(new Promise(() => {}))
    renderSection()
    await openHistory()
    expect(await screen.findByRole('status')).toHaveTextContent(/Loading your backups/)
    expect(screen.queryByText(/No backups yet/)).not.toBeInTheDocument()
  })

  it('says there are none only once the list has answered', async () => {
    list.mockResolvedValue([])
    renderSection()
    await openHistory()
    expect(await screen.findByText(/No backups yet/)).toBeInTheDocument()
  })

  it('🔴 tells the kinds of backup apart on screen', async () => {
    // The server used to report `pre_restore` and `pre_withdrawal` both as "pre",
    // and the label map's `pre_restore` key could never match. Cosmetic until the
    // rows carried a Restore button; now it is what a researcher chooses by.
    list.mockResolvedValue([AUTO, ON_QUIT, PRE_RESTORE])
    renderSection()
    await openHistory()
    const rows = await screen.findAllByRole('listitem')
    expect(rows[0]).toHaveTextContent('Automatic')
    expect(rows[1]).toHaveTextContent('On quit')
    expect(rows[2]).toHaveTextContent('Before a restore')
    // The description, not just the name: both of the first two are automatic.
    expect(rows[0]).toHaveTextContent('taken on the 4-hourly schedule')
    expect(rows[1]).toHaveTextContent('taken when Mixed Measures last closed')
  })

  it('🔴 names every control by its own row', async () => {
    list.mockResolvedValue([AUTO, ON_QUIT])
    renderSection()
    await openHistory()
    // What distinguishes two backups is WHEN they were taken, so that is what the
    // names carry. A column of buttons all called "Restore" is both unusable to a
    // screen reader and dangerous, since restoring replaces everything.
    const names = (await screen.findAllByRole('button', { name: /^Restore from / }))
      .map(b => b.getAttribute('aria-label'))
    expect(new Set(names).size).toBe(2)
    expect(names[0]).toBe(`Restore from the automatic backup from ${formatTakenAt(AUTO.created_at)}`)
    for (const verb of ['Download', 'Delete']) {
      const set = screen.getAllByRole('button', { name: new RegExp(`^${verb} the `) })
      expect(new Set(set.map(b => b.getAttribute('aria-label'))).size).toBe(2)
    }
  })

  it('🔴 hands the chosen backup to the shared restore confirmation', async () => {
    // The fix itself. Restore is the PARENT's because its preview and
    // confirmation are shared with the upload door — this asserts the handoff
    // carries the row that was pressed, not merely that something happened.
    list.mockResolvedValue([AUTO, ON_QUIT])
    const { onRestore } = renderSection()
    await openHistory()
    const buttons = await screen.findAllByRole('button', { name: /^Restore from / })
    fireEvent.click(buttons[1])
    expect(onRestore).toHaveBeenCalledTimes(1)
    expect(onRestore).toHaveBeenCalledWith(ON_QUIT)
  })

  it('does not start a second restore while one is running, and says so', async () => {
    list.mockResolvedValue([AUTO])
    const { onRestore } = renderSection(vi.fn(), true)
    await openHistory()
    const button = await screen.findByRole('button', { name: /^Restore from / })
    // `aria-disabled` + a click guard, never `disabled`: Chrome blurs a focused
    // button that becomes disabled, and the refusal is the load-bearing half
    // (#754 — `aria-disabled` changes what a control announces, not what it does).
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).not.toBeDisabled()
    fireEvent.click(button)
    expect(onRestore).not.toHaveBeenCalled()
  })

  it('downloads the backup it was asked for', async () => {
    list.mockResolvedValue([AUTO, ON_QUIT])
    downloadArchive.mockResolvedValue(undefined)
    renderSection()
    await openHistory()
    const buttons = await screen.findAllByRole('button', { name: /^Download the / })
    fireEvent.click(buttons[1])
    await waitFor(() => expect(downloadArchive).toHaveBeenCalledWith(ON_QUIT.filename))
  })

  it('confirms before deleting, and names the backup in the confirmation', async () => {
    list.mockResolvedValue([AUTO, ON_QUIT])
    renderSection()
    await openHistory()
    fireEvent.click((await screen.findAllByRole('button', { name: /^Delete the / }))[0])
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveAccessibleDescription(
      new RegExp(`Automatic backup from ${formatTakenAt(AUTO.created_at)}`),
    )
    expect(deleteArchive).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(deleteArchive).not.toHaveBeenCalled()
  })

  it('deletes on confirmation and refreshes the list', async () => {
    list.mockResolvedValueOnce([AUTO, ON_QUIT]).mockResolvedValue([ON_QUIT])
    deleteArchive.mockResolvedValue(undefined)
    renderSection()
    await openHistory()
    fireEvent.click((await screen.findAllByRole('button', { name: /^Delete the / }))[0])
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete backup' }))
    await waitFor(() => expect(deleteArchive).toHaveBeenCalledWith(AUTO.filename))
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
  })

  it('🔴 warns when this is the only backup of its kind', async () => {
    // The kinds are not interchangeable: `pre_restore` is the state before a
    // restore, and tomorrow's 4-hourly snapshot does not replace it.
    list.mockResolvedValue([AUTO, ON_QUIT, PRE_RESTORE])
    renderSection()
    await openHistory()
    fireEvent.click(
      await screen.findByRole('button', { name: /^Delete the before a restore backup/ }),
    )
    const dialog = await screen.findByRole('alertdialog')
    // 🔴 In the DESCRIPTION, not merely on screen: as children the warning is
    // rendered and silent (#886's class), on an act that cannot be undone.
    expect(dialog).toHaveAccessibleDescription(/only before a restore backup you have/)
  })

  it('does not warn when another of the same kind remains', async () => {
    // The POSITIVE control: a warning shown unconditionally would pass the test
    // above and train the researcher to ignore the one that is true.
    list.mockResolvedValue([AUTO, { ...AUTO, filename: 'auto_20260919_220000.mmbackup' }])
    renderSection()
    await openHistory()
    fireEvent.click((await screen.findAllByRole('button', { name: /^Delete the / }))[0])
    await screen.findByRole('alertdialog')
    expect(screen.queryByTestId('backup-delete-warning')).not.toBeInTheDocument()
  })

  it('reports the server’s reason when a delete is refused', async () => {
    list.mockResolvedValue([AUTO])
    deleteArchive.mockRejectedValue(
      new ApiError(409, {
        detail: 'The backup could not be deleted. If it is open in another program, close it and try again.',
      }, {}),
    )
    renderSection()
    await openHistory()
    fireEvent.click(await screen.findByRole('button', { name: /^Delete the / }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete backup' }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(
      expect.stringContaining('open in another program'),
    ))
  })

  it('leaves focus somewhere real after a delete removes its own button', async () => {
    list.mockResolvedValueOnce([AUTO]).mockResolvedValue([])
    deleteArchive.mockResolvedValue(undefined)
    renderSection()
    const toggle = await openHistory()
    fireEvent.click(await screen.findByRole('button', { name: /^Delete the / }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete backup' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    await waitFor(() => expect(document.activeElement).toBe(toggle))
    // `contains` is true of <body>, so the assertion above needs this beside it.
    expect(document.activeElement).not.toBe(document.body)
  })

  it('declares the disclosure it controls', async () => {
    list.mockResolvedValue([AUTO])
    renderSection()
    const toggle = await screen.findByRole('button', { name: 'Backup history' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(toggle).toHaveAttribute('aria-controls', expect.any(String))
  })
})
