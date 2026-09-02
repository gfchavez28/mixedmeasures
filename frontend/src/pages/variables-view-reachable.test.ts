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
  // ── The NAMING arm (#823f, 2026-08-31) ────────────────────────────────────
  //
  // The reachability arm above shipped 2026-08-26 and this half did not, so the
  // item was stamped fixed while Lighthouse still failed on it. Re-measured live
  // before this batch, and TWO of the three filed claims had expired:
  //
  //  - `select-name` PASSES. All four `<select>`s gained an `aria-label` in
  //    `a09db12` (#857, the surfaces fix), which never mentioned #823(f).
  //  - The `Exclude` checkboxes were named by #818, as the entry predicted.
  //  - What remained: `label` failing on TWO nodes, both the saved-rule Name
  //    field, whose visible <label> was never associated.
  //
  // After: accessibility 95 → 100, zero failing a11y audits.
  describe('the naming arm — every field states what it is', () => {
    /**
     * Opening `<Input …/>` tags. Comments already stripped (#772).
     *
     * ⚠️ **A `[^>]*` regex finds ZERO of them and the population self-check is
     * what caught that** — these tags carry arrow functions
     * (`onChange={e => setNewLabel(...)}`), so the first `>` a naive matcher
     * meets is the one in `=>`, not the end of the tag. The walker tracks brace
     * depth and quotes and stops at the real terminator. #772's lesson applied
     * to this guard's own parser: a scan that reads its target wrongly reports
     * clean, and blindness is worse than a phantom because it is silent.
     */
    const inputTags = (src: string): string[] => {
      const out: string[] = []
      const re = /<Input\b/g
      let m: RegExpExecArray | null
      while ((m = re.exec(src))) {
        let depth = 0, quote = '', i = m.index
        for (; i < src.length; i++) {
          const c = src[i]
          if (quote) { if (c === quote && src[i - 1] !== '\\') quote = '' ; continue }
          if (c === '"' || c === "'" || c === '`') { quote = c; continue }
          if (c === '{') depth++
          else if (c === '}') depth--
          else if (c === '>' && depth === 0) break
        }
        out.push(src.slice(m.index, i + 1))
      }
      return out
    }

    it('THE INPUT SCAN FOUND A REAL POPULATION', () => {
      // POPULATION self-check: `toEqual([])` below cannot detect its own
      // blindness if the tag shape changes or the file moves.
      expect(inputTags(source).length).toBeGreaterThanOrEqual(6)
    })

    it('every Input has a name that is not just a placeholder', () => {
      // A placeholder IS accepted by axe as a name source — which is why
      // Lighthouse passed four of these fields — but the first character typed
      // erases it. #559's rule ("a tooltip is not a name") one control over.
      const offenders = inputTags(source)
        .filter(t => !/aria-label|aria-labelledby|\bid=/.test(t))
        .map(t => t.replace(/\s+/g, ' ').slice(0, 100))

      expect(
        offenders,
        'An <Input> with neither an aria-label nor an id (for a <label ' +
          'htmlFor>) has no durable accessible name. A placeholder is not one.',
      ).toEqual([])
    })

    it('the saved-rule Name field is ASSOCIATED with its visible label', () => {
      // The one Lighthouse `label` failure. Associating the existing visible
      // label beats an aria-label here: the visible text stays the accessible
      // name (WCAG 2.5.3) and clicking "Name" focuses the field.
      expect(source).toContain('htmlFor={`rule-name-${definition.id}`}')
      expect(source).toContain('id={`rule-name-${definition.id}`}')
    })

    it('the expanded card is a labelled region, so its controls need no suffix', () => {
      // Several cards can be open at once. Measured live with two expanded:
      // `Value for Depends` appeared twice and `Value for Try to be helpful`
      // three times. The fix is ONE group label, not a rule name folded into
      // up to 40 row names — which would trade #785 for unusable verbosity.
      expect(source).toContain('role="group" aria-labelledby={`rule-title-${definition.id}`}')
      expect(source).toContain('id={`rule-title-${definition.id}`}')
    })

    it('the add-response controls name their own rule', () => {
      // These are per-EDITOR, not per-row, so there are two or three on screen
      // and the rule name is cheap context rather than noise.
      expect(source).toContain('aria-label={`Add a response to ${ownerLabel}`}')
      expect(source).toContain('aria-label={`Add response to ${ownerLabel}`}')
    })

    it('both editors require ownerLabel, so a new call site must decide', () => {
      // Required (not optional) is what stops the next editor call site from
      // silently reintroducing an unnamed control.
      const required = source.match(/^\s*ownerLabel: string$/gm) ?? []
      expect(required.length).toBe(2)
    })

    it('the Input scan can actually fail', () => {
      // PREDICATE falsifier, written against literal text so fixing the
      // codebase can never invalidate the control (#729).
      const bad = '<Input value={x} placeholder="Type here..." className="h-7" />'
      expect(inputTags(bad).filter(t => !/aria-label|aria-labelledby|\bid=/.test(t)))
        .toHaveLength(1)
      const good = '<Input value={x} aria-label="Rule name" />'
      expect(inputTags(good).filter(t => !/aria-label|aria-labelledby|\bid=/.test(t)))
        .toHaveLength(0)
    })
  })
})
