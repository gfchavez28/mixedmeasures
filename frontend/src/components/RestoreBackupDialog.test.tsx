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
 * - closing resets it, so the next dialog does not open on the last outcome;
 * - #1139/#1140: it fits the window, keeps its footer in view when the wait starts,
 *   moves focus to Close after a failure, and after one that may have replaced
 *   anything offers no second Restore — while a failure that changed nothing keeps
 *   Restore and does not hold the page.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query'
import type { RestorePreview, RestoreResult } from '@/lib/api'
import { ApiError } from '@/lib/api/client'
import { formatTakenAt } from '@/lib/safety-copies'
import { DIALOG_FITS_VIEWPORT } from '@/components/ConfirmDialog'

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
  warnings: string[] = [],
): RestorePreview {
  return {
    manifest: {
      format_version: 1,
      app_version: '1.5.3',
      created_at: '2026-09-20T02:07:36+00:00',
      backup_type: 'auto',
      db_size_bytes: 1024,
      // #1160: FILE counts, deliberately unlike anything the preview should show —
      // 12 = 2 documents × 5 extracted images + 2; 6 = 3 recordings + 2 canvas
      // images + 1 half-finished upload (the review's fixture).
      document_count: 12,
      media_file_count: 6,
      video_excluded: videoFiles !== null,
      video_files_excluded: videoFiles ?? 0,
      project_summaries: summaries,
      project_summaries_unavailable: summariesUnavailable,
    },
    warnings,
    recording_count: 3,
  }
}

/** The shape `client.ts` throws: header names lower-cased, as `Headers` iterates them. */
function restoreFailure(status: number, detail: string, headers: Record<string, string> = {}) {
  return new ApiError(status, { detail }, headers)
}

const NOT_STARTED_DETAIL =
  'The restore did not start: this backup could not be read (it is not a valid ZIP file). ' +
  'Nothing was changed.'
const PARTWAY_DETAIL =
  'Restore failed partway. Your data as it was before the restore was saved first, as the ' +
  'latest “Before a restore” backup in Backup history — restore that backup to return to the prior state.'

const NORTHGATE = {
  name: 'Northgate Health, 2024–26', conversation_count: 3, dataset_count: 1,
  document_count: 15, observation_count: 2,
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
  warnings = [],
  onClose,
  onReload,
}: {
  source?: RestoreSource
  videoFiles?: number | null
  summariesUnavailable?: boolean
  summaries?: RestorePreview['manifest']['project_summaries']
  warnings?: string[]
  onClose: () => void
  onReload: () => void
}) {
  const [open, setOpen] = useState(true)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>reopen</button>
      <RestoreBackupDialog
        source={open ? source : null}
        preview={open ? preview(videoFiles, summariesUnavailable, summaries, warnings) : null}
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
  warnings?: string[]
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
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
})

