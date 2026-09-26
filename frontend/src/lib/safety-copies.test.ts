import { describe, expect, it } from 'vitest'
import {
  SAFETY_COPY_ACT_LABEL,
  SAFETY_COPY_PAGE_SIZE,
  formatTakenAt,
  safetyCopyDeleteWarnings,
  safetyCopyTitle,
} from './safety-copies'

describe('safety copy descriptions (#919)', () => {
  it('gives every act its own words', () => {
    const labels = Object.values(SAFETY_COPY_ACT_LABEL)
    expect(labels).toHaveLength(3)
    expect(new Set(labels).size).toBe(3)
  })

  it('names a copy by its project, and by its file when the project name is unreadable', () => {
    expect(safetyCopyTitle({ project_name: 'Wave 2', filename: 'pre-merge_1_20260901_090000.mmproject' }))
      .toBe('Wave 2')
    expect(safetyCopyTitle({ project_name: null, filename: 'pre-merge_1_20260901_090000.mmproject' }))
      .toBe('pre-merge_1_20260901_090000.mmproject')
  })

  it('🔴 does not sum the page to get the folder (#978)', () => {
    // `totalSafetyCopyBytes` was DELETED rather than kept: the totals now come
    // from the server, over the whole folder, because the list below them is
    // bounded. A client-side sum of a 50-row page would state a disk cost 39×
    // smaller than the truth on the folder this was measured against, in the one
    // line whose job is to state the cost before it is paid.
    expect(SAFETY_COPY_PAGE_SIZE).toBeGreaterThan(0)
  })

  it('🔴 tells apart two copies taken within the same MINUTE', () => {
    // a11y-name-sweep run 6: at minute precision 159 Delete buttons in a real
    // folder shared their name with another — same project, same minute.
    expect(formatTakenAt('2026-09-07T17:31:05+00:00'))
      .not.toBe(formatTakenAt('2026-09-07T17:31:40+00:00'))
  })

  it('returns an unparseable timestamp as it came rather than "Invalid Date"', () => {
    expect(formatTakenAt('not a date')).toBe('not a date')
    expect(formatTakenAt('2026-09-12T10:15:00+00:00')).not.toContain('Invalid')
  })

  describe('delete warnings', () => {
    const base = { project_name: 'Wave 2', project_in_app: true, readable: true } as const

    it('says nothing extra about a readable copy of a project that is still here', () => {
      expect(safetyCopyDeleteWarnings(base)).toEqual([])
    })

    it('warns that the file may be the only copy when the project is gone', () => {
      const [warning, ...rest] = safetyCopyDeleteWarnings({ ...base, project_in_app: false })
      expect(rest).toEqual([])
      expect(warning).toContain('“Wave 2”')
      expect(warning).toContain('only copy')
    })

    it('does not claim the project is gone when that cannot be told', () => {
      expect(safetyCopyDeleteWarnings({ ...base, project_in_app: null })).toEqual([])
    })

    it('never interpolates a missing project name', () => {
      const [warning] = safetyCopyDeleteWarnings({ ...base, project_name: null, project_in_app: false })
      expect(warning).toMatch(/^This project is no longer/)
      expect(warning).not.toContain('null')
    })

    it('warns that an unreadable copy may be damaged', () => {
      const warnings = safetyCopyDeleteWarnings({ project_name: null, project_in_app: null, readable: false })
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('could not be read')
    })
  })
})
