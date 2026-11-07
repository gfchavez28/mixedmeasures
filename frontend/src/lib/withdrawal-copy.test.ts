import { describe, it, expect } from 'vitest'
import {
  withdrawalLocations, describeDeleteConsequence, withdrawalHeadline,
  keptSummary, removedSummary, withdrawalDoneNote, WITHDRAWAL_SCOPE_NOTE,
  WITHDRAWAL_RESIDUAL_NOTE, WITHDRAWAL_BACKUP_RESIDUAL, WITHDRAWAL_RECORD_NOTE,
  unlinkedRecordsNote,
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
    segments: 12, combined_turns: 0, code_applications: 4, excerpts: 1, notes: 1,
  }],
  datasets: [{
    dataset_id: 1, name: 'Board Survey',
    rows: 1, responses: 34, code_applications: 2, excerpts: 0,
    notes: 0, memos: 1, row_scores: 3,
  }],
  documents: [],
  total_items: 59,
  unlinked_records_with_identifier: 0,
  ...over,
})

/** #1320 — their words also in turns reached only by a merge or a split. */
const merged = (combined: number) => report({
  conversations: [{
    conversation_id: 1, name: 'Interview A',
    segments: 12, combined_turns: combined, code_applications: 4, excerpts: 1, notes: 1,
  }],
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
        segments: 1, combined_turns: 0, code_applications: 0, excerpts: 0, notes: 0,
      }],
      datasets: [],
    }))
    expect(line).toEqual(['Interview A — 1 turn'])
  })

  it('#1320: counts the turns their words reached by a merge or a split', () => {
    expect(withdrawalLocations(merged(2))[0])
      .toBe('Interview A — 12 turns, 2 merged or split turns, 4 codes, 1 quote, 1 note')
    expect(withdrawalLocations(merged(1))[0]).toContain('1 merged or split turn,')
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

  it('#1320: a merged or split turn holding their words survives a delete too', () => {
    expect(describeDeleteConsequence(merged(3))).toContain('15 transcript turns')
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

  it('#1320 (D12): says what it does not reach — recordings and every earlier copy', () => {
    expect(WITHDRAWAL_SCOPE_NOTE).toContain(
      'It does not edit recordings, and backups, safety copies and files exported before '
      + 'the withdrawal still hold their data.')
  })
})

describe('#1320 (D12) — the disclosure, as decided', () => {
  it('the confirm names every copy that still holds the data, and recordings', () => {
    // Pinned whole: the developer decided this wording (#1320 D12); #1190 appends the
    // sentence about the withdrawal's own record, pinned on its own below.
    expect(WITHDRAWAL_RESIDUAL_NOTE).toBe(
      'For honouring a withdrawal request. A full backup is taken first. That backup, your '
      + 'earlier backups, the safety copies kept before a merge or overwrite, and any file '
      + 'already exported or shared still hold everything this removes until they are '
      + 'deleted. Automatic and On quit backups are replaced over time; the others stay '
      + 'until you delete them in Settings › Backup & Data. Recordings are not edited — '
      + 'their voice stays in the audio or video. There is no per-person undo: restoring '
      + 'a backup also undoes any work done after it. ' + WITHDRAWAL_RECORD_NOTE)
  })
})

describe('#1190 — what the withdrawal leaves behind on purpose', () => {
  it('says merging, importing and linking do not bring them back, and the hand-add asks', () => {
    expect(WITHDRAWAL_RECORD_NOTE).toBe(
      'Afterwards this project keeps a record of the withdrawal: merging or importing a copy '
      + 'of it, or linking records or speakers to participants, does not bring them back, and '
      + 'adding a participant with their ID asks first. A transcript that names a speaker with '
      + 'their ID, or with a name this project knew them by, does not make them a participant '
      + 'again, and its import says so; a name this project never used for them is not '
      + 'recognised. Project files exported afterwards carry that record. It keeps their ID and '
      + 'those names as one-way codes, which is not anonymisation — anyone who can guess one can '
      + 'confirm it from the code. A withdrawal made in an earlier version of Mixed Measures kept '
      + 'their ID only.')
  })

  it('#1472 (D76): says the NAMES are remembered, what is not caught, and what older withdrawals kept', () => {
    expect(WITHDRAWAL_RECORD_NOTE).toMatch(/a name this project knew them by/)
    expect(WITHDRAWAL_RECORD_NOTE).toMatch(/a name this project never used for them is not recognised/)
    expect(WITHDRAWAL_RECORD_NOTE).toMatch(/earlier version of Mixed Measures kept their ID only/)
    // The next release's number is not decided, so the note names none.
    expect(WITHDRAWAL_RECORD_NOTE).not.toMatch(/\d+\.\d+/)
  })

  it('D9: never calls the kept ID anonymous', () => {
    expect(WITHDRAWAL_RECORD_NOTE).toMatch(/not anonymisation/)
    expect(WITHDRAWAL_RECORD_NOTE).not.toMatch(/\banonymi[sz]ed\b|\banonymous\b/)
  })

  it('never claims the copies made BEFORE are cleaned — the earlier sentence keeps them', () => {
    expect(WITHDRAWAL_RECORD_NOTE).not.toMatch(/every copy|all copies|removed everywhere/)
    expect(WITHDRAWAL_RESIDUAL_NOTE).toMatch(/any file already exported or shared still hold everything/)
  })

  it('D14: counts unlinked records carrying their ID — never deleted, never named', () => {
    expect(unlinkedRecordsNote(report())).toBeNull()
    const one = unlinkedRecordsNote(report({ unlinked_records_with_identifier: 1 }))
    expect(one).toBe('1 dataset record linked to no one carries their ID. It stays — check it '
      + 'yourself: a matching ID does not prove the record is theirs')
    expect(unlinkedRecordsNote(report({ unlinked_records_with_identifier: 3 })))
      .toMatch(/^3 dataset records linked to no one carry their ID\. They stay/)
    // Said where the decision is made: the withdrawal confirm's "kept" list.
    expect(keptSummary(report({ unlinked_records_with_identifier: 3 })))
      .toContain(unlinkedRecordsNote(report({ unlinked_records_with_identifier: 3 })))
    expect(keptSummary(report()).join(' ')).not.toMatch(/linked to no one/)
    // Never the identifier, never the name.
    expect(one).not.toMatch(/P001|Jane/)
  })

  it('the note after a withdrawal ends on the backups, whatever else it says', () => {
    const backups = 'The “Before a withdrawal” backup taken now, and every earlier backup, '
      + 'still hold their data until you delete them in Settings › Backup & Data.'
    expect(WITHDRAWAL_BACKUP_RESIDUAL).toBe(backups)
    for (const docs of [0, 1, 3]) expect(withdrawalDoneNote(docs).endsWith(backups)).toBe(true)
  })
})

describe('#1320 (D7) — a merged or split turn holding their words', () => {
  it('the confirm says it is blanked whole, the other speaker’s words in it included', () => {
    expect(removedSummary(merged(1))).toContain(
      'All the words of 1 merged or split turn holding theirs, including anything others said in it')
    expect(removedSummary(merged(4))).toContain(
      'All the words of 4 merged or split turns holding theirs, including anything others said in them')
    expect(removedSummary(report()).join(' ')).not.toMatch(/merged or split/)
  })

  it('and that the other speaker loses nothing: Unmerge brings their own turn back', () => {
    expect(keptSummary(merged(2)).join(' | ')).toMatch(
      /What others said in a merged turn is still in their own turn from before the merge — Unmerge brings it back/)
    expect(keptSummary(report()).join(' | ')).not.toMatch(/Unmerge/)
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
      'Now search your transcripts and free-text answers for their name — that part cannot be automated. '
      + WITHDRAWAL_BACKUP_RESIDUAL)
    expect(withdrawalDoneNote(1)).toContain(' 1 document no longer says who it is about — read it too. ')
    expect(withdrawalDoneNote(3)).toContain(' 3 documents no longer say who they are about — read them too. ')
    expect(withdrawalDoneNote(0)).not.toMatch(/document/)
  })
})
