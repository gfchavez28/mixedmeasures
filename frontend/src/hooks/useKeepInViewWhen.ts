import { useEffect, type RefObject } from 'react'

/**
 * #1139 — keep an element (a dialog's footer) on screen when a state begins.
 *
 * A dialog capped at the window's height (`ConfirmDialog`'s `DIALOG_FITS_VIEWPORT`)
 * scrolls inside itself, and opens scrolled to its top. When it starts WORKING it
 * inserts a wait panel above its footer while its scroll position stays put — so the
 * button the researcher just pressed, still focused and now saying "Restoring…" or
 * "Removing…", moves below the visible part of the dialog. MEASURED at 640×360: the
 * restore confirm's focused busy button sat at 439–475 px in a dialog ending at 344,
 * the withdrawal's at 365–401.
 *
 * Runs after the commit that turns `active` on, so the panel is already laid out;
 * `block: 'nearest'` scrolls only as far as needed and not at all when the element is
 * already visible. `?.` on the call: jsdom has no `scrollIntoView`.
 */
export function useKeepInViewWhen(active: boolean, ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (active) ref.current?.scrollIntoView?.({ block: 'nearest' })
  }, [active, ref])
}
