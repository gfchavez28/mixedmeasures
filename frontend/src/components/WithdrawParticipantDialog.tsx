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
 *
 * 🔴 **#1152 — what it lists is read FOR THIS OPENING, and the act waits for it.**
 * It enabled on whatever report the cache held — the detail panel's, minutes old —
 * so after a document was made about the person elsewhere it said nothing of that
 * document over an enabled button. The page reads the report through the confirm's
 * own key (`ParticipantsPage`), so `report` is null until this opening's answer
 * lands; until then the list region says so and the confirm refuses.
 *
 * #1139 — capped at the window and scrolling inside it (a short window had the
 * title and both buttons off-screen, nothing scrolling): `DIALOG_FITS_VIEWPORT`, as
 * `Dashboard.tsx`'s import preview does for the same reason.
 *
 * 🔴 #1320 (D12) — **it says what still holds the data.** It said "a full backup is
 * taken first" and nothing of what that backup MEANS: it, every earlier backup, the
 * safety copies and any exported file hold everything removed, and recordings are
 * never edited. A researcher recording that a request was honoured needs to know
 * which copies they still have to deal with. The sentence is
 * `withdrawal-copy.ts::WITHDRAWAL_RESIDUAL_NOTE`, inside the description.
 */
import { useRef } from 'react'
import { TriangleAlert, Info } from 'lucide-react'
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from '@/components/ui/alert-dialog'
import type { WithdrawalReport } from '@/lib/api'
import type { ListLoad } from '@/lib/list-status'
import {
  removedSummary, keptSummary, misfitCasesNote, driftStampsNote, WITHDRAWAL_RESIDUAL_NOTE,
  WITHDRAWAL_RECORD_ITEM, WITHDRAWAL_CONFIRM_DETAILS, WITHDRAWAL_CONFIRM_DETAILS_LABEL,
} from '@/lib/withdrawal-copy'
import { NoticeDetails } from '@/components/NoticeDetails'
import { withdrawConfirmTitle, type ParticipantNaming } from '@/lib/participant-naming'
import { MODE_DISABLED_CLASS } from '@/lib/mode-disabled'
import { useKeepInViewWhen } from '@/hooks/useKeepInViewWhen'
import LongWaitStatus from '@/components/LongWaitStatus'
import { LoadState } from '@/components/LoadStatus'
import { DIALOG_FITS_VIEWPORT } from '@/components/ConfirmDialog'

/** The wait, said once and then every 30 s — the shared `LongWaitStatus`. No
 * estimate: no withdrawal has been timed on real data. */
function WithdrawingStatus() {
  return (
    <LongWaitStatus
      compact
      label="Taking a backup, then removing…"
      firstAnnouncement="Taking a backup, then removing. Keep Mixed Measures open until this finishes."
    />
  )
}

/**
 * The list region's two arms. In a short window (`max-height: 480px`) it gives up
 * its own scroller, so the dialog — already capped at the window — is the ONE thing
 * that scrolls: two nested scrollers in 344 px left the lists a sliver.
 */
const LIST_REGION =
  'space-y-3 max-h-72 overflow-y-auto text-xs '
  + '[@media(max-height:480px)]:max-h-none [@media(max-height:480px)]:overflow-visible'

interface Props {
  open: boolean
  /** Who — the row's own fields when the dialog opened (`lib/participant-naming.ts`). */
  participant: ParticipantNaming
  /** The report read for THIS opening, null until it answers (#1152). */
  report: WithdrawalReport | null
  /** That read — what the list region says until it answers, or that it failed. */
  reportLoad: ListLoad
  isPending: boolean
  onCancel: () => void
  onConfirm: () => void
}


