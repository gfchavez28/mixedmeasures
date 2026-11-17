/**
 * Where keyboard focus goes after a press that takes its own control away (#1660, D345).
 *
 * the internal design notes #955 b: "Ask of every act that can END a list: where is
 * `document.activeElement` afterwards?" — and #1407: a press that DISABLES its own button is the
 * same class. In the joint display, five presses removed their own control and left focus
 * nowhere useful: *Remove construct* and slice 1's *Add … strand* in the builder (focus on the
 * dialog — Radix's focus scope takes it there — so the next Tab restarts at the top), and the open
 * construct's *Unpin this quote*, a fit's *Remove* and *Add a fit* at the last pair (no dialog
 * around them: focus on `<body>`, the top of the page). The caps' presses were the first instance
 * (2026-11-15d, the builder's `focusLandingAfterAdd`, which this replaces).
 *
 * After a press made WITH focus, and only while focus is still LOST — on `<body>`, on the pressed
 * button now disabled or gone (jsdom keeps focus there), or, when the button is gone, on the
 * dialog Radix moved it to — focus lands on `pick(scope)`, the control that acts next. A press
 * that keeps its button (below a cap, a list that still has the row) moves nothing.
 *
 * `scope` is read AT THE PRESS — the pressed control's dialog, else the document — because by
 * the time the landing runs the control may be detached and `closest` finds nothing.
 */
export function landAfterPress(
  pressed: HTMLElement,
  pick: (scope: ParentNode) => HTMLElement | null | undefined,
): () => void {
  if (document.activeElement !== pressed) return () => {}
  const dialog = pressed.closest<HTMLElement>('[role="dialog"]')
  const scope: ParentNode = dialog ?? document
  return () => requestAnimationFrame(() => {
    const active = document.activeElement
    const gone = !pressed.isConnected
    const disabled = (pressed as HTMLButtonElement).disabled === true
    const lost = active == null || active === document.body
      || (active === pressed && (disabled || gone))
      || (gone && dialog != null && active === dialog)
    if (!lost) return
    pick(scope)?.focus()
  })
}

/** The last element matching `selector` in `scope` — a new item's field after an add. */
export function lastIn(scope: ParentNode, selector: string): HTMLElement | null {
  const all = scope.querySelectorAll<HTMLElement>(selector)
  return all.length > 0 ? all[all.length - 1] : null
}

/** The element now at `index` (the one that took a removed item's place), else the last before it. */
export function atOrBefore(scope: ParentNode, selector: string, index: number): HTMLElement | null {
  const all = scope.querySelectorAll<HTMLElement>(selector)
  return all.length > 0 ? all[Math.min(index, all.length - 1)] : null
}
