import { describe, it, expect } from 'vitest'
import {
  withdrawalLocations, describeDeleteConsequence, withdrawalHeadline,
  keptSummary, removedSummary, withdrawalDoneNote, WITHDRAWAL_SCOPE_NOTE,
} from './withdrawal-copy'
import type { WithdrawalReport } from '@/lib/api/participants'

/**
 * #702(2) — the copy that replaces "Speaker links will be removed."
 *
 * The tests below are about MEANING, not wording: the delete confirm has to name
 * the data that SURVIVES, because the previous sentence stated the same fact in
 * a way that reads as completion.
 */

const report = (over: Partial<WithdrawalReport> = {}): WithdrawalReport => ({
  participant_id: 1,
  identifier: 'P001',
  display_name: 'Jane Doe',
  role: 'staff',
  has_demographics: true,
  speaker_names: ['Jane'],
  conversations: [{
    conversation_id: 1, name: 'Interview A',
    segments: 12, code_applications: 4, excerpts: 1, notes: 1,
  }],
  datasets: [{
    dataset_id: 1, name: 'Board Survey',
    rows: 1, responses: 34, code_applications: 2, excerpts: 0,
    notes: 0, memos: 1, row_scores: 3,
  }],
  documents: [],
  total_items: 59,
  ...over,
})

const workplan = (name = 'Workplan 2026', segments = 3) => ({
  document_id: 7, name, segments, code_applications: 2, excerpts: 0, notes: 1,
})

/** Only a document says who this person is — the case #1123 is about. */
const documentOnly = (docs = [workplan()]) => report({
  conversations: [], datasets: [], speaker_names: [], documents: docs, total_items: 7,
})

describe('withdrawalLocations', () => {
  it('says where the data is, per source', () => {
    expect(withdrawalLocations(report())).toEqual([
      'Interview A — 12 turns, 4 codes, 1 quote, 1 note',
      'Board Survey — 34 responses, 2 codes, 1 memo, 3 computed scores',
    ])
  })

  it('omits the zeros rather than printing a row of noughts', () => {
    const line = withdrawalLocations(report({
      conversations: [{
        conversation_id: 1, name: 'Interview A',
        segments: 1, code_applications: 0, excerpts: 0, notes: 0,
      }],
      datasets: [],
    }))
    expect(line).toEqual(['Interview A — 1 turn'])
  })
})

describe('describeDeleteConsequence', () => {
  it('names what SURVIVES, not the link that is removed', () => {
    // The whole finding: "Speaker links will be removed" is true and reads as
    // tidy-up. The data is what the reader needs to hear about.
    const msg = describeDeleteConsequence(report())
    expect(msg).toContain('12 transcript turns')
    expect(msg).toContain('34 survey responses')
    expect(msg).toContain('"Jane"')
    expect(msg).toMatch(/no longer linked to anyone/)
  })

  it('states the inversion — deleting FIRST makes withdrawal harder', () => {
    // The part nobody guesses, and the reason the README paragraph exists.
    expect(describeDeleteConsequence(report())).toMatch(/HARDER to honour/)
  })

  it('does not promise erasure anywhere', () => {
    const msg = describeDeleteConsequence(report())
    expect(msg).not.toMatch(/will be (deleted|erased|removed) permanently|erases their data/i)
  })

  it('is honest about a participant with nothing linked', () => {
    const msg = describeDeleteConsequence(report({
      conversations: [], datasets: [], speaker_names: [], total_items: 1,
    }))
    expect(msg).toMatch(/no linked transcript turns, responses or documents/)
  })

  it('#1123: names the documents about them, which the record delete leaves unlinked', () => {
    // The case the page got wrong: only a document says who this person is, and
    // the confirm said the delete "removes the record only".
    const msg = describeDeleteConsequence(documentOnly())
    expect(msg).toContain('1 document about them remains in the project')
    expect(msg).not.toMatch(/removes the record only\./)
    expect(describeDeleteConsequence(documentOnly([workplan(), workplan('Workplan 2027')])))
      .toContain('2 documents about them remain')
  })

  it('agrees the verb with the list, not with how its one item is spelled', () => {
    // It read "34 survey responses remains" and "the speaker name … remain".
    const only = (over: Partial<WithdrawalReport>) => describeDeleteConsequence(report({
      conversations: [], datasets: [], speaker_names: [], ...over,
    }))
    const survey = (responses: number) => [{
      dataset_id: 1, name: 'S', rows: 1, responses, code_applications: 0, excerpts: 0,
      notes: 0, memos: 0, row_scores: 0,
    }]
    expect(only({ datasets: survey(34) })).toContain('34 survey responses remain in')
    expect(only({ datasets: survey(1) })).toContain('1 survey response remains in')
    expect(only({ speaker_names: ['Jane'] })).toContain('the speaker name "Jane" remains in')
    expect(only({ speaker_names: ['Jane', 'J'] })).toContain('"Jane" / "J" remain in')
    expect(describeDeleteConsequence(report())).toMatch(/"Jane" remain in/)
  })

  it('has a safe form before the report has loaded', () => {
    // The dialog can open before the fetch resolves; silence there would be the
    // old behaviour by accident.
    const msg = describeDeleteConsequence(null)
    expect(msg).toMatch(/remain in the project/)
  })
})

