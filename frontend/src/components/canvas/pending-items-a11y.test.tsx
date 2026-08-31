/**
 * #854(d) — the canvas inbox must not nest real buttons inside a fake one.
 *
 * `DraggablePendingItem` spread dnd-kit's `attributes` onto a wrapper `<div>`
 * that CONTAINS the insert and dismiss buttons. Those defaults are
 * `role: 'button'`, `tabIndex: 0` and `aria-roledescription: 'draggable'`, so
 * every item exposed interactive content inside an interactive role and cost
 * THREE tab stops instead of two — measured live at 18 stops on a six-item
 * inbox.
 *
 * 🔴 **Nothing is traded away, and that is the argument for the shape.** This
 * canvas's `DndContext` is `PointerSensor` ONLY, so there is no KeyboardSensor
 * for that tab stop to activate: it was a stop that did nothing, wrapping two
 * controls that do. The pointer sensor drives off `listeners`, which are still
 * spread.
 *
 * ⚠️ **This is a SOURCE scan rather than a mount**, deliberately. The component
 * is a private function inside a 2,000-line canvas that needs a `DndContext`, an
 * editor and six queries to render; a mount test here would exercise the harness
 * far more than the rule. What has to hold is structural — which attributes
 * reach the wrapper — and a scan can see that. ⚠️ The `PointerSensor`-only
 * premise is asserted too: if a `KeyboardSensor` is ever added, the reasoning
 * above expires and this must become a real drag HANDLE (the crosswalk's
 * `Bracket` pattern, #327) rather than silently losing keyboard drag.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '@/lib/strip-comments'

const FILE = join(__dirname, 'WritingCanvas.tsx')
const src = stripComments(readFileSync(FILE, 'utf8'), FILE)

/** The wrapper's body — narrowed, with its own self-check (#814). */
function draggableWrapper(): string {
  const start = src.indexOf('function DraggablePendingItem')
  expect(start, 'DraggablePendingItem no longer resolves — re-anchor this scan')
    .toBeGreaterThan(-1)
  const end = src.indexOf('\n}', start)
  expect(end, 'could not find the end of DraggablePendingItem').toBeGreaterThan(start)
  const body = src.slice(start, end)
  // Self-check per NARROWING, not per file: the slice must contain the thing
  // being asserted about, or every assertion below passes by finding nothing.
  expect(body, 'the slice lost the useDraggable call — the scan is vacuous')
    .toContain('useDraggable')
  return body
}

describe('#854(d) — the pending-item wrapper is not a fake button', () => {
  it('read a real file', () => {
    expect(src.length).toBeGreaterThan(20_000)
    expect(src).toContain('DraggablePendingItem')
  })

  it('🔴 does NOT spread dnd-kit attributes wholesale onto the wrapper', () => {
    // `{...attributes}` is what carried role/tabIndex/aria-roledescription in.
    expect(draggableWrapper()).not.toContain('{...attributes}')
  })

  it('strips role, tabIndex AND aria-roledescription', () => {
    const body = draggableWrapper()
    for (const key of ['role:', 'tabIndex:', "'aria-roledescription':"]) {
      expect(body, `${key} must be destructured away from the spread`).toContain(key)
    }
    expect(body).toContain('...dragAttributes')
  })

  it('keeps the drag LISTENERS, so pointer drag still works', () => {
    // The half that must NOT be removed — this is what makes the row draggable.
    expect(draggableWrapper()).toContain('{...listeners}')
  })

  it('🔴 the PointerSensor-only premise still holds', () => {
    // The whole justification for dropping the tab stop. If a KeyboardSensor
    // arrives, this test fails and the remedy is a real drag handle — not
    // putting the attributes back on a wrapper full of buttons.
    expect(src).toContain('useSensor(PointerSensor')
    expect(src, 'a KeyboardSensor was added — see this test\'s docstring')
      .not.toContain('KeyboardSensor')
  })

  it('names the dismiss button after ITS OWN item', () => {
    // N identical "Dismiss pending item" say nothing about which (#559/#785),
    // and this list is exactly that shape.
    expect(src).toContain('aria-label={`Dismiss ${item.source_label?.trim()')
  })
})
