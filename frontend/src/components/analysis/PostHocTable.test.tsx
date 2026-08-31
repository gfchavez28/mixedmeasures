/**
 * #853 — a post-hoc table's `id`/`aria-controls` must not be built from a
 * variable NAME.
 *
 * Lighthouse `aria-valid-attr-value` on the GSS canvas: the toggle emitted
 * `aria-controls="posthoc-Trust scale A (Depends = middle)"`. An `id` containing
 * ASCII whitespace is invalid HTML, and `aria-controls` is an **ID-LIST**
 * attribute — so the value parsed as six separate tokens, none of which
 * resolved. A screen-reader user was told the button controls something and
 * could not reach it. MM labels routinely contain spaces, so this is the
 * ordinary case rather than an edge one.
 *
 * 🔴 **And there was a SECOND dangling-idref in the same component, in its other
 * state.** The entry records `aria-valid-attr-value` fixed twice before — the
 * `rctab-*` idrefs and `ColumnPicker`'s unmounted `TabsContent` — and both were
 * references to elements not in the DOM. The table here renders only while
 * expanded, so the collapsed state pointed at nothing. Fixing the id alone would
 * have left that live, in the state a disclosure spends most of its life in.
 */

import { describe, it, expect, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import PostHocTable from './PostHocTable'

afterEach(cleanup)

/** The shape that broke it: a real MM variable label, with spaces and parens. */
const SPACEY = 'Trust scale A (Depends = middle)'

const comparisons = [
  { group_a: 'Bachelor’s', group_b: 'Graduate', mean_diff: 0.14, p: 0.0001, ci_lower: 0.1, ci_upper: 0.18 },
  { group_a: 'High school', group_b: 'Graduate', mean_diff: -0.44, p: 0.2, ci_lower: -0.48, ci_upper: -0.4 },
]

const sigLevels = { show_05: true, show_01: true, show_001: true }

function renderTable(expanded: boolean) {
  return render(
    <PostHocTable
      comparisons={comparisons}
      variableName={SPACEY}
      sigLevels={sigLevels}
      expanded={expanded}
      onToggle={vi.fn()}
    />,
  )
}

describe('#853 — the controlled id is generated, not derived from the name', () => {
  it('🔴 emits an id with no whitespace, whatever the variable is called', () => {
    renderTable(true)
    const table = document.querySelector('table')
    const id = table?.getAttribute('id') ?? ''

    expect(id).not.toBe('')
    expect(id, 'an id with ASCII whitespace is invalid HTML').not.toMatch(/\s/)
    expect(id, 'the id must not be built from the variable name').not.toContain(SPACEY)
  })

  it('🔴 aria-controls RESOLVES to the table it names', () => {
    // The assertion that would have failed before: the old value parsed as an
    // ID-list of six tokens, none of which matched an element.
    renderTable(true)
    const toggle = screen.getByRole('button', { name: /Tukey HSD post-hoc/ })
    const controls = toggle.getAttribute('aria-controls')

    expect(controls).toBeTruthy()
    for (const token of (controls ?? '').split(/\s+/)) {
      expect(document.getElementById(token), `aria-controls token "${token}" resolves to nothing`)
        .not.toBeNull()
    }
  })

  it('🔴 sets NO aria-controls while collapsed, because the target is unmounted', () => {
    // The third instance of the class this entry's own history records twice.
    // A dangling idref is the same `aria-valid-attr-value` failure by another
    // route, and collapsed is this disclosure's usual state.
    renderTable(false)
    const toggle = screen.getByRole('button', { name: /Tukey HSD post-hoc/ })

    expect(document.querySelector('table')).toBeNull()
    expect(toggle).not.toHaveAttribute('aria-controls')
    // aria-expanded still reports the state — the disclosure is intact.
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  it('two tables on one page do not collide', () => {
    // `useId()` is per-instance; a name-derived id would give two renders of the
    // same variable the SAME id, which is the other half of an invalid idref.
    renderTable(true)
    renderTable(true)
    const ids = Array.from(document.querySelectorAll('table')).map(t => t.id)

    expect(ids).toHaveLength(2)
    expect(new Set(ids).size, 'the two tables share an id').toBe(2)
  })
})
