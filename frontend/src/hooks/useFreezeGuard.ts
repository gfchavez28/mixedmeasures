import { useCallback, useState } from 'react'

/**
 * Track J · J3-1 "Freeze Codebook" soft-lock guard.
 *
 * When the codebook is frozen, `guard(proceed)` defers `proceed` behind a warning
 * dialog (the user can still proceed — it's a SOFT lock, not an enforcement); when
 * unfrozen, `proceed` runs immediately. Render a warning dialog driven by `warnOpen`
 * /`onProceed`/`onCancel` once in the consuming component.
 */
export function useFreezeGuard(isFrozen: boolean) {
  const [pending, setPending] = useState<(() => void) | null>(null)

  const guard = useCallback(
    (proceed: () => void) => {
      if (isFrozen) {
        // Store the thunk (the `() => proceed` updater sets state TO `proceed`).
        setPending(() => proceed)
      } else {
        proceed()
      }
    },
    [isFrozen],
  )

  // Run the deferred action OUTSIDE the state updater — a side effect inside an
  // updater double-fires under React StrictMode (the J2-5 reveal double-log lesson).
  const onProceed = useCallback(() => {
    pending?.()
    setPending(null)
  }, [pending])

  const onCancel = useCallback(() => setPending(null), [])

  return { guard, warnOpen: pending !== null, onProceed, onCancel }
}
