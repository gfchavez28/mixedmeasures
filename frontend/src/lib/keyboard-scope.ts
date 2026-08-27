/**
 * Who owns a keystroke — the stand-down rules for the workbench keyboard layer (#784).
 *
 * `useCodeChordShortcuts` listens on `window`, so it sees every keydown on the page
 * including ones aimed at a focused control. It already refuses to steal from text
 * fields (the INPUT/TEXTAREA/SELECT/contenteditable guard). This module owns the
 * OTHER refusal: a key the focused control performs an action for ITSELF.
 *
 * ⚠️ **Why this is not a nicety.** A global handler that calls `preventDefault()` on
 * Space cancels the native activation of whatever button has focus — so the control
 * silently does nothing, and the workbench does something else instead. Measured on
 * `/projects/3/observations/3`: with `Fit` focused, Space produced **zero clicks** and
 * started the video playing. Every plain button on that page was inoperable by Space,
 * and on `/projects/1/conversations/9` — a conversation with no media at all — Space
 * was swallowed and did nothing whatsoever.
 *
 * ⚠️ **This is deliberately about ACTIVATION KEYS ONLY.** The workbench shortcuts are
 * global by design: pressing `c` or a digit while a button happens to hold focus should
 * still apply a code. Only keys the control itself consumes are off limits, so the set
 * below is Space and Enter and nothing else. Widening it to "any key while a button is
 * focused" would silently kill the chord layer.
 *
 * ⚠️ **The sibling stand-down is NOT here** — it is one line in the hook
 * (`if (e.defaultPrevented) return`). Radix menus and dialogs handle their own
 * navigation and `preventDefault` before this window-bubble listener runs, so
 * `defaultPrevented` is the platform's own "already handled" signal. That was measured,
 * not assumed: `ArrowDown` and `Escape` inside an open `DropdownMenu` both arrive at
 * window with it set. Reading the signal beats keeping an allow-list of overlay roles,
 * which is the enumeration debt this codebase keeps paying.
 */

/**
 * The only keys a control activates on. Both spellings of Space are accepted:
 * `' '` is the modern `KeyboardEvent.key`, `'Spacebar'` the legacy one some
 * environments still emit.
 */
const SPACE_KEYS = new Set([' ', 'Spacebar'])

/**
 * Roles whose control performs its own action on **Space**.
 *
 * ⚠️ `option` and `treeitem` are deliberately ABSENT. They do activate on Space in a
 * standard listbox/tree, but every list in these workbenches uses the
 * `aria-activedescendant` model — the CONTAINER holds focus, never the row — so
 * including them would protect nothing that exists while risking the primary
 * interaction (Space toggles playback with the clip list focused, and that list is a
 * `role="listbox"`). Add them the day a surface makes its rows focusable, not before.
 */
const SPACE_ACTIVATED_ROLES = new Set([
  'button',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
])

/** Roles whose control performs its own action on **Enter** — Space's set plus links. */
const ENTER_ACTIVATED_ROLES = new Set([...SPACE_ACTIVATED_ROLES, 'link'])

/**
 * The role a bare element carries with no explicit `role` attribute.
 *
 * Only the cases that can reach this predicate are listed: `INPUT`, `SELECT` and
 * `TEXTAREA` are already refused one guard earlier by the hook's text-field check, so
 * they are covered whether or not they appear here.
 */
function implicitRole(el: Element): string | null {
  switch (el.tagName) {
    case 'BUTTON':
      return 'button'
    case 'SUMMARY':
      // <summary> toggles its <details> on both Space and Enter.
      return 'button'
    case 'A':
      return el.hasAttribute('href') ? 'link' : null
    case 'INPUT': {
      const type = (el as HTMLInputElement).type
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'file') return 'button'
      return null
    }
    default:
      return null
  }
}

/**
 * Does the focused element perform its own action for this key?
 *
 * Pass `document.activeElement` — NOT `event.target`. For a real keydown the two
 * coincide (key events dispatch at the focused node), but the element whose native
 * behaviour is at stake is the focused one, and naming it that way is what makes the
 * rule legible. It also keeps the predicate testable in jsdom, where a test dispatches
 * on `window` and `event.target` is the window.
 *
 * Returns `false` for every non-activation key, so callers can apply it unconditionally.
 */
export function focusedElementOwnsKey(key: string, el: Element | null): boolean {
  if (!el) return false

  const isSpace = SPACE_KEYS.has(key)
  const isEnter = key === 'Enter'
  if (!isSpace && !isEnter) return false

  // An explicit role wins — that is what the accessibility tree reports, and a
  // <div role="button"> is activated by its own handler exactly like a <button>.
  const role = el.getAttribute('role')?.trim().toLowerCase() || implicitRole(el)
  if (!role) return false

  return isSpace ? SPACE_ACTIVATED_ROLES.has(role) : ENTER_ACTIVATED_ROLES.has(role)
}

/**
 * The activation keys themselves, exported so a guard can assert over the whole set
 * rather than the one or two a workbench happens to claim today. A workbench that adds
 * `Enter` to its `extraKeys` is then covered without anyone remembering to widen a test.
 */
export const ACTIVATION_KEYS: readonly string[] = [' ', 'Spacebar', 'Enter']

/**
 * Roles whose element is a CONTROL the user operates — focus here means they are working
 * that thing, not the surface's list, so the arrow keys belong to it (or to nobody).
 *
 * ⚠️ `option` and `treeitem` are absent for the same reason they are absent above: the
 * lists here are `aria-activedescendant`-driven, so a row never holds focus, and calling
 * a row a "control" would be describing a state that does not occur.
 */
const CONTROL_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'switch', 'tab',
  'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton',
])

/** Tags that are controls whatever they claim — the platform's own interactive set. */
const CONTROL_TAGS = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY'])

/**
 * Is focus sitting on some OTHER control, rather than on the surface the arrow keys serve?
 *
 * This is the predicate behind #789, and it is deliberately the INVERSE of the obvious
 * one. "Focus must be inside the list container" is what anybody would reach for, and it
 * is wrong twice over — both measured, not reasoned:
 *
 *  - **On a fresh page load `document.activeElement` is `BODY`** — nothing is focused —
 *    and ArrowDown still works, selecting the first clip. That is how the surface is
 *    meant to be picked up: arrive, press Down, go. A containment check kills the
 *    primary entry path.
 *  - **Panel navigation focuses a plain `<div>`.** ArrowRight from the transcript moves
 *    focus to `CodePanel`'s container (`DIV`, `role: null`, `tabIndex: 0`), and
 *    ArrowLeft must still reach the hook from there to get back. A containment check
 *    strands the user in the panel.
 *
 * So the rule is three-way: focus in the surface → ours; focus nowhere (`body`/null) →
 * ours, because no control wants the key; focus on another control → **theirs**.
 * Anything unrecognised (a plain container div) keeps today's behaviour, which is the
 * safe direction — this guard should never be the reason navigation stops working.
 */
export function focusIsOnAnotherControl(el: Element | null): boolean {
  if (!el || el === document.body || el === document.documentElement) return false

  const role = el.getAttribute('role')?.trim().toLowerCase()
  // An explicit role wins in BOTH directions: a `role="listbox"` container is the
  // surface itself even though it is focusable, and a `<div role="button">` is a control
  // even though its tag is inert.
  if (role) return CONTROL_ROLES.has(role)

  if (el.tagName === 'A') return el.hasAttribute('href')
  return CONTROL_TAGS.has(el.tagName)
}
