/**
 * #1190 — Link by column's sentences, for records whose ID belongs to a participant who
 * WITHDREW (`ParticipantLinkReport.skipped_withdrawn`): the server never links them and
 * never creates a participant for them, and every sentence that counts what stays
 * unlinked must count them too — or "every record is already linked" is said of
 * records that are not.
 */
import { describe, it, expect } from 'vitest'
import type { ParticipantLinkReport } from '@/lib/api'
import {
  linkNothingToDoSentence, linkPreviewDetails, linkPreviewSentence, skippedWithdrawn,
  withdrawnLinkSentence,
} from './link-by-column-copy'

const plan = (over: Partial<ParticipantLinkReport> = {}): ParticipantLinkReport => ({
  linked: 0, created: 0, matched: 0, skipped_missing: 0, skipped_duplicate: 0,
  skipped_conflict: 0, already_linked: 0, skipped_withdrawn: 0, duplicate_values: [], ...over,
})

describe('#1190 — a withdrawn person’s ID', () => {
  it('a server that predates the field reads as none', () => {
    const old = plan()
    delete old.skipped_withdrawn
    expect(skippedWithdrawn(old)).toBe(0)
    expect(linkNothingToDoSentence(old)).toBe('Every record is already linked to a participant — there is nothing to link.')
  })

  it('is a reason a record stays unlinked, counted and never named', () => {
    const p = plan({ linked: 4, matched: 4, skipped_missing: 1, skipped_withdrawn: 2 })
    expect(linkPreviewDetails(p)).toEqual([
      '3 records will stay unlinked: 1 with a blank or N/A ID; '
      + '2 with the ID of a participant who withdrew from this project (no participant is created for them).',
    ])
    expect(linkPreviewDetails(plan({ linked: 1, matched: 1, skipped_withdrawn: 1 }))[0])
      .toBe('1 record will stay unlinked: 1 with the ID of a participant who withdrew from this project (no participant is created for it).')
    // POSITIVE CONTROL for the zero case: no reason, no sentence.
    expect(linkPreviewDetails(plan({ linked: 4, matched: 4 }))).toEqual([])
  })

  it('only withdrawn IDs left: "nothing to link" must not say every record is linked', () => {
    expect(linkNothingToDoSentence(plan({ skipped_withdrawn: 2 }))).toBe(
      'No record can be linked: 2 records have a blank, duplicated or already-linked ID, '
      + 'or the ID of a participant who withdrew.')
    expect(linkNothingToDoSentence(plan({ skipped_missing: 1 }))).toBe(
      'No record can be linked: 1 record has a blank, duplicated or already-linked ID.')
  })

  it('the main sentence counts only what links (the server already left them out)', () => {
    expect(linkPreviewSentence(plan({ linked: 2, created: 2, skipped_withdrawn: 5 }), 'ID'))
      .toBe('This will create 2 new participants from the IDs in “ID” and link each record to one.')
  })

  it('the past-tense sentence after a link', () => {
    expect(withdrawnLinkSentence(1)).toBe(
      '1 record carries the ID of a participant who withdrew from this project, so it was not '
      + 'linked and no participant was created.')
    expect(withdrawnLinkSentence(3)).toMatch(/^3 records carry the ID .* so they were not linked/)
  })
})
