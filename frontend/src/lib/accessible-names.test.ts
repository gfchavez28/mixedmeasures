import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { stripComments } from './strip-comments'
import { join } from 'node:path'

/**
 * #8 — controls and tables must carry an accessible name.
 *
 * Two fail-closed source scans. They exist because the defect is a *reflex*
 * repeated across dozens of files, which is the shape a per-component test cannot
 * see: 28 popovers announced as unnamed dialogs and 20 of 42 result tables had no
 * caption, and nothing in the suite noticed.
 *
 * ## What this scan deliberately does NOT cover, and why
 *
 * The issue also reported ~17 unlabelled hidden file inputs. **That was a false
 * finding**, and it is worth recording so nobody "fixes" it later. Every one carries
 * Tailwind's `hidden` class (`display: none`), which removes an element from the
 * accessibility tree entirely — verified in a real browser: the inputs are absent
 * from the a11y tree, are not focusable, and each is driven by a real `<Button>`
 * beside it (`button "Select Files"` / `button "Select recording"` appear in the
 * tree; the inputs do not). The finding came from a jsdom sweep, and jsdom computes
 * no layout, so `display: none` elements still enumerate there.
 *
 * Adding `aria-hidden` to them would be a no-op that *looked* like a fix.
 */

const SRC = join(__dirname, '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry)) out.push(p)
  }
  return out
}

/**
 * The scanned population, proven non-trivial before it is used (#730).
 *
 * Both scans below assert an EMPTY offender list, which a walk that found
 * nothing satisfies just as well. `readdirSync` throws on a missing path, so
 * the risk here is not a blind walk but a VALID-but-narrower one — moving this
 * file changes what `join(__dirname, '..')` resolves to, and the scan would go
 * quietly green over a subtree.
 *
 * The floor detects that; it is NOT a growth pin. 237 `.tsx` files today —
 * `.tsx` only, and deliberately: this guard matches JSX elements, which
 * TypeScript permits only in `.tsx`.
 */
function scannedFiles(): string[] {
  const files = walk(SRC)
  expect(
    files.length,
    `the scan walked ${files.length} files under ${SRC} — far fewer than expected, `
      + 'so it is reading the wrong subtree and both assertions here would pass '
      + 'vacuously. Fix the root; do NOT lower this floor.',
  ).toBeGreaterThan(150)
  return files
}

/** The opening tag starting at `from`, respecting nested braces in JSX expressions. */
function openingTag(src: string, from: number): string {
  let depth = 0
  for (let i = from; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === '>' && depth === 0) return src.slice(from, i + 1)
  }
  return src.slice(from, from + 400)
}

/**
 * Blank out comments, preserving offsets so reported line numbers stay true.
 *
 * ⚠️ **#772's rule, reached here a second time.** These scans read raw source,
 * so any `<table>` or `<PopoverContent>` written in PROSE is matched as markup.
 * That is not hypothetical: `VariablePropertiesGrid.tsx` documents where
 * `role="grid"` belongs by naming `<table>` in its docstring, and this guard
 * reported that DOCSTRING as an unnamed table while the real element three
 * screens below carried `aria-label` all along. A phantom points at a real file
 * and a real line and looks exactly like the defect.
 *
 * Replacing with spaces rather than deleting keeps `src.slice(0, index)`
 * line-counting honest.
 */
function named(tag: string, body: string): boolean {
  return /aria-label[=\s]/.test(tag) || /aria-labelledby[=\s]/.test(tag) || /<caption/.test(body)
}

describe('accessible names (#8)', () => {
  // ⚠️ Explicit timeout (#841): this strips the whole source tree, and since
  // #838 that means parsing all ~655 files with the TypeScript compiler —
  // ~1.8 s cold, 3.4 s under full-suite contention, past vitest's 5 s default.
  // The budget matches `strip-comments.test.ts`, which pays the same cost.
  // The SECOND scan below is ~20 ms: `stripComments` caches on source text, and
  // that cache is per-FILE (vitest runs each test file in its own process), so
  // the first test in each file pays and the rest are free.
  it('every PopoverContent has a name', { timeout: 60_000 }, () => {
    // Radix renders PopoverContent as role="dialog" (verified in the installed
    // package). A dialog with no accessible name announces as an unnamed dialog:
    // the user is told they entered something, but not what.
    const offenders: string[] = []
    for (const file of scannedFiles()) {
      const src = stripComments(readFileSync(file, 'utf8'), file)
      for (const m of src.matchAll(/<PopoverContent\b/g)) {
        const tag = openingTag(src, m.index!)
        if (!named(tag, '')) {
          offenders.push(`${file.replace(SRC + '/', '')}:${src.slice(0, m.index).split('\n').length}`)
        }
      }
    }
    expect(
      offenders,
      'PopoverContent renders role="dialog"; without aria-label (or aria-labelledby ' +
        'pointing at a heading it already renders) it announces as an unnamed dialog. ' +
        'Name it after what it contains.',
    ).toEqual([])
  })

  it('every result table has a caption or a name', () => {
    // A table announced with no name forces the user to infer what they landed in
    // from the first cell — poor for any app, worse for one whose output IS tables.
    // <caption className="sr-only"> is the house pattern. NOTE: sr-only belongs on
    // the CAPTION, never on the <table> itself — Firefox does not clip a
    // display:table element, which is how a caption once escaped and rendered
    // full-width over a page heading.
    const offenders: string[] = []
    for (const file of scannedFiles()) {
      const src = stripComments(readFileSync(file, 'utf8'), file)
      for (const m of src.matchAll(/<table\b/g)) {
        const tag = openingTag(src, m.index!)
        const close = src.indexOf('</table>', m.index!)
        const body = close > 0 ? src.slice(m.index!, close) : ''
        if (!named(tag, body)) {
          offenders.push(`${file.replace(SRC + '/', '')}:${src.slice(0, m.index).split('\n').length}`)
        }
      }
    }
    expect(
      offenders,
      'Give the table a <caption className="sr-only"> describing what it shows. If ' +
        'the element is self-closing (a virtualised Table component taking {...props}) ' +
        'it cannot take a caption child — use aria-label instead.',
    ).toEqual([])
  })

  it('both scans can actually fail', () => {
    // A scan that cannot fail is not a guard. Pin the matcher and the brace-aware
    // tag reader — the naive "first >" version broke on `selectedValueIds.length > 0`
    // inside a JSX expression, which is exactly how a real table got mis-edited.
    expect(named('<PopoverContent className="w-64">', '')).toBe(false)
    expect(named('<PopoverContent aria-label="Code color">', '')).toBe(true)
    expect(named('<table>', '<table><caption>x</caption>')).toBe(true)
    expect(named('<table>', '<table><thead>')).toBe(false)

    const tricky = '<table\n  aria-activedescendant={a.length > 0 ? "x" : undefined}\n  aria-label="T"\n/>'
    expect(openingTag(tricky, 0)).toContain('aria-label="T"')

    // #772: prose is not markup. A docstring naming `<table>` must not be
    // scanned, and stripping must PRESERVE offsets so the line numbers this
    // guard reports stay true.
    const prose = '/** where `<table>` belongs */\nconst x = 1\n// see <PopoverContent>\n'
    expect(stripComments(prose)).not.toContain('<table>')
    expect(stripComments(prose)).not.toContain('<PopoverContent>')
    expect(stripComments(prose)).toHaveLength(prose.length)
    expect(stripComments(prose).split('\n')).toHaveLength(prose.split('\n').length)
    // ...and real markup still survives.
    expect(stripComments('<table aria-label="T">')).toContain('<table aria-label="T">')
  })
})
