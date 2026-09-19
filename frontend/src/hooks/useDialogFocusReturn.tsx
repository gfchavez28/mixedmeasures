import { useCallback, useRef } from "react"
import { FocusReturnCapture } from "@/components/ui/focus-return-capture"
import {
  returnFocusAfterDialog,
  startDialogFocusSession,
  type DialogFocusSession,
  type FocusTarget,
} from "@/lib/dialog-focus-return"

/**
 * #959 — the one wiring both `components/ui` dialog wrappers use. Returns the
 * `onCloseAutoFocus` to hand Radix's `Content` and an element to render as the
 * content's first child. A caller's own `onCloseAutoFocus` runs first; if it
 * calls `preventDefault()`, its landing stands. Rules: `lib/dialog-focus-return.ts`.
 */
export function useDialogFocusReturn(onCloseAutoFocus: ((event: Event) => void) | undefined) {
  const sessionRef = useRef<DialogFocusSession | null>(null)

  const start = useCallback((opener: FocusTarget | null) => {
    const session = startDialogFocusSession(opener)
    sessionRef.current = session
    return () => session.stop()
  }, [])

  const handleCloseAutoFocus = useCallback((event: Event) => {
    onCloseAutoFocus?.(event)
    const session = sessionRef.current
    sessionRef.current = null
    session?.stop()
    if (event.defaultPrevented || !session) return
    // Radix would focus the dialog's trigger, which a state-opened dialog lacks.
    event.preventDefault()
    returnFocusAfterDialog(session.candidates())
  }, [onCloseAutoFocus])

  return { handleCloseAutoFocus, capture: <FocusReturnCapture onStart={start} /> }
}
