import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { stripComments } from './strip-comments'
import { join } from 'node:path'
import { focusedElementOwnsKey, focusIsOnAnotherControl, ACTIVATION_KEYS } from './keyboard-scope'

/**
 * #784 — a global keyboard layer must not claim a key the focused control owns.
 *
 * The defect this pins: `useCodeChordShortcuts` listens on `window` and calls
 * `preventDefault()` when a workbench `extraKeys` handler claims a key. Space was
 * claimed whenever the workbench believed its list panel was "focused" — app state that
 * stays true while DOM focus sits on a toolbar button. Measured in Chrome before the
 * fix: `Fit` focused, Space pressed → **zero clicks**, and the video started playing.
 * Every plain button on the Observations workbench was inoperable by Space, and on a
 * conversation with no recording Space was swallowed to no effect at all.
 *
 * ⚠️ The assertions below are written as a POPULATION over `ACTIVATION_KEYS` × the
 * owning roles, not as a list of the two cases that were reported. The per-case form is
 * what let #771's rule ship partial three times.
 */

describe('focusedElementOwnsKey', () => {
  const el = (html: string): Element => {
    const host = document.createElement('div')
    host.innerHTML = html
    return host.firstElementChild!
  }

  /** Every role whose control performs its own action on Space. */
  const SPACE_OWNERS = [
    'button', 'checkbox', 'radio', 'switch', 'tab',
    'menuitem', 'menuitemcheckbox', 'menuitemradio',
  ]

  describe('population: every activation key stands down on every owning role', () => {
    for (const key of ACTIVATION_KEYS) {
      for (const role of SPACE_OWNERS) {
        it(`${JSON.stringify(key)} on role="${role}"`, () => {
          expect(focusedElementOwnsKey(key, el(`<div role="${role}"></div>`))).toBe(true)
        })
      }
    }
  })

  it('reads a real <button> with no explicit role', () => {
    for (const key of ACTIVATION_KEYS) {
      expect(focusedElementOwnsKey(key, el('<button>Fit</button>'))).toBe(true)
    }
  })

  it('treats <summary> as activating — it toggles its <details> on both keys', () => {
    for (const key of ACTIVATION_KEYS) {
      expect(focusedElementOwnsKey(key, el('<summary>More</summary>'))).toBe(true)
    }
  })

  it('a link activates on Enter but NOT on Space', () => {
    const link = el('<a href="/x">go</a>')
    expect(focusedElementOwnsKey('Enter', link)).toBe(true)
    expect(focusedElementOwnsKey(' ', link)).toBe(false)
  })

  it('an anchor with no href is not a link and owns nothing', () => {
    expect(focusedElementOwnsKey('Enter', el('<a>go</a>'))).toBe(false)
  })

  it('input types that activate are covered even though the hook refuses them earlier', () => {
    expect(focusedElementOwnsKey(' ', el('<input type="checkbox" />'))).toBe(true)
    expect(focusedElementOwnsKey(' ', el('<input type="submit" />'))).toBe(true)
    expect(focusedElementOwnsKey(' ', el('<input type="text" />'))).toBe(false)
  })

  /**
   * ⚠️ The whole point of the fix is that the chord layer stays global. If this ever
   * goes green for a letter or a digit, pressing `c` with a toolbar button focused
   * would stop creating a code and nobody would notice until a user did.
   */
  it('claims NOTHING for non-activation keys, whatever has focus', () => {
    for (const key of ['c', 'n', 's', 'j', '3', 'Escape', 'ArrowDown', 'F2']) {
      expect(focusedElementOwnsKey(key, el('<button>Fit</button>'))).toBe(false)
    }
  })

  it('is safe on a null focus and on an element that owns nothing', () => {
    expect(focusedElementOwnsKey(' ', null)).toBe(false)
    expect(focusedElementOwnsKey(' ', el('<div role="listbox"></div>'))).toBe(false)
    expect(focusedElementOwnsKey(' ', el('<div></div>'))).toBe(false)
  })

  /**
   * ⚠️ `option` and `treeitem` are deliberately absent from the owning set — the clip
   * and transcript lists put focus on the CONTAINER (`aria-activedescendant`), so Space
   * with a list focused must still reach the workbench and toggle playback. This
   * asserts the exclusion so a future "completeness" edit has to argue with it.
   */
  it('does NOT treat option/treeitem as owners — the lists are activedescendant-driven', () => {
    expect(focusedElementOwnsKey(' ', el('<div role="option"></div>'))).toBe(false)
    expect(focusedElementOwnsKey(' ', el('<div role="treeitem"></div>'))).toBe(false)
  })
})

