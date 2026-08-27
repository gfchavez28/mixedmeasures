import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '@/lib/strip-comments'

/**
 * The Variables view's detail pane declares a SURFACE, and the two rule panels
 * agree about which side of it they sit on (#857).
 *
 * **The defect this pins.** The pane carried no background at all, so it fell
 * through to the page: in light mode the page grey showed through, and in DARK
 * mode it rendered as the darkest region on screen while the variable list and
 * the properties grid beside it were both `bg-mm-surface`. One missing class,
 * both themes, opposite directions — which is why it read as "monochrome grey
 * chrome" and why no token adjustment could have fixed it.
 *
 * 🔴 **Why the SECOND and THIRD assertions exist: inverting the ground inverts
 * every raised/recessed relationship inside it.** The saved-rule card was
 * `bg-mm-surface` and read as raised only because the pane behind it was grey.
 * Giving the pane its own surface without recessing the card would have made it
 * white-on-white behind a 1.54:1 border — trading one invisible panel for
 * another, which is the shape of a fix that passes review by looking at only the
 * thing it was aimed at.
 *
 * 🔴 **And the fourth: the "Not applied" chip was `bg-mm-bg`, the SAME value the
 * card now carries**, so recessing the card would have erased a state Decision C
 * added deliberately (it replaced a bare star icon with no accessible name). A
 * knock-on two edits away from the one being made.
 *
 * ⚠️ **jsdom computes no layout and resolves no Tailwind**, so none of this can
 * be asserted by rendering. These are TECHNIQUE assertions over source, in the
 * shape `responsive-chrome.test.ts` uses, and the real verification was live
 * measurement in both themes (recorded in ISSUES #857).
 *
 * ⚠️ **Comments MUST be stripped before scanning.** The prose in
 * `RecodeWorkbench.tsx` explaining this change quotes `bg-mm-surface` and
 * `bg-mm-bg` by name — a naive scan would match its own explanation and pass
 * while the code said anything at all (#772's phantom class, reached from the
 * documentation side).
 */

const FILE = join(__dirname, 'RecodeWorkbench.tsx')
const source = stripComments(readFileSync(FILE, 'utf8'))

describe('#857 — the Variables view detail pane declares its own surface', () => {
  it('reads a real file with the class strings still in it (population self-check)', () => {
    // Without this, every assertion below passes by finding nothing — the
    // failure mode #729/#730 name, and the one a stripper bug produces.
    expect(source.length).toBeGreaterThan(50_000)
    expect(source).toContain('flex-grow overflow-y-auto')
    expect(source).toContain('bg-mm-surface')
    // And prove the stripper actually removed prose: the explanatory comments
    // name #857, so a surviving mention means nothing was stripped.
    expect(source).not.toContain('#857')
  })

  it('gives the scrollable detail pane a background token', () => {
    // ⚠️ TWO elements in this file carry `flex-grow overflow-y-auto` — the
    // variable list's scroller and the detail pane. A bare `.match()` returns
    // the FIRST, which is the list, so a naive probe reports the pane unstyled
    // no matter what the pane says. (This caught a live DOM probe during the
    // #857 investigation too, in exactly the same way.) The detail pane is the
    // one with padding.
    const scrollers = source.match(/className="[^"]*flex-grow overflow-y-auto[^"]*"/g) ?? []
    expect(scrollers.length, 'expected both scrollers to be found').toBeGreaterThanOrEqual(2)

    const pane = scrollers.filter(c => /\bp-4\b/.test(c))
    expect(
      pane.length,
      'the detail pane (the padded scroller) was not found — has its class list changed?',
    ).toBe(1)
    expect(
      pane[0],
      'the detail pane must declare a surface; without one it falls through to the page and ' +
        'renders as the only unelevated region in the view (light) or the darkest one (dark)',
    ).toMatch(/\bbg-mm-\w/)
  })

  it('recesses BOTH rule panels, so neither is white-on-white', () => {
    // The saved-rule card and the new-definition form are the same kind of
    // object and must sit on the same side of the pane's surface.
    const savedCard = source.match(/className="border rounded-lg bg-mm-\w+"/)
    const newDefinition = source.match(/className="border rounded-lg p-3 bg-mm-\w+"/)
    expect(savedCard, 'saved-rule card container not found').not.toBeNull()
    expect(newDefinition, 'NewDefinitionForm container not found').not.toBeNull()

    expect(savedCard![0]).toContain('bg-mm-bg')
    expect(newDefinition![0]).toContain('bg-mm-bg')
  })

  it('does not paint a chip in the same fill as the card it sits on', () => {
    // `bg-mm-bg` is now the CARD's fill, so any chip inside a rule card that
    // reuses it is invisible. The "Not applied" state and the unknown-recode-type
    // fallback are the two that did.
    const notApplied = source.match(/text-\[11px\] px-1\.5 py-0\.5 rounded[^"]*/)
    expect(notApplied, '"Not applied" chip classes not found').not.toBeNull()
    expect(
      notApplied![0],
      'this chip sits inside a bg-mm-bg card, so it cannot also be bg-mm-bg',
    ).not.toMatch(/\bbg-mm-bg\b/)

    const typeFallback = source.match(/label: definition\.recode_type, cls: '([^']*)'/)
    expect(typeFallback, 'recode-type badge fallback not found').not.toBeNull()
    expect(typeFallback![1]).not.toMatch(/\bbg-mm-bg\b/)
  })
})

describe('#857 ride-along — every <select> on this view has an accessible name', () => {
  it('names all four selects (#823f naming arm; measured bare "combobox" in the a11y tree)', () => {
    const selects = source.match(/<select\b[\s\S]{0,240}?>/g) ?? []
    // Population self-check: the count is asserted so a regex that stops
    // matching reports a failure rather than a clean sweep of nothing.
    // ⚠️ FOUR, not three — the reverse-source select was already named, and
    // writing "three" here (the number this change ADDED) is how a count starts
    // rotting. This assertion caught exactly that miscount when first run.
    expect(selects.length, 'expected the four <select> controls in this view').toBe(4)

    const unnamed = selects.filter(s => !/aria-label=|aria-labelledby=/.test(s))
    expect(
      unnamed,
      'a <select> whose only visible text is its selected value names the CHOICE, never the control',
    ).toEqual([])
  })
})
