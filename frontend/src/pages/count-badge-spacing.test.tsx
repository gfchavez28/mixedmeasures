/**
 * A count appended to a control's label needs a space the ACCESSIBLE NAME
 * algorithm keeps — and #908's own recorded remedy did not supply one.
 *
 * #908 fixed three list-page badges that announced `"All Datasets1"`, and
 * recorded the rule as *"the leading space is a TEXT node, not margin"*. The
 * shape it shipped was `<span className="ml-1.5">{' '}{n}</span>`, which
 * **still computes `"All Datasets1"`** — measured below. The algorithm trims
 * each text node before joining them, so a space anywhere INSIDE the count
 * span is discarded whether it is typed or written as `{' '}`. Only a space in
 * the BUTTON's own child list survives.
 *
 * Found 2026-09-12 while building the rating sweep's per-code chips, which had
 * copied the recorded shape. All four sites carry the corrected form now.
 *
 * ⚠️ **The mechanism test is the important half.** A source scan can only ban
 * the shapes we happen to know about; the measurement is what makes the RULE
 * checkable, and it is what refuted the recorded one.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { render, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { sourceFiles } from '@/test-support/source-tree'
import { stripComments } from '@/lib/strip-comments'

afterEach(cleanup)

/**
 * Build a button from raw HTML and hand it back for a name assertion.
 *
 * ⚠️ Asserted with `toHaveAccessibleName`, which runs the same computation a
 * reader does. Asserting `textContent` cannot see this defect at all — the two
 * shapes have identical text (pinned below).
 */
function button(innerHtml: string): HTMLElement {
  const { container } = render(
    <div dangerouslySetInnerHTML={{ __html: `<button>${innerHtml}</button>` }} />,
  )
  return container.querySelector('button')!
}

describe('#908 — where the space has to go, measured', () => {
  it('🔴 a space INSIDE the count span is dropped from the name', () => {
    // This is what #908 shipped and what its note describes. In the DOM the
    // space is present; in the NAME it is gone.
    expect(button('All Datasets<span class="ml-1.5"> 1</span>'))
      .toHaveAccessibleName('All Datasets1')
  })

  it('a space in the BUTTON own child list survives', () => {
    expect(button('All Datasets <span class="ml-1.5">1</span>'))
      .toHaveAccessibleName('All Datasets 1')
  })

  it('and the DOM text was never the thing to assert on', () => {
    // The tell: `textContent` is IDENTICAL for the broken and fixed shapes, so
    // a `getByText` assertion cannot tell them apart. The channel the property
    // lives in is the accessible name (#770 rule).
    const broken = button('All Datasets<span> 1</span>')
    const fixed = button('All Datasets <span>1</span>')
    expect(broken.textContent).toBe(fixed.textContent)
    expect(broken).not.toHaveAccessibleName('All Datasets 1')
    expect(fixed).toHaveAccessibleName('All Datasets 1')
  })
})

describe('#908 — no site carries the ineffective shape', () => {
  // The exact form #908 shipped: an expression-space as the FIRST child of the
  // count span. Narrow on purpose — this bans a known-wrong shape rather than
  // trying to judge naming in general, which #888 refuted as a static gate.
  const INEFFECTIVE = /<span[^>]*>\{' '\}\{/

  const files = sourceFiles({ ext: 'tsx', floor: 100 })

  it('the scan reaches real page source', () => {
    // Population self-check: a walk that resolves to nothing passes a
    // "no offenders" assertion by finding nothing (#730).
    expect(files.length).toBeGreaterThan(100)
    const pages = files.filter(f => f.includes('/pages/'))
    expect(pages.length).toBeGreaterThan(10)
  })

  it('the predicate fires on the shape it is written to catch', () => {
    // Falsifier: without this, a regex that had rotted would report clean.
    expect(INEFFECTIVE.test("<span className=\"ml-1.5 opacity-60\">{' '}{datasets.length}</span>"))
      .toBe(true)
    expect(INEFFECTIVE.test("All Datasets{' '}<span className=\"ml-1.5\">{datasets.length}</span>"))
      .toBe(false)
  })

  it('no page uses it', () => {
    const offenders = files.filter(file => {
      // ⚠️ `sourceFiles` yields ABSOLUTE paths — joining them onto SRC_DIR
      // again produced a nested path and an ENOENT that read like a missing
      // file rather than a wrong scan.
      const raw = readFileSync(file, 'utf8')
      // ⚠️ Cheap pre-filter, and it is SOUND rather than an approximation:
      // `stripComments` only ever REMOVES text, so a file whose raw source does
      // not contain the opening `{' '}{` cannot contain it after stripping
      // either. Same offenders, without comment-stripping ~300 files.
      //
      // 🔴 It is here because this test TIMED OUT under load — 2.3s of its 5s
      // default with the machine idle, and over it when a second suite was
      // running, which reads as a defect in whatever was committed last. The
      // cost grows with the file tree, so it would have kept getting worse.
      if (!raw.includes("{' '}{")) return false
      return INEFFECTIVE.test(stripComments(raw, file))
    })
    expect(offenders).toEqual([])
  })
})
