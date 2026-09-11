import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '@/lib/strip-comments'

/**
 * #934 — an ARCHIVE control must not be drawn as a delete.
 *
 * #912 established the rule for the NAME ("a name is a claim about the act") and
 * renamed one of these buttons. The icon and the colour are the two channels a
 * sighted researcher reads FIRST, and they still said the opposite: `Trash2`, the
 * same glyph the permanent-delete button uses, hovering red.
 *
 * 🔴 **WRITTEN AS A POPULATION ASSERTION, NEVER A LIST OF THE SITES I KNEW ABOUT.**
 * #934 named `MemosPanelContent.tsx`. Enumerating by what the control DOES found
 * **three** components: that one, `MemoPanel.tsx` (the surface #912 itself had
 * fixed, where the name was corrected and the icon left) and `NotesPanel.tsx`
 * (never swept, and its control had no accessible name at all). That is the
 * #771/#785 shape — a rule shipping partially, repeatedly — and the per-control
 * form of this guard is exactly what let it happen twice.
 *
 * ⚠️ A SOURCE scan, deliberately. The risk is not that today's three regress; it
 * is the FOURTH archive control, written by someone who never read #912.
 */

const SRC = join(__dirname, '..')
const read = (rel: string) => stripComments(readFileSync(join(SRC, rel), 'utf8'))

/** Every component that renders a control which archives something. */
const ARCHIVE_SURFACES = [
  'components/MemosPanelContent.tsx',
  'components/MemoPanel.tsx',
  'components/NotesPanel.tsx',
] as const

/**
 * The opening tag of every `<Button>`/`<button>` whose accessible name or title
 * claims it archives, with the JSX that follows up to its closing tag.
 */
function archiveControls(source: string): string[] {
  const out: string[] = []
  // ⚠️ **ANCHORED TO THE REAL TERMINATOR, NEVER A CHARACTER BUDGET.** The first
  // draft capped the window at 700 chars and went BLIND on `MemoPanel.tsx`, whose
  // archive block is 728 — so the guard reported that file as having no archive
  // control at all. That is `crosswalk-grid-a11y.test.ts`'s documented bug
  // reproduced here, and the POPULATION self-check below is the only reason it
  // surfaced instead of passing quietly. The backreference keeps `<Button>` and
  // `<button>` from closing each other.
  const re = /<(Button|button)\b[\s\S]*?<\/\1>/g
  for (const m of source.matchAll(re)) {
    const block = m[0]
    if (/aria-label=\{?`?Archive |title="Archive /.test(block)) out.push(block)
  }
  return out
}

describe('#934: an archive control is not drawn as a delete', () => {
  it('finds an archive control on every surface that has one', () => {
    // POPULATION self-check (#729/#730). `toEqual([])` below passes by finding
    // nothing, which is indistinguishable from real success — so prove the walk
    // sees something on each file first, and that the total is the measured 3.
    const perFile = ARCHIVE_SURFACES.map(f => archiveControls(read(f)).length)
    for (const [i, n] of perFile.entries()) {
      expect(n, `${ARCHIVE_SURFACES[i]} has no archive control`).toBeGreaterThanOrEqual(1)
    }
    expect(perFile.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(3)
  })

  it('none of them renders a trash icon', () => {
    const offenders: string[] = []
    for (const file of ARCHIVE_SURFACES) {
      for (const block of archiveControls(read(file))) {
        if (/<Trash2\b/.test(block)) offenders.push(`${file}: archive control renders <Trash2>`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('none of them hovers red', () => {
    // Colour is the second channel. An archive button that turns red on hover is
    // making the same false claim the icon made.
    const offenders: string[] = []
    for (const file of ARCHIVE_SURFACES) {
      for (const block of archiveControls(read(file))) {
        if (/hover:text-red|hover:bg-red|text-red-600/.test(block)) {
          offenders.push(`${file}: archive control uses a destructive colour`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('every one of them carries an accessible name, not only a title', () => {
    // `NotesPanel`'s had only a `title` — the weakest naming route (#559) — and it
    // named no particular note among N identical buttons (#891(a)).
    const offenders: string[] = []
    for (const file of ARCHIVE_SURFACES) {
      for (const block of archiveControls(read(file))) {
        if (!/aria-label=/.test(block)) offenders.push(`${file}: archive control has no aria-label`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the matcher fires on a trash-drawn archive control (predicate falsifier)', () => {
    const planted = '<Button aria-label={`Archive memo: x`}><Trash2 className="hover:text-red-500" />Archive</Button>'
    const found = archiveControls(planted)
    expect(found).toHaveLength(1)
    expect(/<Trash2\b/.test(found[0])).toBe(true)
  })
})

/**
 * #934's other half — the CONFIRM. `ConfirmDialog`'s `destructive` prop defaults
 * to **true**, so the red irreversible-action styling was inherited rather than
 * chosen, under copy that reads "You can restore it later".
 */
describe('#934: the archive confirm is not dressed as destructive', () => {
  it('the archive ConfirmDialog opts out of the destructive default', () => {
    const src = read('components/MemosPanelContent.tsx')
    const i = src.indexOf('title="Archive memo"')
    expect(i).toBeGreaterThan(-1)
    const block = src.slice(Math.max(0, i - 400), i + 400)
    expect(block).toMatch(/destructive=\{false\}/)
  })

  it('ConfirmDialog still defaults to destructive (the reason the opt-out is needed)', () => {
    // If this default ever flips, the opt-out above becomes noise and the
    // permanent-delete dialogs silently lose their red — assert the premise.
    expect(read('components/ConfirmDialog.tsx')).toMatch(/destructive\s*=\s*true/)
  })
})

/**
 * #933 — no hand-rolled `role="button"` survives in the memos panel, and in
 * particular none nested inside a real `<button>`.
 */
describe('#933: the memos panel has no hand-rolled buttons', () => {
  it('renders no role="button"', () => {
    const src = read('components/MemosPanelContent.tsx')
    expect(src).not.toMatch(/role="button"/)
  })

  it('the group disclosure and the focus toggle are siblings, not nested', () => {
    const src = read('components/MemosPanelContent.tsx')
    // The disclosure owns aria-expanded; the focus toggle owns aria-pressed.
    // If either were inside the other, one control's name would absorb the other.
    const disclosure = src.indexOf('aria-expanded={isGroupExpanded}')
    const focusToggle = src.indexOf('aria-pressed={isGroupFocused}')
    expect(disclosure).toBeGreaterThan(-1)
    expect(focusToggle).toBeGreaterThan(-1)
    const between = src.slice(disclosure, focusToggle)
    expect(between, 'the disclosure button must close before the focus toggle opens')
      .toMatch(/<\/button>/)
  })
})
