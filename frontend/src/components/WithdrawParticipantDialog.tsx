/**
 * #702(3) — honouring a withdrawal request.
 *
 * ## What this screen has to get right
 *
 * The researcher is about to act on a request from a real person, and will
 * probably record that they did. So the screen has to say three things plainly:
 * what will be removed, **what will not**, and that a backup is being taken.
 *
 * 🔴 **The limitation is IN the confirm, not in documentation.** This cannot find
 * the person's name inside other people's turns, or inside free-text answers,
 * notes and memos — that needs reading, by someone who knows the project. A
 * researcher who closes this dialog believing the withdrawal is complete, while
 * the name sits three turns later in the same conversation, is worse off than
 * with no feature at all. That sentence is the most important text here.
 *
 * 🔴 **The confirm must not close the dialog (#1025, #1037's shape).** Radix's
 * `AlertDialogAction` is a Close, so pressing it closed the dialog in the same
 * click and the busy state never rendered: nothing on screen said a backup and a
 * removal were running, and the person's row was still in the list — pressing
 * again started a SECOND backup and a second withdrawal — over a wait measured at
 * 38.7 s over HTTP and ~60 s in a browser on a 546 MB database.
 * `preventDefault()` keeps the dialog; it closes on success (the page's
 * `onSuccess`) or when the researcher cancels, never while the request runs.
 */
import { TriangleAlert, Info, LoaderCircle } from 'lucide-react'
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from '@/components/ui/alert-dialog'
import type { WithdrawalReport } from '@/lib/api'
import { removedSummary, keptSummary } from '@/lib/withdrawal-copy'
import { useElapsedSeconds } from '@/hooks/useElapsedSeconds'
import { ANNOUNCE_EVERY_SECONDS, elapsedOnlyNote, stillWorkingMessage } from '@/lib/elapsed-progress'

/** The wait, said once and then every 30 s — `RestoreBackupDialog`'s shape. No
 * estimate: no withdrawal has been timed on real data. */
function WithdrawingStatus() {
  const elapsed = useElapsedSeconds(true)
  const bucket = Math.floor(elapsed / ANNOUNCE_EVERY_SECONDS)
  const spoken = bucket === 0
    ? 'Taking a backup, then removing. Keep Mixed Measures open until this finishes.'
    : stillWorkingMessage(bucket * ANNOUNCE_EVERY_SECONDS, false)
  return (
    <div className="rounded-md border border-mm-border-subtle bg-mm-bg p-3 space-y-1 text-xs">
      <p className="flex items-center gap-2 font-medium text-mm-text">
        <LoaderCircle className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> Taking a backup, then removing…
      </p>
      <p className="text-mm-text-muted" aria-hidden="true">{elapsedOnlyNote(elapsed)}</p>
      <p role="status" className="sr-only">{spoken}</p>
    </div>
  )
}

interface Props {
  open: boolean
  identifier: string
  report: WithdrawalReport | null
  isPending: boolean
  onCancel: () => void
  onConfirm: () => void
}


export default function WithdrawParticipantDialog({
  open, identifier, report, isPending, onCancel, onConfirm,
}: Props) {
  const removed = removedSummary(report)
  const kept = keptSummary(report)

  return (
    // The Root refuses a close while the request runs — Escape, the overlay and
    // Cancel alike (`ConfirmDialog`'s shape, #959 §4).
    <AlertDialog open={open} onOpenChange={(o) => { if (!o && !isPending) onCancel() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {identifier}&rsquo;s data?</AlertDialogTitle>
          <AlertDialogDescription>
            For honouring a withdrawal request. A full backup is taken first — but
            there is no per-person undo, so restoring it would also undo any work
            done afterwards.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {report === null ? (
          <div className="text-xs text-mm-text-faint py-2">Checking what would be removed…</div>
        ) : (
          <div className="space-y-3 max-h-72 overflow-y-auto text-xs">
            {removed.length > 0 && (
              <div>
                <p className="font-medium text-mm-text mb-1">This will be removed</p>
                <ul className="space-y-0.5 text-mm-text-secondary list-disc pl-4">
                  {removed.map(l => <li key={l}>{l}</li>)}
                </ul>
              </div>
            )}
            {kept.length > 0 && (
              <div>
                <p className="font-medium text-mm-text mb-1">This will stay</p>
                <ul className="space-y-0.5 text-mm-text-secondary list-disc pl-4">
                  {kept.map(l => <li key={l}>{l}</li>)}
                </ul>
              </div>
            )}
          </div>
        )}

        {/*
          🔴 The most important text on this screen. Not a footnote, not a
          tooltip: a researcher records that they honoured a withdrawal, and this
          is the part that is still theirs to do.
        */}
        <div
          className="flex items-start gap-1.5 px-2 py-1.5 rounded bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-[11px] text-amber-700 dark:text-amber-300"
          role="note"
        >
          <TriangleAlert className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span>
            <strong>This cannot finish the job on its own.</strong> It will not find their
            name where other people said it in a conversation, or inside free-text answers,
            notes or memos. Search for their name afterwards and review those yourself.
          </span>
        </div>

        <div className="flex items-start gap-1.5 text-[11px] text-mm-text-faint">
          <Info className="w-3 h-3 mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span>Mixed Measures cannot tell you whether this satisfies your obligations.</span>
        </div>

        {isPending && <WithdrawingStatus />}

        {/* Busy is `aria-disabled`, never `disabled` (#959 §4): Chrome blurs a
            focused button that becomes disabled. `disabled` stays only for the
            report still loading — a transient precondition, and the button is not
            focused when it lifts. */}
        <AlertDialogFooter>
          <AlertDialogCancel aria-disabled={isPending || undefined}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={report === null}
            aria-disabled={isPending || undefined}
            aria-busy={isPending || undefined}
            onClick={(e) => {
              e.preventDefault()
              if (isPending || report === null) return
              onConfirm()
            }}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90 aria-busy:cursor-wait aria-busy:opacity-50"
          >
            {isPending ? 'Removing…' : 'Back up and remove'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
