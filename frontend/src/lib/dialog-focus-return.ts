/**
 * #959 — where keyboard focus goes when a dialog closes. ONE place, for every
 * dialog in the app (both `components/ui` wrappers route through it).
 *
 * Radix returns focus only to a dialog's `Trigger`. Here 71 of 72 dialogs are
 * opened by STATE — from a menu item, a row action, a shortcut — so there is no
 * trigger, and closing one dropped focus to `<body>`: the next Tab started again
 * at "Skip to main content". Measured keyboard-only on the production build: the
 * Export dialog (opened from a button still on screen) on Escape; a delete
 * confirmation on Cancel, with the card still there; and on Delete.
 *
 * The rule, in order (the ARIA dialog pattern's: back to where the user came from,
 * or if that is gone, somewhere that continues the work):
 *
 *   1. **Back to where you came from.** The candidates, newest first, are every
 *      element focus went to OUTSIDE the dialog while it was open (a `focusin`, or
 *      a `focusout`'s `relatedTarget`), then the element focused when it opened.
 *      ⚠️ The first list is not decoration: a
 *      dialog opened from a MENU opens while focus is on the menu item, which is
 *      then unmounted; the menu hands focus back to its trigger (the card, the
 *      `⋯` button) ~20 ms LATER and the dialog's focus trap pulls it straight
 *      back. That brief focus is the only record of the control the researcher
 *      actually used.
 *   2. **The same place.** If none of them survives (a delete removed the card,
 *      Freeze replaced itself with Unfreeze), whatever now sits at the removed
 *      element's position in its nearest surviving container: the next card, or
 *      the previous one if it was last.
 *   3. **The page's main content** (`#main-content`, the skip link's target), and
 *      only if a candidate existed. A dialog opened with nothing focused returns
 *      focus to nothing — "where you came from" was nowhere.
 *
 * ⚠️ **A restored element is WATCHED** (`watchRestoredFocus`). A delete closes
 * its dialog when the server answers, and the list refetch removes the card a
 * moment later, so rule 1 finds the card, focuses it, and loses it again. When the
 * focused element is removed within the window, rule 2 runs then.
 *
 * ⚠️ **Never steals.** If something already holds focus when the dialog finishes
 * closing (a second dialog opened, a page that navigated and placed its own
 * focus), nothing moves. A caller's `onCloseAutoFocus` that calls
 * `preventDefault()` also wins, which is how a surface with a better landing
 * (the safety-copy list's header) keeps it.
 */

/** How far up the tree an element's position is remembered. */
const MAX_PATH_DEPTH = 12

/** How long a restored element is watched for a late removal (a list refetch). */
export const RESTORED_FOCUS_WATCH_MS = 10_000

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  '[tabindex]',
  '[contenteditable="true"]',
].join(',')

/** An element, and where it sat — so its PLACE can be found after it is gone. */
export interface FocusTarget {
  el: HTMLElement
  /** From the element upward: each ancestor, and the index of the child on the path. */
  path: { parent: Element; index: number }[]
}

export function captureFocusTarget(el: Element | null): FocusTarget | null {
  if (!(el instanceof HTMLElement)) return null
  if (el === document.body || el === document.documentElement) return null
  const path: FocusTarget['path'] = []
  let child: Element = el
  for (let depth = 0; depth < MAX_PATH_DEPTH; depth++) {
    const parent = child.parentElement
    if (!parent || parent === document.documentElement) break
    path.push({ parent, index: Array.prototype.indexOf.call(parent.children, child) })
    if (parent === document.body) break
    child = parent
  }
  return { el, path }
}

function canTakeFocus(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement) || !el.isConnected) return false
  if (!el.matches(FOCUSABLE_SELECTOR)) return false
  if ((el as HTMLButtonElement).disabled) return false
  if (el.closest('[inert], [aria-hidden="true"], [hidden]')) return false
  return true
}

/** Focus it, and say whether it took — `focus()` fails silently. */
function tryFocus(el: HTMLElement): boolean {
  el.focus()
  return document.activeElement === el
}

/** The first element in `root` (itself included) that can hold focus — a Tab stop first. */
function focusFirstWithin(root: Element): HTMLElement | null {
  const all = [root, ...root.querySelectorAll(FOCUSABLE_SELECTOR)].filter(canTakeFocus)
  const ordered = [...all.filter(e => e.tabIndex >= 0), ...all.filter(e => e.tabIndex < 0)]
  for (const el of ordered) if (tryFocus(el)) return el
  return null
}

/** Nothing else holds focus: it is on `<body>`, or on nothing. */
function focusIsLost(): boolean {
  const active = document.activeElement
  return !active || active === document.body || !active.isConnected
}

