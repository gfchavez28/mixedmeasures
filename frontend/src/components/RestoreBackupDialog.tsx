import { useEffect, useId, useRef, type RefObject } from 'react'
import { onlineManager, useMutation, useQueryClient } from '@tanstack/react-query'
import { LoaderCircle } from 'lucide-react'
import { backupApi, type RestorePreview, type RestoreResult } from '@/lib/api'
import { serverDetailMessage } from '@/lib/api/error-utils'
import { formatBytes } from '@/lib/format'
import { formatTakenAt } from '@/lib/safety-copies'
import { describeBackup } from '@/lib/backup-history'
import { useElapsedSeconds } from '@/hooks/useElapsedSeconds'
import { ANNOUNCE_EVERY_SECONDS, elapsedOnlyNote, stillWorkingMessage } from '@/lib/elapsed-progress'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog'

/** Where a restore is reading from (#971). Two doors, and the dialog, the
 * confirm handler and the audit trail each need to know which — so they are two
 * shapes, never one nullable file. */
export type RestoreSource =
  | { kind: 'upload'; file: File; name: string }
  | { kind: 'local'; filename: string; name: string }

interface RestoreVars {
  source: RestoreSource
  videoExcluded: boolean
  videoFilesExcluded: number
}

/** What the researcher is told when the request itself failed — no server
 * answer, so no sentence of the server's to show. Whether the restore STARTED is
 * not known; the one thing that is known is where the evidence would be. */
const NO_ANSWER_MESSAGE =
  'Mixed Measures did not answer, so whether the restore finished is not known. ' +
  'Close this and look in Backup history: a “Before a restore” backup is listed there if it started.'

function reloadApp() {
  window.location.href = '/'
}

/**
 * The wait while a restore runs (#1037). It could not be seen at all: the dialog
 * closed the moment Restore was pressed, so a restore that runs for minutes showed
 * nothing — which invited editing during it (#1024) or quitting halfway.
 *
 * The shared long-wait helpers (`lib/elapsed-progress.ts`), WITHOUT an estimate:
 * nobody has timed a restore on real data, and its length depends on the size of
 * the recordings as much as the database. Mounted only while the restore runs, so
 * each run starts its clock at zero.
 */
function RestoringStatus() {
  const elapsed = useElapsedSeconds(true)
  const bucket = Math.floor(elapsed / ANNOUNCE_EVERY_SECONDS)
  // The spoken line changes only when a 30-second bucket is crossed.
  const spoken = bucket === 0
    ? 'Restoring. Keep Mixed Measures open until this finishes.'
    : stillWorkingMessage(bucket * ANNOUNCE_EVERY_SECONDS, false)
  return (
    <div className="rounded-md border border-mm-border-subtle bg-mm-bg p-3 space-y-1.5 text-sm">
      <p className="flex items-center gap-2 font-medium text-mm-text">
        <LoaderCircle className="w-4 h-4 animate-spin" aria-hidden="true" /> Restoring…
      </p>
      <p className="text-mm-text-muted">
        Your current data is saved as a backup first, then replaced. It takes longer the
        larger the backup is. Keep Mixed Measures open until it finishes.
      </p>
      <p className="text-xs text-mm-text-muted" aria-hidden="true">{elapsedOnlyNote(elapsed)}</p>
      <p role="status" className="sr-only">{spoken}</p>
    </div>
  )
}

interface RestoreBackupDialogProps {
  /** The backup being restored; the dialog is open while `preview` is set. */
  source: RestoreSource | null
  preview: RestorePreview | null
  /** Called when the researcher closes the dialog — never while a restore runs. */
  onClose: () => void
  /** Injected for tests; reloading is how the app picks up the restored data. */
  onReload?: () => void
}

/**
 * Confirm a restore, wait for it, and say how it ended — all in one dialog.
 *
 * 🔴 **The confirm button must not close the dialog (#1037).** Radix's
 * `AlertDialogAction` is a Close: its own `onOpenChange(false)` runs in the same
 * click, with the PRE-click `isPending === false`, so the dialog unmounted before
 * the busy state could render. `preventDefault()` stops that — `ConfirmDialog`'s
 * shape — and the dialog now leaves only when the researcher closes it.
 *
 * Four states, one dialog: confirm → restoring → restored | failed.
 * - **restoring** refuses every close (the Root's `onOpenChange`, Cancel's
 *   `aria-disabled`, the confirm's `isPending` guard).
 * - **restored** does not reload by itself and cannot be dismissed. It names the
 *   backup of the data just replaced — the way back from the wrong restore, which
 *   the server always reported and nothing ever showed — and the video notice that
 *   used to be a 4.5-second toast before an automatic reload. The researcher reads
 *   it, then presses Reload.
 * - **failed** keeps the server's sentence ON SCREEN. A failure partway names the
 *   backup to restore from; a toast that vanishes is the wrong place for the one
 *   instruction that matters. The list is refreshed when the dialog closes, so
 *   that backup is there.
 * - While an outcome shows, the page fetches nothing (the `onlineManager` effect
 *   below says why, and what driving it found).
 */
