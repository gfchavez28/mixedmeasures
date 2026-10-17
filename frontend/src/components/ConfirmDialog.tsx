import { useRef, type ReactNode } from 'react'
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
import { MODE_DISABLED_CLASS, modeDisabledProps } from '@/lib/mode-disabled'
import { useKeepInViewWhen } from '@/hooks/useKeepInViewWhen'

interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel?: string
  loadingLabel?: string
  onConfirm: () => void
  destructive?: boolean
  loading?: boolean
  /** Optional extra body between the description and the footer (e.g. a checkbox).
   * ⚠️ NOT part of the dialog's accessible description — a screen reader opening
   * the dialog does not hear it. Anything the reader must hear goes in `details`. */
  children?: ReactNode
  /** Extra content that IS part of the accessible description, rendered after
   * `description` inside the element the dialog's `aria-describedby` points at.
   * Use it for a warning: a sentence rendered as `children` is on screen and
   * silent (a11y-name-sweep run 6 — the safety-copy "may be the only copy"
   * warning was exactly that, #886's class). */
  details?: ReactNode
  /** Where focus goes when the dialog closes — ONLY when a surface has a better
   * landing than the default. Call `preventDefault()` and focus that element.
   *
   * The default (#959) lives in `components/ui/alert-dialog.tsx` for EVERY dialog:
   * back to the control the dialog was opened from, else whatever took its place
   * (the next card after a delete), else the page's main content —
   * `lib/dialog-focus-return.ts`. ⚠️ Before #959 an omitted handler dropped focus
   * to `<body>`, because Radix returns focus only to a `Trigger` and every
   * `ConfirmDialog` is opened by state. */
  onCloseAutoFocus?: (event: Event) => void
  /** Why the confirm CANNOT act, in words that complete its name (`'unavailable:
   * …'`) — a state the researcher can change, so the button stays focusable and
   * says why (`lib/mode-disabled.ts`, #754). Put the full sentence in `details`
   * too: a reason only on a control is heard by nobody who does not Tab to it. */
  confirmBlockedReason?: string | null
  /** A transient precondition is unmet (e.g. the removal plan has not answered,
   * #1175) — native `disabled`, no tab stop. ⚠️ Only for a state that holds as
   * the dialog OPENS (focus starts on Cancel): a confirm that turns `disabled`
   * while focused drops focus to `<body>` (#959) — that is `loading`'s job. */
  confirmUnavailable?: boolean
  /** What the confirm acts on is still being READ as the dialog opens (#1152: the
   * withdrawal report behind the participant delete) — `aria-disabled` + the click
   * guard, with its name UNCHANGED (#770: a wait is transient state). Say what it
   * waits for in `details` (a `LoadState`). Unlike `confirmUnavailable`'s native
   * `disabled`, it may come back on while the confirm is focused — the page's query
   * goes back to loading as the dialog closes — without Chrome blurring it (#959). */
  confirmWaiting?: boolean
  /** The dialog may grow while it is open (a long wait under it): cap it at the
   * viewport and scroll inside, rather than run off a short window. Measured at
   * 640×360 (#1035): the project delete's wait made the dialog 416 px tall, title
   * and buttons cut off, nothing scrolling. */
  fitViewport?: boolean
}

/** A dialog held within the viewport, scrolling inside it — `fitViewport`'s class. */
export const DIALOG_FITS_VIEWPORT = 'max-h-[calc(100dvh-2rem)] overflow-y-auto'

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Delete',
  loadingLabel,
  onConfirm,
  destructive = true,
  loading = false,
  children,
  details,
  onCloseAutoFocus,
  confirmBlockedReason = null,
  confirmUnavailable = false,
  confirmWaiting = false,
  fitViewport = false,
}: ConfirmDialogProps) {
  const confirmText = loading ? (loadingLabel || 'Deleting...') : confirmLabel
  // ⚠️ The click guard is the load-bearing half of a block (#754): the mode arm's
  // `onClick` prevents the default, which is also what stops Radix's Action from
  // closing the dialog on a refused press.
  const confirm = modeDisabledProps<HTMLButtonElement>({
    label: confirmText,
    blockedReason: confirmBlockedReason,
    unavailable: confirmUnavailable,
    onActivate: (e) => {
      e.preventDefault()
      if (loading || confirmWaiting) return
      onConfirm()
    },
  })
  /*
   * #1139 — a `fitViewport` dialog opens scrolled to its top, and starting the work
   * puts a wait above the footer while the scroll position stays put: the focused
   * busy button ("Deleting…") moved below the visible part of the dialog (measured
   * on the restore and withdrawal confirms; Batch 1a's three `fitViewport` dialogs —
   * the project delete, Link by column, the overwrite import — share the shape).
   * The confirm is the element: it is the focused one, and the footer is one row
   * from 640 px (`sm:flex-row`). Harmless on a dialog that already fits.
   * ⚠️ `block: 'nearest'` ignores the scroller's padding, so the button landed
   * FLUSH on the dialog's bottom edge (measured on the restore confirm: 747–783 in
   * a box ending at 784); `scroll-mb-6` on the target gives it back the dialog's
   * own 24 px (`p-6`).
   */
  const confirmRef = useRef<HTMLButtonElement>(null)
  useKeepInViewWhen(loading, confirmRef)
  return (
    <AlertDialog open={open} onOpenChange={loading ? undefined : onOpenChange}>
      <AlertDialogContent
        onCloseAutoFocus={onCloseAutoFocus}
        className={fitViewport ? DIALOG_FITS_VIEWPORT : undefined}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {details ? (
            // `asChild` onto a div: a <p> may not contain the block content a
            // warning box is. The description id lands on the div, so the whole
            // subtree is what `aria-describedby` reads.
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>{description}</p>
                {details}
              </div>
            </AlertDialogDescription>
          ) : (
            <AlertDialogDescription>{description}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          {/* #959 — busy is `aria-disabled`, never `disabled`: Chrome drops focus
              from a focused button that becomes disabled, so pressing Delete put
              focus on <body> for the whole request (~20 s on a large dataset).
              `aria-disabled` changes what a button announces, not what it does, so
              each needs a refusal (#754): Cancel's is the Root's `onOpenChange`,
              which is `undefined` while loading; the confirm's is the `loading`
              guard in `onActivate` above. */}
          <AlertDialogCancel aria-disabled={loading || undefined}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            {...confirm}
            ref={confirmRef}
            aria-disabled={loading || confirmWaiting || confirm['aria-disabled']}
            className={[
              // #1139 — the keep-in-view target stops 24 px short of the edge.
              'scroll-mb-6',
              destructive ? 'bg-red-600 hover:bg-red-700 focus:ring-red-600' : '',
              confirmBlockedReason || (confirmWaiting && !loading) ? MODE_DISABLED_CLASS : '',
            ].join(' ').trim()}
          >
            {confirmText}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