describe('RestoreBackupDialog', () => {
  it('#1132/#1164 (c): a project line is in full words, separated from its name by TEXT', () => {
    renderDialog({ summaries: [NORTHGATE] })
    // A text separator, not a margin: the computed text read "…2024–26(3 conv, …".
    expect(screen.getByText(/^Northgate Health/).textContent).toBe(
      'Northgate Health, 2024–26 — 3 conversations, 1 dataset, 15 documents, 2 observations',
    )
  })

  it('#1164 (c): thousands separators and plurals; a kind with none is left out', () => {
    renderDialog({ summaries: [
      { name: 'Survey', conversation_count: 1, dataset_count: 0, document_count: 1204, observation_count: 0 },
      { name: 'Empty', conversation_count: 0, dataset_count: 0, document_count: 0, observation_count: 0 },
    ] })
    expect(screen.getByText(/^Survey/).textContent).toBe(
      `Survey — 1 conversation, ${(1204).toLocaleString()} documents`,
    )
    expect(screen.getByText(/^Empty/).textContent).toBe(
      'Empty — no conversations, datasets, documents or observations',
    )
  })

  it('#1160: the description carries the TOTALS, and not one line per project', () => {
    renderDialog({ summaries: [NORTHGATE, { ...NORTHGATE, name: 'Riverside' }] })
    expect(dialog()).toHaveAccessibleDescription(
      /This backup holds 2 projects: 6 conversations, 2 datasets, 30 documents, 4 observations\./,
    )
    // The lines are on screen, outside the description a reader hears on open.
    expect(screen.getByText(/^Riverside/)).toBeInTheDocument()
    expect(dialog()).not.toHaveAccessibleDescription(/Riverside/)
  })

  it('names a backup from the list WITH its article — "the contents of the “Automatic” backup …"', () => {
    renderDialog()
    expect(dialog()).toHaveAccessibleDescription(
      new RegExp(`with the contents of the ${LOCAL.name}\\.`),
    )
  })

  it('#1160: the server’s warnings stay in the description', () => {
    renderDialog({ warnings: ['This backup was made by an earlier version of Mixed Measures (1.5.3).'] })
    expect(dialog()).toHaveAccessibleDescription(/made by an earlier version of Mixed Measures \(1\.5\.3\)/)
  })

  it('#1160: no Documents row, and Recordings counts RECORDINGS, not files', () => {
    renderDialog({ videoFiles: 2 })
    // `document_count` (12) counts each document's extracted images; the project
    // lines carry the documents.
    expect(screen.queryByText('Documents')).not.toBeInTheDocument()
    expect(screen.queryByText(/\b12\b/)).not.toBeInTheDocument()
    // `media_file_count` (6) counts canvas images and partial uploads as recordings.
    expect(screen.getByText('Recordings').parentElement).toHaveTextContent(
      /^Recordings3 \(2 video not included\)$/,
    )
  })

  it('#1164 (c): Created is said the way the sentence naming a backup says it', () => {
    renderDialog()
    expect(screen.getByText('Created').parentElement).toHaveTextContent(
      `Created${formatTakenAt('2026-09-20T02:07:36+00:00')}`,
    )
  })

  it('#1139: it is held within the window in every state, and scrolls inside', async () => {
    restoreLocal.mockResolvedValue(RESULT)
    renderDialog()
    for (const cls of DIALOG_FITS_VIEWPORT.split(' ')) expect(dialog()).toHaveClass(cls)
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    await screen.findByRole('heading', { name: 'Restore complete' })
    for (const cls of DIALOG_FITS_VIEWPORT.split(' ')) expect(dialog()).toHaveClass(cls)
  })

  it('#1139: the footer is scrolled back into view when the wait appears above it', async () => {
    const scrolled: Element[] = []
    HTMLElement.prototype.scrollIntoView = function (this: Element) { scrolled.push(this) }
    const pending = deferred<RestoreResult>()
    restoreLocal.mockReturnValue(pending.promise)
    renderDialog()
    expect(scrolled).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    await screen.findByRole('button', { name: 'Restoring...' })
    expect(scrolled).toEqual([screen.getByRole('button', { name: 'Cancel' })])
    // …leaving the dialog's own bottom padding visible below it (technique only:
    // jsdom has no layout; measured flush against the edge without it).
    expect(scrolled[0]).toHaveClass('scroll-mb-6')
    await act(async () => pending.resolve(RESULT))
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
      `The ${LOCAL.name} has been restored.`,
    )
    // #1139 (r3 N3): nothing reloads until the button is pressed, so it says so.
    expect(screen.getByText(/has been restored/)).toHaveTextContent(
      'Reload Mixed Measures to open the restored data.',
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
    expect(dialog()).toHaveAccessibleDescription(
      /The project list could not be read when this backup was made/,
    )
    expect(dialog()).not.toHaveAccessibleDescription(/This backup holds/)
  })

  it('#1039 (k) — an empty list WITHOUT the flag claims nothing (an older backup looks the same)', () => {
    renderDialog()
    expect(screen.queryByText(/Projects:/)).not.toBeInTheDocument()
    expect(screen.queryByText(/could not be read/)).not.toBeInTheDocument()
    expect(screen.queryByText(/This backup holds/)).not.toBeInTheDocument()
  })

  it('says nothing about video when a backup left none out', async () => {
    // Every automatic backup sets the flag; driving #1024 showed "did not
    // include 0 video recordings" on a project with no video at all.
    restoreLocal.mockResolvedValue(RESULT)
    renderDialog({ videoFiles: 0 })
    expect(screen.getByText('Recordings').parentElement).toHaveTextContent(/^Recordings3$/)
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    await screen.findByRole('heading', { name: 'Restore complete' })
    expect(screen.queryByText(/video recording/)).not.toBeInTheDocument()
  })

  it('keeps a failure on screen, refreshes the list once it is read, and resets', async () => {
    // A partway failure from a server that did not know the backup's time: its own
    // sentence, verbatim.
    restoreLocal.mockRejectedValue(
      restoreFailure(500, PARTWAY_DETAIL, { 'x-mm-restore-outcome': 'partway' }),
    )
    const { invalidate, onClose, defaultMutationError } = renderDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(PARTWAY_DETAIL)
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

  it('says what it does not know when no answer came back — and offers no second restore', async () => {
    restoreLocal.mockRejectedValue(new TypeError('Failed to fetch'))
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /whether the restore finished is not known/,
    )
    expect(screen.queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument()
    expect(onlineManager.isOnline()).toBe(false)
  })

  describe('#1139/#1140 — after a failure', () => {
    it('focus is on Close, so a second Enter cannot run the restore again', async () => {
      restoreLocal.mockRejectedValue(
        restoreFailure(500, PARTWAY_DETAIL, { 'x-mm-restore-outcome': 'partway' }),
      )
      renderDialog()
      const confirm = screen.getByRole('button', { name: 'Restore' })
      confirm.focus()
      fireEvent.click(confirm)
      await screen.findByRole('alert')
      await waitFor(() => expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus())
    })

    it('PARTWAY: Restore is gone, the page stays held, and the way back is named by its time', async () => {
      const takenAt = '2026-10-14T12:12:45+00:00'
      restoreLocal.mockRejectedValue(restoreFailure(500, PARTWAY_DETAIL, {
        'x-mm-restore-outcome': 'partway',
        'x-mm-pre-restore-taken-at': takenAt,
      }))
      renderDialog()
      fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
      const alert = await screen.findByRole('alert')
      // As Backup history shows it — the filename's UTC digits disagreed with
      // every row by the zone offset (#1140, r3 N1).
      expect(alert).toHaveTextContent(
        `as the “Before a restore” backup from ${formatTakenAt(takenAt)} in Backup history`,
      )
      expect(alert).not.toHaveTextContent(/latest/)
      expect(within(dialog()!).queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument()
      expect(onlineManager.isOnline()).toBe(false)
    })

    it('UNKNOWN side (no header): read as partway — no second Restore, the page held', async () => {
      restoreLocal.mockRejectedValue(restoreFailure(500, 'The restore failed (OSError: x).'))
      renderDialog()
      fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('The restore failed (OSError: x).')
      expect(screen.queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument()
      expect(onlineManager.isOnline()).toBe(false)
    })

    it('NOT STARTED: the server’s sentence, Restore kept for a retry, and the page not held', async () => {
      restoreLocal
        .mockRejectedValueOnce(restoreFailure(400, NOT_STARTED_DETAIL, { 'x-mm-restore-outcome': 'not-started' }))
        .mockResolvedValueOnce(RESULT)
      const { invalidate } = renderDialog()
      fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
      expect(await screen.findByRole('alert')).toHaveTextContent(NOT_STARTED_DETAIL)
      await waitFor(() => expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus())
      // Nothing was replaced, so the session is one the database knows: nothing to
      // hold, and the rest of the page may refresh while this is read.
      expect(onlineManager.isOnline()).toBe(true)
      expect(invalidate).not.toHaveBeenCalled()

      // …and trying again is safe, so it is offered.
      fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
      expect(await screen.findByRole('heading', { name: 'Restore complete' })).toBeInTheDocument()
      expect(restoreLocal).toHaveBeenCalledTimes(2)
    })
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
