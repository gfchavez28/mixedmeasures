/**
 * #1190 (D15) — what the Merge page's Review step says the merge will also add.
 *
 * The names are what let a researcher recognise something they deleted coming back
 * (a plain delete leaves no trace until 1.5.9); the server caps each list and sends
 * the total beside it, so "and N more" must come from the TOTAL, never the list.
 */
import { describe, it, expect } from 'vitest'
import type { MergeAdditions } from '@/lib/api/project-portability'
import { mergeAdditionsLines, MERGE_ADDITIONS_LEAD } from './merge-additions'

const none: MergeAdditions = {
  sources: [], source_count: 0, participants: [], participant_count: 0,
  datasets: [], dataset_count: 0, records: [], record_count: 0,
  quotes: 0, notes: 0, memos: 0, withdrawn_participants: 0, withdrawn_items: 0,
  withdrawn_here: [],
}

describe('mergeAdditionsLines', () => {
  it('nothing to add: no lead and no lines (the step says so in its own words)', () => {
    expect(mergeAdditionsLines(none)).toEqual({ lead: null, lines: [], withdrawn: null })
  })

  it('names sources, participants and datasets, and counts records and annotations', () => {
    const copy = mergeAdditionsLines({
      ...none,
      sources: [{ kind: 'conversation', name: 'Interview 4' }, { kind: 'document', name: 'Policy' }],
      source_count: 2,
      participants: ['P08'], participant_count: 1,
      datasets: [{ name: 'Wave 2', records: 40 }], dataset_count: 1,
      records: [{ dataset: 'Wave 1', count: 12 }, { dataset: 'Exit survey', count: 1 }], record_count: 13,
      quotes: 5, notes: 1, memos: 2,
    })
    expect(copy.lead).toBe(MERGE_ADDITIONS_LEAD)
    expect(copy.lines).toEqual([
      '2 sources: Interview 4, Policy',
      '1 participant: P08',
      '1 dataset: Wave 2 (40 records)',
      '13 records in datasets this project has: Wave 1 (12), Exit survey (1)',
      '5 quotes, 1 note and 2 memos',
    ])
    expect(copy.withdrawn).toBeNull()
  })

  it('a capped list says how many more, from the server’s total', () => {
    const copy = mergeAdditionsLines({
      ...none, participants: ['P01', 'P02'], participant_count: 250,
      sources: [{ kind: 'observation', name: 'Clinic visit' }], source_count: 1,
    })
    expect(copy.lines).toContain('250 participants: P01, P02, and 248 more')
    expect(copy.lines).toContain('1 source: Clinic visit')
  })

  it('one annotation kind alone is a plain count', () => {
    expect(mergeAdditionsLines({ ...none, memos: 1 }).lines).toEqual(['1 memo'])
    expect(mergeAdditionsLines({ ...none, quotes: 2, notes: 3 }).lines).toEqual(['2 quotes and 3 notes'])
  })

  it('🔴 a withdrawn person is COUNTED as left out, never named — and alone is not an addition', () => {
    const copy = mergeAdditionsLines({ ...none, withdrawn_participants: 1, withdrawn_items: 6 })
    expect(copy.withdrawn).toBe(
      'The file holds 1 participant who withdrew from this project, and 6 items of theirs. '
      + 'The merge leaves them out.')
    expect(copy.lead).toBeNull()
    expect(copy.lines).toEqual([])
    expect(mergeAdditionsLines({ ...none, withdrawn_participants: 2 }).withdrawn)
      .toBe('The file holds 2 participants who withdrew from this project. The merge leaves them out.')
    expect(mergeAdditionsLines({ ...none, withdrawn_items: 3 }).withdrawn)
      .toBe('The file holds 3 items of someone who withdrew from this project. The merge leaves them out.')
  })
})
