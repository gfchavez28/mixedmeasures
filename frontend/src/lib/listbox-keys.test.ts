import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { listboxKeyIntent } from './listbox-keys'
import { stripComments } from './strip-comments'

const ctrl = { ctrl: true }
const none = {}

describe('listboxKeyIntent — the bare keys (#823f, unchanged behaviour)', () => {
  it('moves and selects, which is what drives the detail panel', () => {
    expect(listboxKeyIntent('ArrowDown', none, 0, 48)).toEqual({ type: 'select', index: 1 })
    expect(listboxKeyIntent('ArrowUp', none, 5, 48)).toEqual({ type: 'select', index: 4 })
    expect(listboxKeyIntent('Home', none, 5, 48)).toEqual({ type: 'select', index: 0 })
    expect(listboxKeyIntent('End', none, 5, 48)).toEqual({ type: 'select', index: 47 })
  })

  it('clamps at both ends rather than wrapping', () => {
    expect(listboxKeyIntent('ArrowUp', none, 0, 48)).toEqual({ type: 'none' })
    expect(listboxKeyIntent('ArrowDown', none, 47, 48)).toEqual({ type: 'none' })
    expect(listboxKeyIntent('Home', none, 0, 48)).toEqual({ type: 'none' })
    expect(listboxKeyIntent('End', none, 47, 48)).toEqual({ type: 'none' })
  })

  it('lands on the FIRST option from "nothing selected", both directions', () => {
    // The state the page opens in. ArrowUp must not wrap to the end — a
    // keyboard user pressing up on a fresh list expects the top of it.
    expect(listboxKeyIntent('ArrowDown', none, -1, 48)).toEqual({ type: 'select', index: 0 })
    expect(listboxKeyIntent('ArrowUp', none, -1, 48)).toEqual({ type: 'select', index: 0 })
  })

  it('is inert on an empty list', () => {
    for (const k of ['ArrowDown', 'ArrowUp', 'Home', 'End', ' ']) {
      expect(listboxKeyIntent(k, none, -1, 0), k).toEqual({ type: 'none' })
      expect(listboxKeyIntent(k, ctrl, -1, 0), k).toEqual({ type: 'none' })
    }
  })

  it('ignores keys it does not own', () => {
    for (const k of ['a', 'Enter', 'Tab', 'PageDown', 'Escape', 'ArrowLeft', 'ArrowRight']) {
      expect(listboxKeyIntent(k, none, 3, 48), k).toEqual({ type: 'none' })
    }
  })
})

describe('listboxKeyIntent — the modified keys, which is what the mouse could always do', () => {
  it('Ctrl+Arrow moves the cursor WITHOUT selecting', () => {
    expect(listboxKeyIntent('ArrowDown', ctrl, 0, 48)).toEqual({ type: 'focus', index: 1 })
    expect(listboxKeyIntent('ArrowUp', ctrl, 5, 48)).toEqual({ type: 'focus', index: 4 })
    expect(listboxKeyIntent('Home', ctrl, 5, 48)).toEqual({ type: 'focus', index: 0 })
    expect(listboxKeyIntent('End', ctrl, 5, 48)).toEqual({ type: 'focus', index: 47 })
  })

  it('Cmd is the same modifier — this app ships on macOS', () => {
    expect(listboxKeyIntent('ArrowDown', { meta: true }, 0, 48)).toEqual({ type: 'focus', index: 1 })
    expect(listboxKeyIntent(' ', { meta: true }, 3, 48)).toEqual({ type: 'toggle' })
  })

  it('Ctrl+Space toggles membership, mirroring Ctrl-click', () => {
    expect(listboxKeyIntent(' ', ctrl, 3, 48)).toEqual({ type: 'toggle' })
    expect(listboxKeyIntent('Spacebar', ctrl, 3, 48)).toEqual({ type: 'toggle' })
  })

  it('BARE Space is left to the page — the list scrolls', () => {
    // Claiming it would take the scroll key away from a 48-row list to do
    // something the modifier already does (#784's "a control owns Space" rule
    // pointing the other way).
    expect(listboxKeyIntent(' ', none, 3, 48)).toEqual({ type: 'none' })
  })

  it('will not toggle with no option under the cursor', () => {
    expect(listboxKeyIntent(' ', ctrl, -1, 48)).toEqual({ type: 'none' })
  })

  it('leaves Alt and Shift alone', () => {
    // Alt is the platform's (menu access, word motion). Shift is reserved: the
    // range gesture is not implemented, and doing something ELSE with it would
    // be worse than doing nothing.
    expect(listboxKeyIntent('ArrowDown', { alt: true }, 0, 48)).toEqual({ type: 'none' })
    expect(listboxKeyIntent('ArrowDown', { shift: true }, 0, 48)).toEqual({ type: 'none' })
    expect(listboxKeyIntent('ArrowDown', { ctrl: true, shift: true }, 0, 48)).toEqual({ type: 'none' })
    expect(listboxKeyIntent(' ', { ctrl: true, alt: true }, 3, 48)).toEqual({ type: 'none' })
  })
})

describe('the Variables listbox routes through it', () => {
  const WORKBENCH = join(__dirname, '..', 'pages', 'RecodeWorkbench.tsx')
  const src = stripComments(readFileSync(WORKBENCH, 'utf8'), WORKBENCH)

  it('read the file it is scanning', () => {
    // Self-check per narrowing (#814): every assertion below is a substring
    // test, and all of them pass vacuously against an empty string.
    expect(src).toContain('role="listbox"')
    expect(src.length).toBeGreaterThan(10_000)
  })

  it('does not re-derive the key mapping in the component', () => {
    expect(src).toContain('listboxKeyIntent')
    // The arithmetic this replaced: an inline list of the four keys next to a
    // hand-rolled index clamp. A second copy is the defect this module prevents.
    expect(src).not.toMatch(/\[\s*'ArrowDown'\s*,\s*'ArrowUp'\s*,\s*'Home'\s*,\s*'End'\s*\]/)
  })

  it('still announces multi-select — the attribute is now true', () => {
    expect(src).toContain('aria-multiselectable')
  })
})
