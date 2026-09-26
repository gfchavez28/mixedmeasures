/**
 * detectWorkspace maps a pathname to the TopRail workspace tab that should be
 * highlighted. Standalone project routes (Participants, Memos & Notes) must
 * resolve to 'none' so they do NOT light the Overview tab (#428e).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, it, expect } from 'vitest'
import { detectWorkspace } from './workspace'

describe('detectWorkspace (#428e)', () => {
  it('lights the matching tab for every workspace root', () => {
    expect(detectWorkspace('/projects/1/overview')).toBe('overview')
    expect(detectWorkspace('/projects/1/conversations')).toBe('conversations')
    expect(detectWorkspace('/projects/1/datasets')).toBe('datasets')
    expect(detectWorkspace('/projects/1/documents')).toBe('documents')
    expect(detectWorkspace('/projects/1/observations')).toBe('observations')
    expect(detectWorkspace('/projects/1/analysis')).toBe('analysis')
  })

  it('an observations route does NOT fall through to overview', () => {
    // Nothing else catches a missing branch: `activeWorkspace` is typed `string`,
    // so adding a tab without teaching detectWorkspace compiles fine — and the
    // route would then light (and aria-current) the Overview tab, which is exactly
    // the #428e bug.
    expect(detectWorkspace('/projects/1/observations')).not.toBe('overview')
    expect(detectWorkspace('/projects/1/observations/import')).toBe('observations')
    expect(detectWorkspace('/projects/1/observations/7')).toBe('observations')
  })

  it('keeps the workspace tab lit on nested/child routes', () => {
    expect(detectWorkspace('/projects/1/conversations/9')).toBe('conversations')
    expect(detectWorkspace('/projects/1/datasets/3/recode')).toBe('datasets')
    expect(detectWorkspace('/projects/1/analysis/qualitative')).toBe('analysis')
    expect(detectWorkspace('/projects/1/documents/2')).toBe('documents')
  })

  it('resolves standalone routes to "none" so Overview is not falsely lit', () => {
    expect(detectWorkspace('/projects/1/participants')).toBe('none')
    expect(detectWorkspace('/projects/1/memos-notes')).toBe('none')
    // Both of these lit Overview (and carried its aria-current) until the
    // default flipped — neither had been added to an opt-out list.
    expect(detectWorkspace('/projects/1/coding-import')).toBe('none')
    expect(detectWorkspace('/projects/1/merge')).toBe('none')
  })

  it('🔴 a route nobody has taught it about lights NO tab — the default is none', () => {
    // The property that stops the next standalone page repeating #428e: an
    // unknown route is not claimed by Overview.
    expect(detectWorkspace('/projects/1/some-page-added-next-year')).toBe('none')
    expect(detectWorkspace('/projects/1')).toBe('none')
    // A segment that is an Object.prototype key must not resolve to a builtin.
    expect(detectWorkspace('/projects/1/constructor')).toBe('none')
  })

  it('matches the FIRST segment, not a substring anywhere in the path', () => {
    // `includes('/analysis')` would have matched a route merely containing it.
    expect(detectWorkspace('/projects/1/merge/analysis')).toBe('none')
  })

  it('lights overview only for the actual overview page', () => {
    expect(detectWorkspace('/projects/1/overview')).toBe('overview')
  })
})

/**
 * #10 — the skip link, pinned at the source level.
 *
 * Mounting ProjectLayout would need auth, theme, zoom, a QueryClient and a router
 * before it renders anything, and the property worth protecting is structural, not
 * behavioural-under-state. The realistic regression is someone tidying away
 * `tabIndex={-1}` because it looks redundant — at which point the link still renders,
 * still looks correct in review, and silently stops working: the browser scrolls but
 * focus never leaves the link, so the next Tab returns to rail stop 2.
 *
 * Measured cost this exists to remove: 16 tab stops before the first focusable thing
 * in the page content, on every navigation.
 */
describe('skip link (#10)', () => {
  const SRC = readFileSync(join(__dirname, 'ProjectLayout.tsx'), 'utf8')

  it('renders a skip link as the first focusable element', () => {
    expect(SRC).toMatch(/href="#main-content"/)
    expect(SRC).toMatch(/Skip to main content/)
    // It must precede the rail in DOM order, or it is not the first tab stop.
    expect(SRC.indexOf('href="#main-content"')).toBeLessThan(SRC.indexOf('<TopRail'))
  })

  it('is hidden until focused, then actually visible', () => {
    // An invisible skip link is worse than none: a sighted keyboard user cannot
    // tell where focus went.
    expect(SRC).toMatch(/sr-only focus:not-sr-only/)
  })

  it('the target carries an id AND tabIndex={-1}', () => {
    // Both halves, together. `id` alone gives a scroll with no focus move.
    expect(SRC).toMatch(/<main[^>]*id="main-content"/s)
    expect(SRC).toMatch(/<main[^>]*tabIndex=\{-1\}/s)
  })

  it('uses a real <main> and no ARIA main landmark remains', () => {
    // The div carried role="main" while WritingCanvas ALSO declared role="main"
    // inside this outlet — two nested main landmarks, which ARIA forbids and which
    // leaves a skip target ambiguous.
    expect(SRC).toMatch(/<main\b/)
    expect(SRC).not.toMatch(/role="main"/)
  })
})