describe('withdrawalHeadline', () => {
  it('counts items and sources, and says the count includes the record itself', () => {
    expect(withdrawalHeadline(report()))
      .toBe('59 items across 2 sources, counting this record, trace back to this participant.')
  })

  it('says so plainly when there is nothing', () => {
    expect(withdrawalHeadline(report({ conversations: [], datasets: [], total_items: 1 })))
      .toBe('Nothing else in this project is linked to this participant.')
  })

  it('#1123: a document about them IS something linked — never "nothing else"', () => {
    expect(withdrawalHeadline(documentOnly()))
      .toBe('7 items across 1 source, counting this record, trace back to this participant.')
  })

  it('#1136: never claims the removal is manual — the withdrawal button does it', () => {
    expect(withdrawalHeadline(report())).not.toMatch(/by hand|manual/)
  })
})

describe('WITHDRAWAL_SCOPE_NOTE (#1136)', () => {
  it('says what the withdrawal does, not that the software cannot do it', () => {
    expect(WITHDRAWAL_SCOPE_NOTE).not.toMatch(/no erase function|manual/)
    expect(WITHDRAWAL_SCOPE_NOTE).toMatch(/blanks their conversation turns/)
    expect(WITHDRAWAL_SCOPE_NOTE).toMatch(/deletes their survey responses and this record/)
    expect(WITHDRAWAL_SCOPE_NOTE).toMatch(/unlinks documents about them/)
  })

  it('keeps the residual the withdrawal cannot reach (`withdrawal_redaction.py` ⛔)', () => {
    expect(WITHDRAWAL_SCOPE_NOTE).toMatch(/cannot find their name in other people’s turns/)
    expect(WITHDRAWAL_SCOPE_NOTE).toMatch(/free-text answers/)
    expect(WITHDRAWAL_SCOPE_NOTE).toMatch(/notes and memos/)
    expect(WITHDRAWAL_SCOPE_NOTE).toMatch(/not compliance advice/)
  })
})

describe('#1123 — the document arm, on every sentence that reads the report', () => {
  it('lists each document with what it holds', () => {
    expect(withdrawalLocations(documentOnly())).toEqual([
      'Workplan 2026 — a document about them, 3 passages, 2 codes, 1 note',
    ])
    // A document with nothing coded in it still says what it is.
    expect(withdrawalLocations(documentOnly([{ ...workplan(), segments: 0, code_applications: 0, notes: 0 }])))
      .toEqual(['Workplan 2026 — a document about them'])
  })

  it('the withdrawal confirm says a document STAYS and has to be read', () => {
    // `apply_withdrawal` unlinks a document and keeps it — "about them" is true of
    // a workplan they wrote and of a policy that names them alike.
    expect(removedSummary(documentOnly()).join(' ')).not.toMatch(/Workplan/)
    expect(keptSummary(documentOnly())).toEqual([
      'The document “Workplan 2026” stays, no longer linked to them — read it yourself: '
      + 'a document about someone can also be their own words',
    ])
    expect(keptSummary(documentOnly([workplan(), workplan('B')]))[0])
      .toMatch(/^2 documents about them stay/)
    expect(keptSummary(report())).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/document/)]))
  })

  it('the note after a withdrawal counts the documents it unlinked', () => {
    expect(withdrawalDoneNote(0)).toBe(
      'Now search your transcripts and free-text answers for their name — that part cannot be automated.')
    expect(withdrawalDoneNote(1)).toMatch(/ 1 document no longer says who it is about — read it too\.$/)
    expect(withdrawalDoneNote(3)).toMatch(/ 3 documents no longer say who they are about — read them too\.$/)
  })
})
