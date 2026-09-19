import { useLayoutEffect, useState } from "react"
import { captureFocusTarget, type FocusTarget } from "@/lib/dialog-focus-return"

/**
 * #959 — rendered INSIDE a dialog's content, so it exists exactly while the
 * dialog does. The opener is read in the state initializer, i.e. during RENDER:
 * an `autoFocus` inside the dialog moves focus at commit, and Radix's own open
 * event fires later still, so both would already see focus inside the dialog.
 * `onStart` begins recording and returns the function that stops it.
 */
export function FocusReturnCapture({
  onStart,
}: {
  onStart: (opener: FocusTarget | null) => () => void
}) {
  const [opener] = useState(() => captureFocusTarget(document.activeElement))
  useLayoutEffect(() => onStart(opener), [onStart, opener])
  return null
}
