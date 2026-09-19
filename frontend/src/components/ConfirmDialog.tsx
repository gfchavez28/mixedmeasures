import type { ReactNode } from 'react'
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
}

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
}: ConfirmDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={loading ? undefined : onOpenChange}>
      <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus}>
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
              which is `undefined` while loading; the confirm's is its guard below. */}
          <AlertDialogCancel aria-disabled={loading || undefined}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault()
              if (loading) return
              onConfirm()
            }}
            aria-disabled={loading || undefined}
            className={destructive ? 'bg-red-600 hover:bg-red-700 focus:ring-red-600' : undefined}
          >
            {loading ? (loadingLabel || 'Deleting...') : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
