/**
 * Per-fix pins for the a11y-name-sweep's FIFTH run (2026-09-08; #907–#913).
 *
 * Each block pins the MECHANISM of one fix at its site, in the source. These
 * are not gates for the naming class — #888 refuted that (a name arrives four
 * ways, and a scan needs an exemption per legitimate site). They exist so the
 * specific line that was measured wrong in Chrome's tree cannot quietly revert
 * to its old shape; the announcement itself was re-measured in the browser and
 * is recorded in the skill's §9.
 *
 * Every read goes through `stripComments` (#772): each fix carries an
 * explanatory comment that NAMES the old pattern, and a naive scan would report
 * its own explanation as the defect.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '@/lib/strip-comments'

const SRC = join(__dirname, '..')
const source = (rel: string) => stripComments(readFileSync(join(SRC, rel), 'utf8'))

describe('#907 — the participant-table button keeps its visible label as its name', () => {
  it('carries the explanation as a title, never an aria-label', () => {
    const src = source('pages/DatasetsListPage.tsx')
    // The button is the one whose text switches between the two visible labels.
    const start = src.indexOf("? 'Participant table' : 'Add participant table'")
    expect(start).toBeGreaterThan(0)
    const button = src.slice(src.lastIndexOf('<button', start), start)
    expect(button).toMatch(/title=\{/)
    expect(button).not.toMatch(/aria-label=/)
  })
})

describe('#908 — a count badge is separated from its label by a TEXT space', () => {
  it.each([
    ['pages/DatasetsListPage.tsx', 'datasets.length'],
    ['pages/ConversationsListPage.tsx', 'conversations.length'],
    ['pages/DocumentsListPage.tsx', 'documents.length'],
  ])('%s', (rel, expr) => {
    const src = source(rel)
    // The old shape: `<span className="ml-1.5 opacity-60">{n}</span>` — margin
    // is not a space, so the name computed to "All Datasets1".
    expect(src).not.toMatch(new RegExp(`opacity-60">\\{${expr.replace('.', '\\.')}\\}`))
    expect(src).toMatch(new RegExp(`opacity-60">\\{' '\\}\\{${expr.replace('.', '\\.')}\\}`))
  })
})

describe('#909 — the grid caption pluralises', () => {
  // 🔴 **REWRITTEN 2026-09-11 (#939), and the rewrite is the lesson.** This case
  // asserted the exact TERNARY the #909 fix happened to use, so it failed the
  // moment the caption was routed through `lib/format.ts::countLabel` — a change
  // that makes the property MORE true. A guard that names one implementation
  // costs a false failure every time the code improves; pin the property.
  it('does not print "1 columns" or "1 records"', () => {
    const src = source('pages/DatasetView.tsx')
    const caption = src.slice(src.indexOf('<caption'), src.indexOf('</caption>'))
    // Population self-check: the slice really is the caption.
    expect(caption).toContain('dataset.name')
    // Every count in it is rendered by the shared helper...
    expect(caption).toMatch(/countLabel\(columns\.length, 'column', 'columns'\)/)
    expect(caption).toMatch(/countLabel\(totalRows, 'record', 'records'\)/)
    // ...and none of them appends a hard-coded plural.
    expect(caption).not.toMatch(/\}\s*(columns|records)\b/)
  })
})

describe('#910 — the collapsed Memos/Notes pane is inert, not merely aria-hidden', () => {
  it('pairs every aria-hidden pane with an inert of the same condition', () => {
    const src = source('pages/MemosNotesPage.tsx')
    const hidden = [...src.matchAll(/aria-hidden=\{view === '(\w+)'\}/g)].map(m => m[1])
    const inert = [...src.matchAll(/inert=\{view === '(\w+)'\}/g)].map(m => m[1])
    // Population self-check: both panes, then identical conditions.
    expect(hidden.sort()).toEqual(['memos', 'notes'])
    expect(inert.sort()).toEqual(hidden)
  })
})

// #911 — MOVED 2026-09-09 to `components/dialog-describedby.test.ts`, which
// asserts the same property over EVERY dialog instead of the one that was
// measured. Re-scanned per instance, nine were dangling in seven files; this
// per-file pin would have gone on passing through all of them. Deleted rather
// than kept beside the population form: a guard the wider one subsumes is
// redundancy that drifts, and the codebase has paid for that four times
// (#771/#785).

describe('#913 — the merge confirm step names each coder-mapping combobox', () => {
  it('names the trigger from the FILE coder, the stable row identity', () => {
    const src = source('pages/MergeProject.tsx')
    // `combobox` is not a name-from-content role (run 3's rule), so the visible
    // value can never name it; the row's `c.username` is what the row header shows.
    expect(src).toMatch(/<SelectTrigger className="w-full max-w-xs" aria-label=\{`Bring in \$\{c\.username\} as`\}/)
  })
})