/**
 * Parity scan — the two workbenches that claim Space must gate it the same way.
 *
 * ⚠️ This exists because the divergence is what the pre-implementation review found:
 * Observations checked `hasPlayableMedia` and CodingWorkbench returned `true`
 * unconditionally, so Space died on a media-less transcript. Both were written from the
 * same documented "sibling workbenches' Space pattern" and only one of them followed it.
 * A behavioural test covers today's two; this fails the day a THIRD surface claims Space
 * without the gate.
 */
describe('#784 parity — every Space claim is gated on playable media', () => {
  const SRC = join(__dirname, '..')
  const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

  const SPACE_CLAIMING_WORKBENCHES = [
    'pages/ObservationWorkbench.tsx',
    'pages/CodingWorkbench.tsx',
  ] as const

  it.each(SPACE_CLAIMING_WORKBENCHES)('%s gates its Space handler', (rel) => {
    const src = stripComments(read(rel))
    const start = src.indexOf("' ': ()")
    expect(start, `no Space extraKey found in ${rel} — did the key move?`).toBeGreaterThan(-1)
    const body = src.slice(start, start + 400)
    expect(body).toContain('hasPlayableMedia')
  })

  it('finds every workbench that claims Space — the scan list cannot go stale silently', () => {
    const consumers = [
      'pages/ObservationWorkbench.tsx',
      'pages/CodingWorkbench.tsx',
      'pages/TextCodingView.tsx',
      'pages/DocumentCodingWorkbench.tsx',
    ]
    const claiming = consumers.filter(rel => stripComments(read(rel)).includes("' ': ()"))
    expect(claiming.sort()).toEqual([...SPACE_CLAIMING_WORKBENCHES].sort())
  })
})

/**
 * #789 — the arrow keys must ask where focus IS, not which panel is "active".
 *
 * ⚠️ This predicate is deliberately the INVERSE of the obvious one, and both reasons
 * were MEASURED rather than reasoned. "Focus must be inside the list container" fails
 * twice: on a fresh load `document.activeElement` is `BODY` and ArrowDown must still
 * select the first clip (the page's primary entry path), and panel navigation focuses a
 * plain container `<div>` from which ArrowLeft must still reach the hook to get back.
 */
describe('focusIsOnAnotherControl', () => {
  const el = (html: string): Element => {
    const host = document.createElement('div')
    host.innerHTML = html
    return host.firstElementChild!
  }

  const CONTROLS = [
    '<button>Fit</button>',
    '<a href="/x">go</a>',
    '<input type="text" />',
    '<select></select>',
    '<textarea></textarea>',
    '<summary>x</summary>',
    '<div role="button"></div>',
    '<div role="checkbox"></div>',
    '<div role="switch"></div>',
    '<div role="tab"></div>',
    '<div role="menuitem"></div>',
    '<div role="menuitemcheckbox"></div>',
    '<div role="combobox"></div>',
    '<div role="slider"></div>',
  ]

  describe('population: every control shape takes the arrows', () => {
    for (const html of CONTROLS) {
      it(html, () => expect(focusIsOnAnotherControl(el(html))).toBe(true))
    }
  })

  /**
   * ⚠️ Each of these is a way the arrows must KEEP working. A regression here does not
   * look like a bug — it looks like the keyboard quietly not working, which is how the
   * defect this fixes survived in the first place.
   */
  describe('population: the surface and "nowhere" keep the arrows', () => {
    it('body — the primary entry path, MEASURED as the on-load focus', () => {
      expect(focusIsOnAnotherControl(document.body)).toBe(false)
    })
    it('null focus', () => {
      expect(focusIsOnAnotherControl(null)).toBe(false)
    })
    it('the list container itself', () => {
      expect(focusIsOnAnotherControl(el('<div role="listbox" tabindex="0"></div>'))).toBe(false)
    })
    it('a plain container div — what panel focus actually lands on', () => {
      expect(focusIsOnAnotherControl(el('<div tabindex="0" class="h-full flex flex-col"></div>'))).toBe(false)
    })
    it('other composite containers', () => {
      for (const r of ['grid', 'tree', 'table', 'application', 'group']) {
        expect(focusIsOnAnotherControl(el(`<div role="${r}"></div>`))).toBe(false)
      }
    })
    it('an anchor with no href is not a link', () => {
      expect(focusIsOnAnotherControl(el('<a>x</a>'))).toBe(false)
    })
    it('rows are never controls — the lists are activedescendant-driven', () => {
      expect(focusIsOnAnotherControl(el('<div role="option"></div>'))).toBe(false)
      expect(focusIsOnAnotherControl(el('<div role="treeitem"></div>'))).toBe(false)
    })
  })

  it('an explicit role wins over the tag in BOTH directions', () => {
    // a focusable container that happens to be a <button> is still a control…
    expect(focusIsOnAnotherControl(el('<button role="button"></button>'))).toBe(true)
    // …and a listbox built on a <button> tag is the surface, not a control.
    expect(focusIsOnAnotherControl(el('<button role="listbox"></button>'))).toBe(false)
  })
})
