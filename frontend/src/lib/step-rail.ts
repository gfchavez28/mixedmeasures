/**
 * The values `components/ImportStepRail.tsx` decides with (#1184) — here so the
 * component file exports only the component (react-refresh), and so a wizard's
 * mapping and the tests read the same names.
 */

/** `current` for a screen past the rail's last step — every step is done, none is current. */
export const AFTER_LAST_STEP = '__after-last-step__'

/** The collapse, on a non-current label (see the component for why 44 rem). */
export const RAIL_COLLAPSED_LABEL = '@max-[44rem]/steps:sr-only'

/** What a reader hears after a completed step's label. */
export const RAIL_DONE_TEXT = ', completed'

/**
 * The position `current` names on the rail: its index, `steps.length` once past the
 * last step, or −1 when it names no step on the rail (every step then reads as not
 * started — the defect a wizard's total mapping exists to prevent).
 */
export function railPosition(steps: readonly { key: string }[], current: string): number {
  if (current === AFTER_LAST_STEP) return steps.length
  return steps.findIndex(s => s.key === current)
}
