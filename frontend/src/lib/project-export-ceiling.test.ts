/**
 * #974 — the share-ceiling disclosure's one derivation.
 *
 * Two surfaces read this (the Overview line and the export dialog), so the
 * threshold and the wording are tested here rather than at either of them: a
 * copy in each is how one screen comes to call a project "nearing the limit"
 * while the other calls it fine.
 */

import { describe, it, expect } from 'vitest'

import {
  ceilingLevel,
  describeCeiling,
  hasCeilingToReport,
} from './project-export-ceiling'
import type { ProjectExportCeiling } from './api'

const LIMIT = 4_000_000

function ceiling(dataset_values: number, warn_fraction = 0.8): ProjectExportCeiling {
  return { dataset_values, limit: LIMIT, warn_fraction }
}

describe('hasCeilingToReport', () => {
  it('reports a project that holds dataset values', () => {
    expect(hasCeilingToReport(ceiling(1))).toBe(true)
  })

  it('says nothing about a project with no dataset values', () => {
    // "0 of 4,000,000" on every qualitative-only project is noise, and such a
    // project is not near a limit on dataset values.
    expect(hasCeilingToReport(ceiling(0))).toBe(false)
  })

  it('says nothing before the payload has arrived', () => {
    expect(hasCeilingToReport(undefined)).toBe(false)
  })

  it('says nothing when the server sent no limit', () => {
    // A zero limit would make the percentage Infinity and paint every project
    // as over. Defaults on the response model make this reachable.
    expect(hasCeilingToReport({ dataset_values: 10, limit: 0, warn_fraction: 0.8 })).toBe(false)
  })
})

describe('ceilingLevel', () => {
  it('is fine well below the threshold', () => {
    expect(ceilingLevel(ceiling(1_000_000))).toBe('fine')
  })

  it('crosses to nearing exactly AT the threshold, not after it', () => {
    expect(ceilingLevel(ceiling(LIMIT * 0.8 - 1))).toBe('fine')
    expect(ceilingLevel(ceiling(LIMIT * 0.8))).toBe('nearing')
  })

  it('is still only nearing AT the limit, because the limit itself is allowed', () => {
    // `project_export_size_error` returns None when n_values <= the limit, so a
    // project exactly at it can still be shared. Calling that "over" would be
    // the disclosure contradicting the gate by one value.
    expect(ceilingLevel(ceiling(LIMIT))).toBe('nearing')
    expect(ceilingLevel(ceiling(LIMIT + 1))).toBe('over')
  })

  it('takes the threshold from the SERVER, not from a constant here', () => {
    // The same count reads differently under a different server threshold —
    // which is the proof the client is not carrying its own copy.
    expect(ceilingLevel(ceiling(2_000_000, 0.8))).toBe('fine')
    expect(ceilingLevel(ceiling(2_000_000, 0.5))).toBe('nearing')
  })
})

describe('describeCeiling', () => {
  it('states the figure, the limit and the percentage', () => {
    const { figure } = describeCeiling(ceiling(3_633_552))
    expect(figure).toBe('3,633,552 of 4,000,000 values (90%)')
  })

  it('never reads "(0%)" for a project that holds values', () => {
    // Found by driving, not by reasoning: a real 1,646-value project rendered
    // "1,646 of 4,000,000 values (0%)", where the zero reads as a broken
    // computation rather than a small project.
    expect(describeCeiling(ceiling(1_646)).figure).toBe(
      '1,646 of 4,000,000 values (<1%)',
    )
  })

  it('FLOORS the percentage so 99.99% never reads as 100%', () => {
    // At one value under the limit the project can still be shared; a rounded
    // "100%" beside it makes the refusal's own boundary look already crossed.
    expect(describeCeiling(ceiling(LIMIT - 1)).figure).toContain('(99%)')
  })

  it('says nothing about consequences while the project is fine', () => {
    const { level, consequence } = describeCeiling(ceiling(100))
    expect(level).toBe('fine')
    expect(consequence).toBe('')
  })

  it('names all three things that stop, because they are not guessable', () => {
    // A researcher cannot infer from "too large" that accepting a colleague's
    // merge is what breaks — the safety snapshot it needs is invisible.
    for (const values of [LIMIT * 0.9, LIMIT + 1]) {
      const { consequence } = describeCeiling(ceiling(values))
      expect(consequence).toContain('sharing a copy')
      expect(consequence).toContain('Duplicate')
      expect(consequence).toContain('merging')
    }
  })

  it('tells an over-limit project what actually brings it under', () => {
    const { consequence } = describeCeiling(ceiling(LIMIT + 1))
    expect(consequence).toContain('fewer records or variables')
    // And never advises the thing that cannot work: media is not counted by
    // this limit, so excluding recordings changes nothing (the same trap
    // `project_export_size_error` documents for its own message).
    expect(consequence).not.toContain('media')
    expect(consequence).not.toContain('recordings')
  })

  it('distinguishes nearing from over in the words, not only the level', () => {
    expect(describeCeiling(ceiling(LIMIT * 0.9)).consequence).toContain('nearing')
    expect(describeCeiling(ceiling(LIMIT + 1)).consequence).toContain('blocked')
  })
})