/**
 * Rule 2 — focus whatever took `target`'s place. Only in the NEAREST surviving
 * container on its path: searching further up would land on something that merely
 * shares a distant ancestor. And never when that container is `<body>`, where a
 * portal (a menu, a popover) sat — its index means nothing afterwards.
 */
export function focusSamePlace(target: FocusTarget): HTMLElement | null {
  const level = target.path.find(step => step.parent.isConnected)
  if (!level) return null
  const { parent, index } = level
  if (parent === document.body || parent === document.documentElement) return null
  const kids = parent.children
  if (kids.length === 0) return null
  const at = Math.min(Math.max(index, 0), kids.length - 1)
  // The child now at the index took the removed one's place; before it, its predecessor.
  for (const i of [at, at - 1]) {
    const kid = kids[i]
    if (!kid || kid === target.el) continue
    const focused = focusFirstWithin(kid)
    if (focused) return focused
  }
  return null
}

function focusMainContent(): HTMLElement | null {
  const main = document.getElementById('main-content')
  return main && main.isConnected && tryFocus(main) ? main : null
}

/**
 * Watch a restored element for `timeoutMs`: if it is REMOVED while it still holds
 * focus, move focus to its place (rule 2, then rule 3). Stops as soon as focus
 * moves anywhere else — the researcher has moved on. Returns the stop function.
 */
export function watchRestoredFocus(
  target: FocusTarget,
  timeoutMs: number = RESTORED_FOCUS_WATCH_MS,
): () => void {
  let stopped = false
  const onFocusIn = (e: FocusEvent) => { if (e.target !== target.el) stop() }
  const observer = new MutationObserver(() => {
    if (target.el.isConnected) return
    stop()
    if (!focusIsLost()) return
    if (!focusSamePlace(target)) focusMainContent()
  })
  const timer = setTimeout(() => stop(), timeoutMs)
  function stop() {
    if (stopped) return
    stopped = true
    observer.disconnect()
    document.removeEventListener('focusin', onFocusIn, true)
    clearTimeout(timer)
  }
  observer.observe(document.body, { childList: true, subtree: true })
  document.addEventListener('focusin', onFocusIn, true)
  return stop
}

/** What a dialog records while it is open. */
export interface DialogFocusSession {
  /** Stop recording. Safe to call more than once. */
  stop(): void
  /** Where focus may return, newest first; the opener last. */
  candidates(): FocusTarget[]
}

/**
 * Begin recording for one open dialog. `opener` is captured by the caller while
 * the dialog RENDERS — before any `autoFocus` inside it moves focus, which Radix's
 * own open event is too late to see. Focus inside ANY dialog is ignored: that
 * covers this dialog's own elements (Radix gives its content the role) and a
 * dialog opened on top of it.
 */
export function startDialogFocusSession(opener: FocusTarget | null): DialogFocusSession {
  const seen: FocusTarget[] = []
  const record = (t: EventTarget | null) => {
    if (!(t instanceof HTMLElement) || t === document.body) return
    if (t.closest('[role="dialog"], [role="alertdialog"]')) return
    if (seen.length > 0 && seen[seen.length - 1].el === t) return
    const captured = captureFocusTarget(t)
    if (captured) seen.push(captured)
  }
  const onFocusIn = (e: FocusEvent) => record(e.target)
  // 🔴 MEASURED in Chrome: when the menu hands focus back to the card, the
  // dialog's focus trap refocuses inside DURING `focusout`, so the card never
  // receives a `focusin` at all. The only trace of it is this event's
  // `relatedTarget` — where focus was GOING. (jsdom orders these differently and
  // passes on `focusin` alone, which is how a first draft shipped blind to it.)
  const onFocusOut = (e: FocusEvent) => record(e.relatedTarget)
  document.addEventListener('focusin', onFocusIn, true)
  document.addEventListener('focusout', onFocusOut, true)
  let stopped = false
  return {
    stop() {
      if (stopped) return
      stopped = true
      document.removeEventListener('focusin', onFocusIn, true)
      document.removeEventListener('focusout', onFocusOut, true)
    },
    candidates() {
      return [...seen].reverse().concat(opener ? [opener] : [])
    },
  }
}

/**
 * Rules 1–3, run once the dialog has finished closing. Returns what took focus,
 * or null when nothing moved (focus already placed, or nowhere to return to).
 */
export function returnFocusAfterDialog(candidates: FocusTarget[]): HTMLElement | null {
  if (!focusIsLost()) return null
  if (candidates.length === 0) return null
  let focused: HTMLElement | null = null
  for (const c of candidates) {
    if (canTakeFocus(c.el) && tryFocus(c.el)) { focused = c.el; break }
  }
  if (!focused) {
    for (const c of candidates) {
      focused = focusSamePlace(c)
      if (focused) break
    }
  }
  if (!focused) return focusMainContent()
  const watched = captureFocusTarget(focused)
  if (watched) watchRestoredFocus(watched)
  return focused
}