export default function RestoreBackupDialog({
  source,
  preview,
  onClose,
  onReload = reloadApp,
}: RestoreBackupDialogProps) {
  const queryClient = useQueryClient()
  const doneTextId = useId()
  const reloadRef = useRef<HTMLButtonElement>(null)

  const restore = useMutation<RestoreResult, Error, RestoreVars>({
    // The video facts ride the VARIABLES, not the preview prop, so the finished
    // screen describes the restore that ran whatever the parent does meanwhile.
    mutationFn: (vars) =>
      vars.source.kind === 'upload'
        ? backupApi.restore(vars.source.file)
        : backupApi.restoreLocal(vars.source.filename),
    // Declared so `main.tsx`'s default ("Something went wrong. Please try again.")
    // does not toast over the server's own sentence, which the dialog shows.
    onError: () => {},
  })

  const restored = restore.isSuccess
  const showingOutcome = restore.isSuccess || restore.isError

  useEffect(() => {
    // The Reload button is a NEW element, so moving focus to it is what makes a
    // screen reader say it — and its description — at all.
    if (restored) reloadRef.current?.focus()
  }, [restored])

  useEffect(() => {
    // 🔴 While an outcome is on screen, NOTHING on the page may fetch. After a
    // restore — or a failure partway through its swap — this browser's session is
    // one the restored database has never seen, so any request answers 401 and
    // `client.ts` reloads the page, taking the outcome with it unread. DRIVEN
    // (#1024): switching to another app during a restore and coming back after it
    // ended refetched the page's stale queries and reloaded, erasing "Restore
    // complete"; the failure sentence naming the backup to recover from is the one
    // that can least afford it. Offline, React Query holds every fetch until the
    // dialog is closed; after a success the page reloads instead.
    if (!showingOutcome) return
    onlineManager.setOnline(false)
    return () => onlineManager.setOnline(true)
  }, [showingOutcome])

  const close = () => {
    const failed = restore.isError
    // A closed dialog must not reopen showing the LAST restore's outcome.
    restore.reset()
    onClose()
    if (failed) {
      // A failure partway names a "Before a restore" backup the list did not have
      // when it was fetched. Refreshed on CLOSE, once the sentence has been read:
      // if the swap happened, this is the request that meets the new database, and
      // a reload is then the right thing and costs nothing.
      queryClient.invalidateQueries({ queryKey: ['backup-list'] })
      queryClient.invalidateQueries({ queryKey: ['backup-status'] })
    }
  }

  const handleConfirm = () => {
    // The refusal behind the button's `aria-disabled` (#754).
    if (restore.isPending || !source) return
    restore.mutate({
      source,
      videoExcluded: preview?.manifest.video_excluded ?? false,
      videoFilesExcluded: preview?.manifest.video_files_excluded ?? 0,
    })
  }

  const failure = restore.isError ? (serverDetailMessage(restore.error) ?? NO_ANSWER_MESSAGE) : null

  return (
    <AlertDialog
      open={preview !== null}
      onOpenChange={(open) => {
        // Refused while restoring — the files are being replaced, and closing
        // would only hide it — and once restored, where the only way on is Reload.
        if (restore.isPending || restored) return
        if (!open) close()
      }}
    >
      <AlertDialogContent>
        {restored && restore.data ? (
          <RestoredView
            sourceName={source?.name ?? 'The backup'}
            result={restore.data}
            vars={restore.variables}
            doneTextId={doneTextId}
            reloadRef={reloadRef}
            onReload={onReload}
          />
        ) : (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Restore from Backup</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-3">
                  <p>
                    {/* WHICH backup, named. Two doors reach this dialog (#971) and
                      * "this backup" is the same sentence for a file the researcher
                      * just picked and one chosen from a list of five that differ
                      * only by when they were taken. */}
                    This will replace all current data with the contents of{' '}
                    <span className="font-medium text-mm-text">{source?.name ?? 'this backup'}</span>
                    . A safety backup will be created automatically before restoring.
                  </p>
                  {preview && <PreviewDetails preview={preview} />}
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>

            {restore.isPending && <RestoringStatus />}
            {failure && (
              <div
                role="alert"
                className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800/40 dark:bg-red-950/40 dark:text-red-400"
              >
                {failure}
              </div>
            )}

            {/* 🔴 `aria-disabled`, never `disabled` (#965/#959 §4): Chrome BLURS a
              * focused button that becomes disabled, and this is the
              * longest-running dialog in the app. Each still needs a real refusal:
              * the confirm's is `handleConfirm`'s guard, Cancel's the Root's
              * `onOpenChange`. */}
            <AlertDialogFooter>
              <AlertDialogCancel aria-disabled={restore.isPending || undefined}>
                {restore.isError ? 'Close' : 'Cancel'}
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault()
                  handleConfirm()
                }}
                aria-disabled={restore.isPending || undefined}
                aria-busy={restore.isPending || undefined}
                className="bg-red-600 hover:bg-red-700 text-white"
              >
                {restore.isPending ? (
                  <>
                    <LoaderCircle className="w-3.5 h-3.5 mr-1.5 animate-spin" aria-hidden="true" />
                    Restoring...
                  </>
                ) : (
                  'Restore'
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  )
}

function PreviewDetails({ preview }: { preview: RestorePreview }) {
  const m = preview.manifest
  return (
    <div className="rounded-md border border-mm-border-subtle bg-mm-bg p-3 text-sm space-y-2">
      <div className="flex justify-between">
        <span className="text-mm-text-muted">Created</span>
        <span className="text-mm-text">{new Date(m.created_at).toLocaleString()}</span>
      </div>
      <div className="flex justify-between">
        <span className="text-mm-text-muted">App version</span>
        <span className="text-mm-text">{m.app_version}</span>
      </div>
      <div className="flex justify-between">
        <span className="text-mm-text-muted">Database size</span>
        <span className="text-mm-text">{formatBytes(m.db_size_bytes)}</span>
      </div>
      <div className="flex justify-between">
        <span className="text-mm-text-muted">Documents</span>
        <span className="text-mm-text">{m.document_count}</span>
      </div>
      <div className="flex justify-between">
        <span className="text-mm-text-muted">Recordings</span>
        <span className="text-mm-text">
          {m.media_file_count ?? 0}
          {m.video_files_excluded > 0 && ` (${m.video_files_excluded} video excluded)`}
        </span>
      </div>
      {m.project_summaries.length > 0 && (
        <div>
          <span className="text-mm-text-muted text-xs">Projects:</span>
          <ul className="mt-1 space-y-0.5">
            {m.project_summaries.map((p, i) => (
              <li key={i} className="text-mm-text text-xs">
                {p.name}
                <span className="text-mm-text-faint ml-1">
                  ({p.conversation_count} conv, {p.dataset_count} ds, {p.document_count} doc, {p.observation_count} obs)
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {preview.warnings.length > 0 && (
        <div className="rounded border border-amber-300 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/20 p-2 space-y-1">
          {preview.warnings.map((w, i) => (
            <p key={i} className="text-xs text-amber-800 dark:text-amber-300">{w}</p>
          ))}
        </div>
      )}
    </div>
  )
}

function RestoredView({
  sourceName,
  result,
  vars,
  doneTextId,
  reloadRef,
  onReload,
}: {
  sourceName: string
  result: RestoreResult
  vars: RestoreVars | undefined
  doneTextId: string
  reloadRef: RefObject<HTMLButtonElement | null>
  onReload: () => void
}) {
  const n = vars?.videoFilesExcluded ?? 0
  const beforeLabel = describeBackup({ backup_type: 'pre_restore' }).label
  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>Restore complete</AlertDialogTitle>
        {/* The id sits on an INNER element: on the Description itself it would
          * replace the id Radix gives it, and the dialog's own `aria-describedby`
          * would point at nothing. */}
        <AlertDialogDescription asChild>
          <div>
            <div id={doneTextId} className="space-y-3">
              <p>
                <span className="font-medium text-mm-text">{sourceName}</span> has been restored.
                Mixed Measures reloads to open the restored data.
              </p>
              <p>
                The data you had before this restore was saved first, as the “{beforeLabel}”
                backup from {formatTakenAt(result.pre_restore_taken_at)}. It is in Backup history
                if you need to go back.
              </p>
              {/* Only when something WAS left out: every automatic backup sets
                * the flag, and "did not include 0 video recordings" is noise. */}
              {vars?.videoExcluded && n > 0 && (
                <p className="rounded border border-amber-300 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/20 p-2 text-amber-800 dark:text-amber-300">
                  This backup did not include {n} video recording{n === 1 ? '' : 's'}. If a
                  conversation’s video is missing on this computer, re-attach it via “Replace
                  recording” in its workbench.
                </p>
              )}
            </div>
          </div>
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <Button ref={reloadRef} onClick={onReload} aria-describedby={doneTextId}>
          Reload Mixed Measures
        </Button>
      </AlertDialogFooter>
    </>
  )
}
