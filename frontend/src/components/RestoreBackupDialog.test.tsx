/**
 * #1037 — the restore dialog stays open for the whole restore, and says how it
 * ended.
 *
 * The behaviours under test:
 * - pressing Restore does NOT close the dialog. Radix's `AlertDialogAction` is a
 *   Close, and its own close ran in the same click with the pre-click
 *   `isPending === false`, so the busy state never rendered and a restore that
 *   runs for minutes showed nothing — which invited editing during it (#1024);
 * - while it runs, nothing closes it (Cancel, Escape) and the wait says what it is;
 * - when it finishes, the dialog NAMES the backup of the data just replaced — the
 *   way back from the wrong restore — and waits for Reload instead of reloading
 *   under the sentence;
 * - when it fails, the server's sentence stays on screen and the backup list is
 *   refreshed, because a failure partway names a backup that list did not have;
 * - closing resets it, so the next dialog does not open on the last outcome.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query'
import type { RestorePreview, RestoreResult } from '@/lib/api'
import { ApiError } from '@/lib/api/client'
import { formatTakenAt } from '@/lib/safety-copies'

const restore = vi.fn()
const restoreLocal = vi.fn()
vi.mock('@/lib/api', () => ({
  backupApi: {
    restore: (...a: unknown[]) => restore(...a),
    restoreLocal: (...a: unknown[]) => restoreLocal(...a),
  },
}))

import RestoreBackupDialog, { type RestoreSource } from './RestoreBackupDialog'

const LOCAL: RestoreSource = {
  kind: 'local',
  filename: 'auto_20260920_020736.mmbackup',
  name: 'Automatic backup from 20 Sept 2026',
}

/** `videoFiles` excluded; `null` = a backup that took video with it. Every
 * automatic backup sets `video_excluded`, including one with nothing to exclude. */
function preview(
  videoFiles: number | null = null,
  summariesUnavailable = false,
  summaries: RestorePreview['manifest']['project_summaries'] = [],
): RestorePreview {
  return {
    manifest: {
      format_version: 1,
      app_version: '1.5.3',
      created_at: '2026-09-20T02:07:36+00:00',
      backup_type: 'auto',
      db_size_bytes: 1024,
      document_count: 2,
      media_file_count: 1,
      video_excluded: videoFiles !== null,
      video_files_excluded: videoFiles ?? 0,
      project_summaries: summaries,
      project_summaries_unavailable: summariesUnavailable,
    },
    warnings: [],
  }
}

const RESULT: RestoreResult = {
  status: 'restored',
  pre_restore_backup: 'pre_restore_20260924_213000.mmbackup',
  pre_restore_taken_at: '2026-09-24T21:30:00+00:00',
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** The page's side of the contract: `onClose` really does close it. */
function Harness({
  source = LOCAL,
  videoFiles = null,
  summariesUnavailable = false,
  summaries = [],
  onClose,
  onReload,
}: {
  source?: RestoreSource
  videoFiles?: number | null
  summariesUnavailable?: boolean
  summaries?: RestorePreview['manifest']['project_summaries']
  onClose: () => void
  onReload: () => void
}) {
  const [open, setOpen] = useState(true)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>reopen</button>
      <RestoreBackupDialog
        source={open ? source : null}
        preview={open ? preview(videoFiles, summariesUnavailable, summaries) : null}
        onClose={() => {
          onClose()
          setOpen(false)
        }}
        onReload={onReload}
      />
    </>
  )
}

function renderDialog(props: {
  source?: RestoreSource
  videoFiles?: number | null
  summariesUnavailable?: boolean
  summaries?: RestorePreview['manifest']['project_summaries']
} = {}) {
  // `main.tsx`'s mutation default, which toasts "Something went wrong" over any
  // error a mutation does not handle itself.
  const defaultMutationError = vi.fn()
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { onError: defaultMutationError } },
  })
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  const onClose = vi.fn()
  const onReload = vi.fn()
  render(
    <QueryClientProvider client={client}>
      <Harness {...props} onClose={onClose} onReload={onReload} />
    </QueryClientProvider>,
  )
  return { invalidate, onClose, onReload, defaultMutationError }
}

