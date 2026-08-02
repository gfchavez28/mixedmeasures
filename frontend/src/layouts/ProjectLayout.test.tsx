/**
 * detectWorkspace maps a pathname to the TopRail workspace tab that should be
 * highlighted. Standalone project routes (Participants, Memos & Notes) must
 * resolve to 'none' so they do NOT light the Overview tab (#428e).
 */

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
  })

  it('falls back to overview only for the actual overview page', () => {
    expect(detectWorkspace('/projects/1/overview')).toBe('overview')
  })
})
