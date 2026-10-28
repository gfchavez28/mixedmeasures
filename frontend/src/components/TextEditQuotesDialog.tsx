import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { buttonVariants } from '@/components/ui/button'
import { DIALOG_FITS_VIEWPORT } from '@/components/ConfirmDialog'
import type { TextEditOutcome, TextEditPlan } from '@/lib/api/segments'
import { canKeepAsShown, flaggedQuotes } from '@/lib/text-edit-quotes'

export type TextEditChoice = 'keep' | 'remove' | 'cancel'

/** What happened to the quote, in the researcher's words. */
const OUTCOME_LABEL: Record<Exclude<TextEditOutcome, 'silent'>, string> = {
  edge: 'The edit changes words at the edge of this quote.',
  straddle: 'The edit runs across the edge of this quote.',
  gone: 'The edit removes every word of this quote.',
}

interface TextEditQuotesDialogProps {
  /** The preview's plan; the dialog is open while it is set. */
  plan: TextEditPlan | null
  /** Called ONCE per opening. Escape and the overlay are a cancel. */
  onChoose: (choice: TextEditChoice) => void
}

/**
 * #1319 / D5 — an edit that touches a quote's edge, runs across it, or removes its
 * words is shown BEFORE it is saved: keep the quotes as shown, remove them, or go
 * back to editing (the typed text is still in the editor).
 *
 * ⚠️ Everything a reader must hear — the list included — is inside
 * `AlertDialogDescription` (frontend-a11y.md #955 d: `children` outside it are on
 * screen and silent). The list is capped at the viewport and scrolls
 * (`DIALOG_FITS_VIEWPORT`, measured at 640×360 for the dialogs that share it).
 * Focus opens on Cancel — Radix's default for an alert dialog — and returns through
 * the `components/ui` seam (#959) to where the save came from.
 */
export function TextEditQuotesDialog({ plan, onChoose }: TextEditQuotesDialogProps) {
  const flagged = plan ? flaggedQuotes(plan) : []
  const keepable = plan ? canKeepAsShown(plan) : false
  const n = flagged.length
  const removeLabel = n === 1 ? 'Remove the quote and save' : `Remove ${n} quotes and save`
  return (
    <AlertDialog open={plan !== null} onOpenChange={(open) => { if (!open) onChoose('cancel') }}>
      <AlertDialogContent className={DIALOG_FITS_VIEWPORT}>
        <AlertDialogHeader>
          <AlertDialogTitle>This edit changes quoted words</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <p>
                {n === 1
                  ? 'One quote on this passage would change.'
                  : `${n} quotes on this passage would change.`}
                {keepable
                  ? ' Keep them as shown below, or remove them.'
                  : ' Saving removes them.'}
              </p>
              {plan?.capped && (
                <p>
                  This edit changes a long stretch at once, so the quotes inside it
                  could not be followed word by word.
                </p>
              )}
              {plan && plan.collisions.length > 0 && (
                <p>
                  Two of these quotes would mark the same words, so they cannot all be
                  kept.
                </p>
              )}
              {/* ⚠️ No aria-label on the list: in accname's traversal a labelled
                  node contributes its LABEL instead of its content, so the quotes
                  would go unheard. jsdom does not model this (a mutant adding the
                  label passes the test file), so it rests on the spec and on
                  Chrome's tree — unverified here. */}
              <ul className="space-y-2">
                {flagged.map(q => (
                  <li
                    key={q.excerpt_id}
                    className="rounded border border-mm-border-subtle px-3 py-2 text-left"
                  >
                    <p className="text-mm-text">
                      {OUTCOME_LABEL[q.outcome as Exclude<TextEditOutcome, 'silent'>]}
                    </p>
                    <p className="mt-1 break-words line-clamp-3">
                      <span className="font-medium text-mm-text">Before: </span>
                      “{q.old_text}”
                    </p>
                    <p className="mt-1 break-words line-clamp-3">
                      <span className="font-medium text-mm-text">After: </span>
                      {q.outcome === 'gone' || q.new_text === null
                        ? 'removed'
                        : `“${q.new_text}”`}
                    </p>
                    {q.has_note && (
                      <p className="mt-1">
                        It has a note. If the quote is removed, the note stays on the
                        passage.
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={keepable ? buttonVariants({ variant: 'outline' }) : undefined}
            onClick={() => onChoose('remove')}
          >
            {removeLabel}
          </AlertDialogAction>
          {keepable && (
            <AlertDialogAction onClick={() => onChoose('keep')}>
              Keep as shown and save
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
