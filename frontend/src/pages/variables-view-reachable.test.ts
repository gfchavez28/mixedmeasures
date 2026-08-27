/**
 * #823(f) — the Variables view was largely keyboard-unreachable.
 *
 * 🔴 **Measured live on the GSS corpus: 48 clickable `div`s with no role and no
 * tab stop**, plus the saved-rule card headers. That matters more than the count
 * suggests, because the card is the ONLY route to *Apply to this variable* /
 * *Create as new variable* / *Copy to* / *Re-derive* / *Delete* — so every
 * action on a saved recode rule was mouse-only — and the variable list is the
 * only way to change which variable you are editing.
 *
 * ⚠️ **There was no second route, and that was checked rather than assumed.**
 * The properties grid beside the list IS navigable (roving tabindex, arrows move
 * between gridcells — driven live), but moving in it does not change the
 * selected variable. So a keyboard user could reach the rule editor for exactly
 * one variable: whichever the mouse had last selected.
 *
 * ⚠️ **The filed "50" is a RENDERED-node count, not a work estimate.** In source
 * there are two patterns — one list row and one card header — instantiated 48
 * and N times. Scoping the fix from the rendered figure would have looked like
 * fifty edits.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '@/lib/strip-comments'

const SRC = join(__dirname, '..')
const source = stripComments(readFileSync(join(SRC, 'pages/RecodeWorkbench.tsx'), 'utf8'))

/** Opening `<div …>` tags, comments already removed (#772: never scan prose). */
function divTags(src: string): string[] {
  return src.match(/<div\b[^>]*>/gs) ?? []
}

describe('#823(f) — every control in the Variables view is reachable', () => {
  it('has no clickable div without a role', () => {
    const offenders = divTags(source)
      .filter(t => t.includes('onClick'))
      .filter(t => !t.includes('role='))
      .map(t => t.replace(/\s+/g, ' ').slice(0, 90))

    expect(
      offenders,
      'A clickable `div` with no role is invisible to assistive tech and has no ' +
        'tab stop. Use a real control, or `role="option"`/`role="button"` WITH a ' +
        'tabIndex and key handling — never the role alone (#701b).',
    ).toEqual([])
  })

  it('every clickable div that has a role also has a tab stop', () => {
    // The half that is easy to ship on its own and is worth nothing alone:
    // a role announces the control, a tabIndex is what lets anyone reach it.
    const offenders = divTags(source)
      .filter(t => t.includes('onClick') && t.includes('role='))
      .filter(t => !t.includes('tabIndex'))
      .map(t => t.replace(/\s+/g, ' ').slice(0, 90))
    expect(offenders).toEqual([])
  })

  it('THE SCAN FOUND A REAL POPULATION', () => {
    // POPULATION self-check (#729/#730). `toEqual([])` is the shape that cannot
    // detect its own blindness: a scan whose regex rots, or whose file moves,
    // finds nothing and passes. This file has ~48 div tags; if that collapses,
    // the assertions above are measuring an empty string.
    expect(divTags(source).length).toBeGreaterThan(20)
  })

  it('the div scan can actually fail', () => {
    // PREDICATE falsifier, written against source text so that fixing the
    // codebase can never invalidate the control (#729).
    const bad = '<div className="cursor-pointer" onClick={go}>x</div>'
    expect(divTags(bad).filter(t => t.includes('onClick') && !t.includes('role=')))
      .toHaveLength(1)
  })

  describe('the variable list is a listbox', () => {
    it('declares itself, and declares that it takes more than one selection', () => {
      expect(source).toContain('role="listbox"')
      // ctrl-click toggles and shift-click ranges into `bulkSelected`; a
      // single-select listbox would misdescribe that to a screen reader.
      expect(source).toContain('aria-multiselectable="true"')
    })

    it('rows are options that state whether they are selected', () => {
      expect(source).toContain('role="option"')
      expect(source).toMatch(/aria-selected=\{isSelected \|\| isBulk\}/)
    })

    it('costs ONE tab stop, not one per row', () => {
      // #701b: roving tabindex. 48 tab stops is not accessibility, it is a
      // keyboard trap with extra steps.
      expect(source).toMatch(/tabIndex=\{isTabStop \? 0 : -1\}/)
    })

    it('and the roving stop is paired with real arrow handling', () => {
      // ⚠️ Never flip the tab stops without the arrows — with `-1` everywhere
      // and no key handler, the rows become LESS reachable than before.
      //
      // ⚠️ The KEY NAMES moved to `lib/listbox-keys.ts` on 2026-08-26, so this
      // asserts the wiring and that module's own test asserts the mapping. A
      // scan for `'ArrowDown'` in this file would now fail for the right code
      // and pass for a re-inlined copy — the wrong way round.
      expect(source).toContain('handleColumnListKeyDown')
      expect(source).toContain('listboxKeyIntent')
    })

    it('the multi-select it announces is reachable from the keyboard', () => {
      // `aria-multiselectable` above is a claim. Ctrl-click has always toggled a
      // variable into `bulkSelected`; until the modified keys landed, no
      // keyboard gesture did — the attribute described the mouse only.
      expect(source).toMatch(/ctrl:\s*e\.ctrlKey/)
      expect(source).toMatch(/meta:\s*e\.metaKey/)
      expect(source).toMatch(/intent\.type === 'toggle'/)
    })

    it('the cursor follows FOCUS, not the selection alone', () => {
      // Ctrl+Arrow parts the two deliberately; a plain arrow afterwards must
      // continue from where the user is, not jump back to the selected row.
      expect(source).toMatch(/data-column-id/)
      expect(source).toMatch(/Number\.isNaN\(focusedId\) \? selectedColumnId : focusedId/)
    })

    it('the list is always enterable, even with nothing selected', () => {
      // Otherwise every row is tabIndex -1 on first load and Tab skips the list
      // entirely — the defect this fix exists to remove, reintroduced.
      expect(source).toMatch(/!selectedColumnId && idx === 0/)
    })

    it('does NOT declare a set size', () => {
      // #758/#772's boundary: the DOM holds every row, so a reader can count
      // them. `aria-setsize` is for VIRTUALISED lists, and adding it here by
      // analogy would be a second source for a number the DOM already states.
      expect(source).not.toContain('aria-setsize')
    })
  })

  describe('the saved-rule card header', () => {
    it('is a real button, not a div wearing a role', () => {
      expect(source).toMatch(/<button\s+type="button"\s+aria-expanded=\{isExpanded\}/)
    })

    it('keeps the row layout a button would otherwise collapse', () => {
      // A button centres its content and shrink-wraps; without these the header
      // silently re-lays-out. Cheap to lose in a refactor, obvious on screen.
      const header = source.slice(source.indexOf('aria-expanded={isExpanded}'))
      expect(header.slice(0, 400)).toContain('w-full text-left')
    })
  })
})
