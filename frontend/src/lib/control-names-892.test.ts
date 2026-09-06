import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from './strip-comments'

/**
 * #892 — the controls the 2026-09-06 a11y-name-sweep run found nameless, and the
 * two that named a verb without its object. **Every claim below was measured in
 * Chrome's accessibility tree before and after**; this file pins the MECHANISM
 * that makes each name possible, which is all a jsdom-free source scan can do.
 *
 * 🔴 **THIS IS A REGRESSION PIN, NOT A DISCOVERY GATE, AND THE DIFFERENCE IS THE
 * WHOLE POINT.** #888 established by trying that no static scan can own the
 * naming class: an accessible name arrives at least four ways, so a discovery
 * scan needs an exemption per legitimately-named site and the narrowing attempt
 * was defeated by a template literal inside a `title`. **The sweep
 * (`.claude/skills/a11y-name-sweep/`) is the guard for that class.** What a scan
 * CAN do is hold a site that was measured nameless to the fix it received —
 * exactly the shape of `pages/panel-separators-named.test.ts`.
 *
 * ⚠️ **Comment-stripped, and that is load-bearing here of all places:** the
 * fixes carry explanatory comments that themselves contain the words
 * `aria-label` and `combobox`. Scanning the raw source would let every
 * assertion pass on the strength of the comment explaining it (#823f's class,
 * in a guard written to prevent it).
 *
 * ### What the run established about Radix `SelectTrigger`, by measurement
 *
 * A trigger renders a `<button>` with `role="combobox"`, and **`combobox` is not
 * a name-from-content role**. So exactly three routes name one:
 *
 * 1. `aria-label`
 * 2. `aria-labelledby`
 * 3. an `id` paired with a real `<Label htmlFor>` — a `<button>` IS a labelable
 *    element, so this genuinely works (measured: `combobox "Type"` and
 *    `combobox "Format"` in the Variable details dialog).
 *
 * 🔴 **A `SelectValue placeholder` is NOT one of them, and #889 records it as
 * though it were.** Measured on `MemosPanelContent`'s own trigger — the entry's
 * cited example — Chrome computed **no name at all**, only `value="Project"`.
 * That correction is what turns #889 from "71 sites to inspect by hand" into an
 * enumerable set; see the entry for the current suspect list.
 */

const SRC = join(__dirname, '..')
const read = (rel: string) => stripComments(readFileSync(join(SRC, rel), 'utf8'), rel)

/** Every trigger this run measured nameless in the tree, with the name it got. */
const NAMED_TRIGGERS = [
  { file: 'pages/ConversationsListPage.tsx', name: 'Sort conversations' },
  { file: 'pages/DocumentsListPage.tsx', name: 'Sort documents' },
  { file: 'pages/AppendImport.tsx', name: 'File Encoding' },
  { file: 'components/MemosPanelContent.tsx', name: 'What this memo is about' },
] as const

/** The two quote controls that named a verb and not its object (#785's rule). */
const QUOTE_CONTROLS = [
  {
    file: 'components/ByTextTable.tsx',
    // This table pages ONE column, so the record is what tells its rows apart —
    // and its Record cell is a plain <td>, not the <th scope="row"> that makes
    // the dataset grid's identical `Link...` buttons legible.
    object: 'recordLabel',
  },
  {
    file: 'components/ByRecordPanel.tsx',
    // This panel groups ONE record's answers, so the column is the distinguisher.
    object: 'comment.column_name',
  },
] as const

describe('#892 — controls the sweep found nameless are named', () => {
  it.each(NAMED_TRIGGERS)('$file names its Select trigger', ({ file, name }) => {
    const src = read(file)
    const triggers = src.match(/<SelectTrigger[\s\S]*?>/g) ?? []
    expect(triggers.length, `${file} renders no SelectTrigger — re-anchor this scan`)
      .toBeGreaterThan(0)
    expect(src, `${file} lost the measured accessible name "${name}"`)
      .toContain(`aria-label="${name}"`)
  })

  it('the stripper still reaches the real markup (a blind scan passes)', () => {
    // #823f: a scan that can no longer see its target reports clean. Prove the
    // stripped source retains a line only the JSX can supply.
    const src = read('pages/ConversationsListPage.tsx')
    expect(src).toContain('<SelectTrigger')
    expect(src).toContain('aria-label="Sort conversations"')
    // ...and prove the stripping actually happened, so the assertion above
    // cannot be satisfied by the comment that explains it.
    expect(src).not.toContain('name-from-content role')
  })
})

describe('#892 — a quote control names the thing it acts on', () => {
  it.each(QUOTE_CONTROLS)('$file names its object', ({ file, object }) => {
    const src = read(file)
    const labels = src.match(/aria-label=\{[^}]*(?:Unquote|Quote)[^}]*\}/g) ?? []
    expect(labels.length, `${file} renders no quote control — re-anchor this scan`)
      .toBeGreaterThan(0)
    for (const label of labels) {
      // The bare verb is what shipped; the object is what makes N of them
      // distinguishable to a reader that meets each row's copy in browse mode.
      expect(label, `${file} has a quote control naming a verb with no object`)
        .toContain(object)
    }
  })

  it('ByTextTable derives the record label ONCE', () => {
    // The Record cell and the control's name must not be able to disagree —
    // the two-derivations shape #824 indicts.
    const src = read('components/ByTextTable.tsx')
    const derivations = src.match(/comment\.row_identifier \|\| comment\.participant_name/g) ?? []
    expect(derivations, 'the record label is derived more than once').toHaveLength(1)
  })
})
