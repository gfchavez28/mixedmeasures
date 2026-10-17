import { useEffect, useId, useRef, type RefObject } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { LoaderCircle } from 'lucide-react'
import { backupApi, type RestorePreview, type RestoreResult } from '@/lib/api'
import { restoreFailureOutcome } from '@/lib/api/backup'
import { serverDetailMessage } from '@/lib/api/error-utils'
import { formatBytes } from '@/lib/format'
import { formatTakenAt } from '@/lib/safety-copies'
import {
  backupContentsSentence,
  describeBackup,
  partwayFailureSentence,
  sourceCountsPhrase,
} from '@/lib/backup-history'
import { holdPageForRestoreOutcome } from '@/lib/restore-outcome-hold'
import { useKeepInViewWhen } from '@/hooks/useKeepInViewWhen'
import LongWaitStatus from '@/components/LongWaitStatus'
import { DIALOG_FITS_VIEWPORT } from '@/components/ConfirmDialog'
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
 * The shared `LongWaitStatus` (since #1054), WITHOUT an estimate:
 * nobody has timed a restore on real data, and its length depends on the size of
 * the recordings as much as the database. Mounted only while the restore runs, so
 * each run starts its clock at zero.
 */
function RestoringStatus() {
  return (
    <LongWaitStatus
      label="Restoring…"
      firstAnnouncement="Restoring. Keep Mixed Measures open until this finishes."
    >
      Your current data is saved as a backup first, then replaced. It takes longer the
      larger the backup is. Keep Mixed Measures open until it finishes.
    </LongWaitStatus>
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
 *   that backup is there. #1140: the server says WHICH side of the swap it stopped
 *   on (`restoreFailureOutcome`). Before it (`not-started`) nothing changed, so
 *   Restore stays — a retry is safe — and the page is not held. After it, or when
 *   the side is unknown, Restore is GONE: the sentence says to restore a DIFFERENT
 *   backup, and a second press of this one ran a whole second restore (driven,
 *   2026-10-14 — focus had stayed on Restore, so a second Enter did it).
 * - While an outcome shows, the page fetches nothing (the `onlineManager` effect
 *   below says why, and what driving it found) — except after `not-started`.
 * - #1139: capped at the window and scrolling inside (`DIALOG_FITS_VIEWPORT`). At
 *   640×360 it ran off both edges in every state but the restored one; at
 *   1280×800 the confirm did from ~18 projects. Two things then keep the part that
 *   matters on screen: the footer is scrolled back into view when the wait panel
 *   appears above it, and a failure moves focus to Close, which scrolls Close and
 *   the sentence above it into view.
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
  const cancelRef = useRef<HTMLButtonElement>(null)

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
  const failed = restore.isError
  const outcome = failed ? restoreFailureOutcome(restore.error) : null
  // #1140: the ONE failure after which pressing Restore again is safe. A failure
  // with no header is read as partway — a restore may have begun.
  const retrySafe = outcome?.side === 'not-started'
  const holdPage = restored || (failed && !retrySafe)

  useEffect(() => {
    // The Reload button is a NEW element, so moving focus to it is what makes a
    // screen reader say it — and its description — at all.
    if (restored) reloadRef.current?.focus()
  }, [restored])

  useEffect(() => {
    // #1139 — after ANY failure, focus goes to Close. Left on Restore, a second
    // Enter ran a full second restore (driven, 2026-10-14), and at 640×360 the
    // failure sentence sat below the fold with the focused button out of view:
    // focusing Close scrolls it, and the alert just above it, into view.
    if (failed) cancelRef.current?.focus()
  }, [failed])

  // #1139 — the wait panel is inserted ABOVE the footer while the dialog's scroll
  // position stays put, so the focused "Restoring…" button slid below the visible
  // part of a capped dialog (measured at 640×360: 439–475 px in a box ending at 344).
  useKeepInViewWhen(restore.isPending, cancelRef)

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
    // #1084 (a): the hold replaces TanStack's own `online` listener (a reconnect
    // undid a plain `setOnline(false)`) and holds `client.ts`'s 401 reload for any
    // request that does not go through React Query.
    // #1140: NOT after a `not-started` failure — the database was never replaced,
    // so the session is still one it knows, and holding the page would only stop
    // the rest of Settings refreshing while the researcher reads and retries.
    if (!holdPage) return
    return holdPageForRestoreOutcome()
  }, [holdPage])

  const close = () => {
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

  // A partway failure names its way back as Backup history shows it, when the
  // server sent the time (#1140); otherwise the server's sentence, else ours.
  const failure = !failed
    ? null
    : outcome?.preRestoreTakenAt
      ? partwayFailureSentence(formatTakenAt(outcome.preRestoreTakenAt))
      : (serverDetailMessage(restore.error) ?? NO_ANSWER_MESSAGE)

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
      <AlertDialogContent className={DIALOG_FITS_VIEWPORT}>
        {restored && restore.data ? (
          <RestoredView
            sourceName={source ? (source.kind === 'local' ? `The ${source.name}` : source.name) : 'The backup'}
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
                    {/* A backup from the list is named as a phrase (`backupTitle`:
                      * “Automatic” backup from …), so it takes "the"; a picked file is
                      * its filename and does not (10-14: "the contents of “Automatic”
                      * backup from …"). */}
                    This will replace all current data with the contents of{' '}
                    {source?.kind === 'local' ? 'the ' : ''}
                    <span className="font-medium text-mm-text">{source?.name ?? 'this backup'}</span>
                    . A safety backup will be created automatically before restoring.
                  </p>
                  {preview && <PreviewSummary preview={preview} />}
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>

            {/* Outside the description (#1160): every project line was read aloud
              * when the dialog opened — eighteen of them on a real install. The
              * totals and the warnings above are what a reader must hear; this is
              * the detail, there to be read on screen or in browse mode. */}
            {preview && <PreviewDetails preview={preview} />}

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
              {/* `scroll-mb-6` = the dialog's own bottom padding: scrolled into view
                * by `useKeepInViewWhen` or by the focus move after a failure, the
                * footer otherwise landed flush against the dialog's edge (measured
                * at 1280×800: buttons 747–783 in a box ending at 784). */}
              <AlertDialogCancel
                ref={cancelRef}
                aria-disabled={restore.isPending || undefined}
                className="scroll-mb-6"
              >
                {failed ? 'Close' : 'Cancel'}
              </AlertDialogCancel>
              {/* #1140: gone after a failure that may have replaced anything — the
                * sentence above names a DIFFERENT backup to restore. Kept after
                * `not-started`, where nothing changed and a retry is safe. */}
              {(!failed || retrySafe) && (
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
              )}
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** What a reader must hear when the dialog opens — inside its description: what the
 * backup holds in total, that the list could not be read when that is so, and the
 * server's warnings (an older version to upgrade, video left out, too little disk). */
function PreviewSummary({ preview }: { preview: RestorePreview }) {
  const m = preview.manifest
  // Null for an empty list — the unavailable case (the server writes `[]` beside the
  // flag) and an older backup's silent failure alike claim nothing (#961).
  const contents = backupContentsSentence(m.project_summaries)
  return (
    <>
      {contents && <p>{contents}</p>}
      {/* #1039 (k) — said, not left as an absent section: an empty list here read
          as "this backup holds nothing". An empty list WITHOUT the flag stays
          silent, because a backup taken before the flag existed cannot tell its
          own failure from an install with no projects. */}
      {m.project_summaries_unavailable && (
        <p>
          The project list could not be read when this backup was made, so what it
          holds is not shown here. The backup can still be restored.
        </p>
      )}
      {preview.warnings.length > 0 && (
        <div className="rounded border border-amber-300 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/20 p-2 space-y-1">
          {preview.warnings.map((w, i) => (
            <p key={i} className="text-xs text-amber-800 dark:text-amber-300">{w}</p>
          ))}
        </div>
      )}
    </>
  )
}

function PreviewDetails({ preview }: { preview: RestorePreview }) {
  const m = preview.manifest
  return (
    <div className="rounded-md border border-mm-border-subtle bg-mm-bg p-3 text-sm space-y-2">
      <div className="flex justify-between gap-3">
        <span className="text-mm-text-muted">Created</span>
        {/* #1164 (c): the formatter the sentence naming this backup uses, so the
            two agree to the second (and an unparseable stamp shows as itself,
            never "Invalid Date"). */}
        <span className="text-mm-text text-right">{formatTakenAt(m.created_at)}</span>
      </div>
      <div className="flex justify-between gap-3">
        <span className="text-mm-text-muted">App version</span>
        <span className="text-mm-text">{m.app_version}</span>
      </div>
      <div className="flex justify-between gap-3">
        <span className="text-mm-text-muted">Database size</span>
        <span className="text-mm-text">{formatBytes(m.db_size_bytes)}</span>
      </div>
      {/* #1160: no Documents row — the manifest's `document_count` counts FILES
          (each document's extracted images too), so it sat at 69 over projects
          totalling 4; the project lines below carry the documents. Recordings are
          counted from the archive's members, not `media_file_count` (which counts
          canvas images and half-finished uploads as recordings). */}
      <div className="flex justify-between gap-3">
        <span className="text-mm-text-muted">Recordings</span>
        <span className="text-mm-text text-right">
          {preview.recording_count.toLocaleString()}
          {m.video_files_excluded > 0 && ` (${m.video_files_excluded.toLocaleString()} video not included)`}
        </span>
      </div>
      {m.project_summaries.length > 0 && (
        <div>
          <span className="text-mm-text-muted text-xs">Projects:</span>
          <ul className="mt-1 space-y-0.5">
            {m.project_summaries.map((p, i) => (
              <li key={i} className="text-mm-text text-xs">
                {/* #1132 — a TEXT separator: a margin is not one, so the dialog's
                    description read "…2024–26(3 conv, …" (#908's rule). */}
                {p.name}{' — '}
                <span className="text-mm-text-faint">{sourceCountsPhrase(p)}</span>
              </li>
            ))}
          </ul>
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
                {/* #1139 (r3 N3): not "Mixed Measures reloads…" — nothing reloads
                    until the button below is pressed. */}
                <span className="font-medium text-mm-text">{sourceName}</span> has been restored.
                Reload Mixed Measures to open the restored data.
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
