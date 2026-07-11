/**
 * Import drop zones — the shared click-to-browse behavior (#560a).
 *
 * Every import drop zone advertises "…or click to browse" and used to wire only
 * `onDrop` + `onKeyDown`, so a pointer click on the zone's padding did nothing.
 * The obvious fix — a zone-level `onClick` that opens the picker — has a trap:
 * the zone CONTAINS the control that already opens the picker (a real Button, or
 * a `<label>` bound to the input), so a click on it opens the chooser AND bubbles
 * to the zone, which opens it a second time. `openPickerFromZoneClick` ignores
 * clicks that originated on an interactive descendant, which is exactly the set
 * of elements that open the picker themselves.
 *
 * Zone shape these helpers assume (standardized in #560):
 *   <div {...} onClick={e => openPickerFromZoneClick(e, () => inputRef.current?.click())}>
 *     …copy…
 *     <Button onClick={() => inputRef.current?.click()}>Select Files</Button>  ← REAL button
 *     <input ref={inputRef} type="file" className="hidden" />
 *   </div>
 *
 * The inner Button is the accessible control (focusable, named, honors `disabled`);
 * the zone itself is a plain div — NOT `role="button"`, which would nest an
 * interactive element inside an interactive role. Before #560 the inner control was
 * a non-focusable `<span>` inside a `<label>`, which is why the zone had to carry
 * `role="button"` + `tabIndex` to be reachable at all — do not reintroduce that shape.
 */
import type { MouseEvent } from 'react'

/** Descendants that open the picker themselves (or do something else entirely). */
const INTERACTIVE = 'button, a, label, input, select, textarea, [role="button"]'

/**
 * Open the file picker for a click on the drop zone's own surface.
 * No-ops when the click came from an interactive descendant — that element
 * handles it, and firing again would open a second chooser.
 */
export function openPickerFromZoneClick(
  e: MouseEvent<HTMLElement>,
  open: () => void,
): void {
  if ((e.target as HTMLElement).closest(INTERACTIVE)) return
  open()
}
