import type { MouseEvent } from 'react'

/**
 * #754 — a control blocked by a persistent MODE stays discoverable and says why.
 *
 * Native `disabled` removes a control from the tab order entirely, so a keyboard
 * or screen-reader user never learns the operation exists, let alone why it is
 * unavailable. Measured on a frozen observation: tabbing the workbench toolbar
 * announced Previous/Rename/Follow/Colleagues/Unfreeze and NOTHING else — Split,
 * Merge, Undo, Redo and every Delete were simply absent. Sighted users get the
 * greyed control and its tooltip.
 *
 * The distinction this encodes is between two reasons a control can be off:
 *
 *   - a **persistent mode** the researcher chose and can undo (the clip set is
 *     frozen, the project is read-only) — worth explaining, because the remedy
 *     is a different control on the same screen. `aria-disabled`: focusable,
 *     announced unavailable, reason in the name.
 *   - a **transient precondition** (nothing selected, nothing to undo) — not
 *     worth a tab stop, and it changes the moment the user does the obvious
 *     thing. Native `disabled`, as before.
 *
 * ⚠️ `aria-disabled` does NOT stop activation — the click handler still fires,
 * and Enter/Space go through it too. The guard is the whole reason this returns
 * an `onClick` rather than a bag of attributes: an aria-disabled control wired
 * straight to its action is worse than a native-disabled one.
 *
 * ⚠️ Put it on the CONTROL, never on a wrapper. #752 is the same attribute one
 * screen over, where a container carrying it propagated "unavailable" through
 * Chrome's accessibility tree onto live descendants.
 */
export interface ModeDisabledOptions<E extends Element> {
  /** The control's accessible name when nothing is blocking it. */
  label: string
  /**
   * Why a persistent mode blocks it, phrased to complete the name — e.g.
   * `'unavailable while the clip set is frozen'`. `null` when no mode blocks it.
   */
  blockedReason: string | null
  /** A transient precondition is unmet (no selection, empty history, …). */
  unavailable?: boolean
  onActivate: (event: MouseEvent<E>) => void
}

export interface ModeDisabledProps<E extends Element> {
  'aria-label': string
  disabled: boolean
  'aria-disabled': true | undefined
  onClick: (event: MouseEvent<E>) => void
}

export function modeDisabledProps<E extends Element>(
  { label, blockedReason, unavailable = false, onActivate }: ModeDisabledOptions<E>,
): ModeDisabledProps<E> {
  if (blockedReason) {
    return {
      'aria-label': `${label} — ${blockedReason}`,
      // Focusable on purpose: the tab stop IS the disclosure.
      disabled: false,
      'aria-disabled': true,
      onClick: (event: MouseEvent<E>) => {
        event.preventDefault()
        event.stopPropagation()
      },
    }
  }
  return {
    'aria-label': label,
    disabled: unavailable,
    'aria-disabled': undefined,
    onClick: onActivate,
  }
}

/**
 * Tailwind for the blocked look. `disabled:*` cannot fire — the element is not
 * disabled — so the same two properties are restated on the `aria-disabled`
 * variant. `pointer-events` is deliberately NOT removed: the tooltip and the
 * `title` are how a sighted user reads the reason, and the click guard above is
 * what makes that safe.
 */
export const MODE_DISABLED_CLASS = 'aria-disabled:opacity-50 aria-disabled:cursor-not-allowed'
