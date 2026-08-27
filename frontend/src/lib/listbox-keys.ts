/**
 * What a key press means inside a multi-selectable listbox.
 *
 * **Why this is a pure function in `lib/` for a single consumer.** The one
 * listbox that needs it lives in `pages/RecodeWorkbench.tsx`, a page whose test
 * harness cannot render it — the two existing guards for that file are source
 * scans, not render tests. Index arithmetic with four keys and two modifiers is
 * exactly the kind of thing that wants a table of cases, so the decision is
 * separated from the DOM work it drives. **The DOM half stays in the component;
 * only the arithmetic is here.**
 *
 * ## The model, and why it is not the APG's letter
 *
 * The variables listbox has TWO selection concepts, and they are different facts:
 *
 * - **the selected variable** — one, drives the detail panel beside the list;
 * - **the bulk set** — many, drives *Change type* on the toolbar above it.
 *
 * The mouse has always spoken both: a plain click selects, Ctrl/Cmd-click toggles
 * bulk membership without disturbing the selection. **The keyboard spoke only the
 * first**, which is why the list declared `aria-multiselectable="true"` while no
 * keyboard user could produce a multi-selection — a widget announcing a
 * capability it does not offer, the #776 shape one attribute over.
 *
 * So the keyboard mirrors the mouse, gesture for gesture:
 *
 * | key | meaning | mouse equivalent |
 * |---|---|---|
 * | Arrow / Home / End | move, select, clear the bulk set | plain click |
 * | **Ctrl/Cmd + Arrow / Home / End** | move focus only — selection and bulk set untouched | (moving the pointer) |
 * | **Ctrl/Cmd + Space** | toggle the focused option's bulk membership | Ctrl/Cmd-click |
 *
 * ⚠️ **Selection follows focus on a bare arrow, deliberately** — that was #823f's
 * call and it is right for a list that drives a detail pane. The APG's ordinary
 * multi-select pattern moves focus without selecting; this list keeps the
 * simpler behaviour for the common case and reserves the modifier for the rest.
 *
 * ⚠️ **Shift-range is deliberately NOT mirrored.** Shift-click sets the bulk set
 * to a range, which needs an anchor that survives movement — a third piece of
 * state for a gesture whose result is already reachable here, one Ctrl+Space at
 * a time. **Capability parity, not gesture parity**: every set the mouse can
 * build, the keyboard can build.
 */

export type ListboxIntent =
  /** Move the cursor there, select it, and drop any multi-selection. */
  | { type: 'select'; index: number }
  /** Move the cursor there and change nothing else. */
  | { type: 'focus'; index: number }
  /** Add or remove the option under the cursor from the multi-selection. */
  | { type: 'toggle' }
  /** Not ours — leave the event alone. */
  | { type: 'none' }

const MOVE_KEYS = ['ArrowDown', 'ArrowUp', 'Home', 'End']

export function listboxKeyIntent(
  key: string,
  mods: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean },
  cursor: number,
  length: number,
): ListboxIntent {
  if (length <= 0) return { type: 'none' }
  // ⚠️ Alt is the platform's own modifier (menu access on Windows/Linux, word
  // motion on macOS) — never claim it. Shift is left alone so the range gesture
  // stays available to a future implementation rather than silently doing
  // something else in the meantime.
  if (mods.alt || mods.shift) return { type: 'none' }

  const multi = Boolean(mods.ctrl || mods.meta)

  if (key === ' ' || key === 'Spacebar') {
    // ⚠️ Bare Space is NOT claimed: it is the page's scroll key, and the list is
    // scrollable. Only the modified form toggles.
    return multi && cursor >= 0 ? { type: 'toggle' } : { type: 'none' }
  }

  if (!MOVE_KEYS.includes(key)) return { type: 'none' }

  const last = length - 1
  let next: number
  if (key === 'Home') next = 0
  else if (key === 'End') next = last
  // ⚠️ `cursor < 0` is a real state — nothing selected on first load — and both
  // arrows must land on the FIRST option from it, not wrap to the last.
  else if (key === 'ArrowDown') next = cursor < 0 ? 0 : Math.min(cursor + 1, last)
  else next = cursor < 0 ? 0 : Math.max(cursor - 1, 0)

  if (next === cursor) return { type: 'none' }
  return multi ? { type: 'focus', index: next } : { type: 'select', index: next }
}
