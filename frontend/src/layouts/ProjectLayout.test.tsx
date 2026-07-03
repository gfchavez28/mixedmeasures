/**
 * detectWorkspace maps a pathname to the TopRail workspace tab that should be
 * highlighted. Standalone project routes (Participants, Memos & Notes) must
 * resolve to 'none' so they do NOT light the Overview tab (#428e).
 */

import { describe, it, expect } from 'vitest'
import { detectWorkspace } from './workspace'

describe('detectWorkspace (#428e)', () => {
  it('lights the matching tab for the five workspace roots', () => {
    expect(detectWorkspace('/projects/1/overview')).toBe('overview')
    expect(detectWorkspace('/projects/1/conversations')).toBe('conversations')
    expect(detectWorkspace('/projects/1/datasets')).toBe('datasets')
    expect(detectWorkspace('/projects/1/documents')).toBe('documents')
    expect(detectWorkspace('/projects/1/analysis')).toBe('analysis')
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
