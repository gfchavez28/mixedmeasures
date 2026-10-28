/**
 * #1190 — the Merge report's rows: each conditional row appears exactly when its count
 * is not zero, and a withdrawn person is counted, never named.
 *
 * The positive control is the point of the zero cases: a rule that hid the row always
 * would pass every "absent at zero" assertion.
 */
import { describe, it, expect } from 'vitest'
import type { MergeReport } from '@/lib/api'
import { mergeReportRows, mergeReportNotes } from './merge-report-rows'

const base: MergeReport = {
  sources_matched: 3, applications_added: 12, duplicates_skipped: 1,
  coders_created: 1, coders_matched: 1, codes_collapsed: 0, codes_linked: 0, codes_created: 2,
}
const labels = (r: MergeReport) => mergeReportRows(r).map(([l]) => l)
const count = (r: MergeReport, label: string) => mergeReportRows(r).find(([l]) => l === label)?.[1]

const WITHDRAWN = 'Participants who withdrew, left out'
const THEIRS = 'Their records, speakers, quotes and notes, left out'
const UNLINKED = 'Records added without a participant link'

describe('mergeReportRows', () => {
  it('always shows the eight standing rows, zeros included', () => {
    expect(labels(base)).toEqual([
      'Codings added', 'Duplicate codings skipped', 'Shared sources matched', 'Coders matched',
      'New coders added', 'Codes added', 'Codes linked', 'Codes folded in',
    ])
    expect(count(base, 'Codes linked')).toBe(0)
  })

  it.each([
    ['withdrawn_participants_skipped', WITHDRAWN],
    ['withdrawn_items_skipped', THEIRS],
    ['records_reinserted_unlinked', UNLINKED],
    ['magnitude_conflicts', 'Rating differences flagged for reconciliation'],
    ['ratings_out_of_range', 'Ratings outside a code’s scale, kept as differences'],
  ] as const)('%s: shown with its count when not zero, absent at zero and when absent', (field, label) => {
    expect(count({ ...base, [field]: 4 }, label)).toBe(4)
    expect(count({ ...base, [field]: 1 }, label)).toBe(1)
    expect(labels({ ...base, [field]: 0 })).not.toContain(label)
    expect(labels(base)).not.toContain(label) // a server that predates the field
  })

  it('a withdrawal never puts a name in the report', () => {
    const rows = mergeReportRows({ ...base, withdrawn_participants_skipped: 2, withdrawn_items_skipped: 9 })
    for (const [label, n] of rows) {
      expect(typeof n).toBe('number')
      expect(label).not.toMatch(/P0|Maria/)
    }
  })
})

describe('mergeReportNotes', () => {
  it('says nothing when neither #1190 outcome happened', () => {
    expect(mergeReportNotes(base)).toEqual([])
    expect(mergeReportNotes({ ...base, withdrawn_participants_skipped: 0, records_reinserted_unlinked: 0 })).toEqual([])
  })

  it('D13: says WHY a record came back unlinked, and what to do if it was deleted on purpose', () => {
    expect(mergeReportNotes({ ...base, records_reinserted_unlinked: 1 })).toEqual([
      '1 record from the file is not in this project, and its participant is now linked to '
      + 'another record of the same dataset, so it was added without a link. If you deleted it '
      + 'on purpose, delete it again in that dataset.',
    ])
    expect(mergeReportNotes({ ...base, records_reinserted_unlinked: 3 })[0]).toMatch(
      /^3 records from the file are not in this project, and their participants are now linked .* so they were added without a link\. If you deleted them on purpose, delete them again/)
  })

  it('a withdrawal: counted, and nothing of theirs came back', () => {
    expect(mergeReportNotes({ ...base, withdrawn_participants_skipped: 2 })).toEqual([
      'The file held 2 participants who withdrew from this project; nothing of theirs was brought back.',
    ])
    expect(mergeReportNotes({ ...base, withdrawn_participants_skipped: 1 })[0]).toMatch(/^The file held 1 participant who/)
  })
})