export default function WithdrawParticipantDialog({
  open, participant, report, reportLoad, isPending, onCancel, onConfirm,
}: Props) {
  const removed = removedSummary(report)
  // The notice rule (2026-11-18, rewrite A): the withdrawal's own record always stays, so it is
  // the list's last line whenever the report has answered.
  const kept = [...keptSummary(report), WITHDRAWAL_RECORD_ITEM]
  // Joint display slice 2 (r3-6; wired in round 2, r5-9): their entries in a joint display's
  // "cases that don't fit", each with the researcher's reason — inside the description.
  const misfitNote = report ? misfitCasesNote(report) : null
  // #1674 (D357): the drift stamps it clears — inside the description too.
  const driftNote = report ? driftStampsNote(report) : null
  const waiting = report === null
  // #1139 — the wait panel goes in above the footer as the work starts, and the
  // focused "Removing…" sat below the capped dialog's visible part (measured at
  // 640×360: 365–401 px in a dialog ending at 344). The button carries
  // `scroll-mb-6`: `block: 'nearest'` ignores the dialog's padding and left it
  // flush on the bottom edge (307–343 in a box ending at 344).
  const confirmRef = useRef<HTMLButtonElement>(null)
  useKeepInViewWhen(isPending, confirmRef)

  return (
    // The Root refuses a close while the request runs — Escape, the overlay and
    // Cancel alike (`ConfirmDialog`'s shape, #959 §4).
    <AlertDialog open={open} onOpenChange={(o) => { if (!o && !isPending) onCancel() }}>
      <AlertDialogContent className={DIALOG_FITS_VIEWPORT}>
        {/*
          #1131 — EVERYTHING up to the buttons is the dialog's description
          (`asChild` onto a div, `ConfirmDialog`'s `details` shape). Only the first
          paragraph was, so a reader opening this heard the backup sentence and
          then "Cancel": what is removed, what stays and the warning below were
          on screen and silent (a11y-name-sweep run 6's rule, #886's class).
        */}
        <AlertDialogHeader>
          <AlertDialogTitle>{withdrawConfirmTitle(participant)}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              {/* #1320 (D12) — every copy that still holds what this removes:
                  the backup it takes, the earlier ones, safety copies, exported
                  files, and recordings, which it never edits. Inside the
                  description, so it is heard on open. */}
              <p>{WITHDRAWAL_RESIDUAL_NOTE}</p>
              {/* The notice rule's R3 (2026-11-18): the longer account, closed on every opening.
                  Closed, Chrome leaves its contents out of the description it reads on open. */}
              <NoticeDetails label={WITHDRAWAL_CONFIRM_DETAILS_LABEL}>
                <ul className="list-disc pl-4 space-y-0.5">
                  {WITHDRAWAL_CONFIRM_DETAILS.map(l => <li key={l}>{l}</li>)}
                </ul>
              </NoticeDetails>

              {/* #1152 — the shared loading line (and, after a failure, the
                  shared notice with its Retry) where the lists will be: inside
                  the description, so opening the dialog says it is checking. */}
              {waiting ? (
                <LoadState
                  load={reportLoad}
                  size="panel"
                  loadingLabel="Checking what would be removed…"
                  failedTitle="What would be removed could not be checked."
                />
              ) : (
                <div className={LIST_REGION}>
                  {removed.length > 0 && (
                    <div>
                      <p className="font-medium text-mm-text mb-1">This will be removed</p>
                      <ul className="space-y-0.5 text-mm-text-secondary list-disc pl-4">
                        {removed.map(l => <li key={l}>{l}</li>)}
                      </ul>
                    </div>
                  )}
                  <div>
                    <p className="font-medium text-mm-text mb-1">This will stay</p>
                    {/* #1606 (D235) — a line names the backup folder's path, and
                        D234 the researcher's project names: either can be one
                        unbroken string, so it may break anywhere rather than
                        widen the dialog. */}
                    <ul className="space-y-0.5 text-mm-text-secondary list-disc pl-4 [overflow-wrap:anywhere]">
                      {kept.map(l => <li key={l}>{l}</li>)}
                    </ul>
                  </div>
                  {misfitNote && <p className="text-mm-text-secondary">{misfitNote}</p>}
                  {driftNote && <p className="text-mm-text-secondary" data-testid="withdraw-drift-stamps">{driftNote}</p>}
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
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        {isPending && <WithdrawingStatus />}

        {/* Busy is `aria-disabled`, never `disabled` (#959 §4): Chrome blurs a
            focused button that becomes disabled. The wait for the report is the
            same (#1152): the confirm keeps its name and its tab stop, says it is
            unavailable, and the guard refuses — and since the page's report goes
            back to loading as the dialog closes after a success, a native
            `disabled` there would blur the focused button on the way out. */}
        <AlertDialogFooter>
          <AlertDialogCancel aria-disabled={isPending || undefined}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            ref={confirmRef}
            aria-disabled={isPending || waiting || undefined}
            aria-busy={isPending || undefined}
            onClick={(e) => {
              e.preventDefault()
              if (isPending || waiting) return
              onConfirm()
            }}
            className={'scroll-mb-6 bg-destructive text-destructive-foreground hover:bg-destructive/90 aria-busy:cursor-wait aria-busy:opacity-50'
              + (waiting && !isPending ? ` ${MODE_DISABLED_CLASS}` : '')}
          >
            {isPending ? 'Removing…' : 'Back up and remove'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