const dialog = () => screen.queryByRole('alertdialog')

afterEach(() => {
  cleanup()
  restore.mockReset()
  restoreLocal.mockReset()
  // Module-global state: a test that ends on an outcome must not leave the next
  // one offline.
  onlineManager.setOnline(true)
})

describe('RestoreBackupDialog', () => {
  it('#1132: a project and its counts are separated by a SPACE in the description, not a margin', () => {
    renderDialog({ summaries: [{
      name: 'Northgate Health, 2024–26', conversation_count: 3, dataset_count: 1,
      document_count: 15, observation_count: 2,
    }] })
    expect(dialog()).toHaveAccessibleDescription(/Northgate Health, 2024–26 \(3 conv, 1 ds, 15 doc, 2 obs\)/)
  })

  it('stays open while the restore runs, and says it is running (#1037)', async () => {
    const pending = deferred<RestoreResult>()
    restoreLocal.mockReturnValue(pending.promise)
    const { onClose } = renderDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))

    const busy = await screen.findByRole('button', { name: 'Restoring...' })
    expect(dialog()).toBeInTheDocument()
    expect(busy).toHaveAttribute('aria-busy', 'true')
    expect(busy).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText(/Keep Mixed Measures open until it finishes/)).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Restoring.')
    expect(restoreLocal).toHaveBeenCalledWith(LOCAL.filename)

    // Nothing closes it while the files are being replaced.
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    // …and a second press does not send a second restore. TanStack starts a
    // mutation's request a turn AFTER `mutate`, so the count is read after one —
    // read synchronously it passes with the guard deleted (mutation-proven), and a
    // second request would be refused by the server as "already running" and that
    // refusal would replace the running restore on screen.
    fireEvent.click(busy)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(dialog()).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    expect(restoreLocal).toHaveBeenCalledTimes(1)

    await act(async () => pending.resolve(RESULT))
  })

  it('names the way back when it finishes, and reloads only when asked', async () => {
    restoreLocal.mockResolvedValue(RESULT)
    const { onReload, invalidate } = renderDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))

    expect(await screen.findByRole('heading', { name: 'Restore complete' })).toBeInTheDocument()
    expect(screen.getByText(/has been restored/)).toHaveTextContent(
      `${LOCAL.name} has been restored.`,
    )
    expect(screen.getByText(/was saved first/)).toHaveTextContent(
      `as the “Before a restore” backup from ${formatTakenAt(RESULT.pre_restore_taken_at)}`,
    )
    const reload = screen.getByRole('button', { name: 'Reload Mixed Measures' })
    await waitFor(() => expect(reload).toHaveFocus())
    // Its description is the finished sentence, so focusing it says what happened.
    expect(reload).toHaveAccessibleDescription(/has been restored/)

    // It does not reload under the sentence, and it cannot be dismissed onto a
    // page still showing the replaced data.
    fireEvent.keyDown(reload, { key: 'Escape' })
    expect(dialog()).toBeInTheDocument()
    expect(onReload).not.toHaveBeenCalled()
    // Nothing on the page may fetch: a request now meets a session the restored
    // database has never seen, and the 401 reloads the page under the sentence.
    expect(invalidate).not.toHaveBeenCalled()
    expect(onlineManager.isOnline()).toBe(false)

    fireEvent.click(reload)
    expect(onReload).toHaveBeenCalledTimes(1)
  })

  it('#1084 (a) — a reconnect while the outcome shows does not bring the page back online', async () => {
    // TanStack's own `online` listener undid a plain `setOnline(false)`: a Wi-Fi
    // reconnect, or a laptop woken on this screen, ran the paused fetches, the
    // first 401 reloaded the page, and "Restore complete" was gone unread.
    restoreLocal.mockResolvedValue(RESULT)
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    await screen.findByRole('heading', { name: 'Restore complete' })
    expect(onlineManager.isOnline()).toBe(false)

    act(() => { window.dispatchEvent(new Event('online')) })
    expect(onlineManager.isOnline()).toBe(false)
    expect(dialog()).toBeInTheDocument()
  })

  it('#1084 (a) — once a failure is closed, the browser’s online events count again', async () => {
    // The hold REPLACES the library's listener; closing must put a working one
    // back, or the page would never learn it went offline again.
    restoreLocal.mockRejectedValue(new ApiError(500, { detail: 'x' }, {}))
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(dialog()).not.toBeInTheDocument())
    expect(onlineManager.isOnline()).toBe(true)

    act(() => { window.dispatchEvent(new Event('offline')) })
    expect(onlineManager.isOnline()).toBe(false)
    act(() => { window.dispatchEvent(new Event('online')) })
    expect(onlineManager.isOnline()).toBe(true)
  })

  it('keeps the video notice on screen instead of in a toast before a reload', async () => {
    restoreLocal.mockResolvedValue(RESULT)
    renderDialog({ videoFiles: 3 })
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    expect(await screen.findByText(/did not include 3 video recordings/)).toBeInTheDocument()
  })

  it('#1039 (k) — says the project list could not be read, rather than showing no section', async () => {
    renderDialog({ summariesUnavailable: true })
    expect(screen.getByText(/the project list could not be read when this backup was made/))
      .toBeInTheDocument()
  })

  it('#1039 (k) — an empty list WITHOUT the flag claims nothing (an older backup looks the same)', () => {
    renderDialog()
    expect(screen.queryByText(/Projects:/)).not.toBeInTheDocument()
    expect(screen.queryByText(/could not be read/)).not.toBeInTheDocument()
  })

  it('says nothing about video when a backup left none out', async () => {
    // Every automatic backup sets the flag; driving #1024 showed "did not
    // include 0 video recordings" on a project with no video at all.
    restoreLocal.mockResolvedValue(RESULT)
    renderDialog({ videoFiles: 0 })
    expect(screen.getByText('Recordings').parentElement).toHaveTextContent(/^Recordings1$/)
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    await screen.findByRole('heading', { name: 'Restore complete' })
    expect(screen.queryByText(/video recording/)).not.toBeInTheDocument()
  })

  it('keeps a failure on screen, refreshes the list once it is read, and resets', async () => {
    const detail =
      "Restore failed partway. Your previous data was saved as 'pre_restore_20260924_213000.mmbackup' " +
      'before the restore began — restore that backup from Backup history to return to the prior state.'
    restoreLocal.mockRejectedValue(new ApiError(500, { detail }, {}))
    const { invalidate, onClose, defaultMutationError } = renderDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(detail)
    expect(dialog()).toBeInTheDocument()
    // …and not ALSO a generic "Something went wrong" toast over it.
    expect(defaultMutationError).not.toHaveBeenCalled()
    // Not while the sentence is showing: if the swap happened, the refresh meets
    // the new database, and its 401 would reload the page over the sentence.
    expect(invalidate).not.toHaveBeenCalled()
    expect(onlineManager.isOnline()).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(dialog()).not.toBeInTheDocument())
    expect(onClose).toHaveBeenCalledTimes(1)
    // The "Before a restore" backup the sentence names was not in the list.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['backup-list'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['backup-status'] })
    expect(onlineManager.isOnline()).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'reopen' }))
    expect(await screen.findByRole('button', { name: 'Restore' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('says what it does not know when no answer came back', async () => {
    restoreLocal.mockRejectedValue(new TypeError('Failed to fetch'))
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /whether the restore finished is not known/,
    )
  })

  it('restores an uploaded file through the upload door', async () => {
    const file = new File(['x'], 'from-another-computer.mmbackup')
    restore.mockResolvedValue(RESULT)
    renderDialog({ source: { kind: 'upload', file, name: file.name } })
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    await screen.findByRole('heading', { name: 'Restore complete' })
    expect(restore).toHaveBeenCalledWith(file)
    expect(restoreLocal).not.toHaveBeenCalled()
  })
})
