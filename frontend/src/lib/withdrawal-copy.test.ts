import { describe, it, expect } from 'vitest'
import {
  withdrawalLocations, describeDeleteConsequence, withdrawalHeadline,
  keptSummary, removedSummary, withdrawalDoneNote, WITHDRAWAL_SCOPE_NOTE,
  WITHDRAWAL_RESIDUAL_NOTE, WITHDRAWAL_BACKUP_RESIDUAL, WITHDRAWAL_RECORD_NOTE,
  unlinkedRecordsNote, unplacedCanvasQuotesNote, otherProjectsNote, preUpdateCopiesNote,
} from './withdrawal-copy'
import type { WithdrawalOutcome, WithdrawalReport } from '@/lib/api/participants'

/** What the done note reads from a withdrawal's outcome. */
const done = (
  documents_unlinked: number, canvas_quotes_unplaced = 0,
  elsewhere: Partial<Pick<WithdrawalOutcome, 'other_projects_with_identifier' | 'pre_update_copies'>> = {},
) => ({
  documents_unlinked, canvas_quotes_unplaced,
  other_projects_with_identifier: { projects: [], total: 0 },
  pre_update_copies: { count: 0, folder: '/home/r/backups' },
  ...elsewhere,
})

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
  canvas_quotes_unplaced: { quotes: 0, sections: [], snapshots: [] },
  canvas_misfit_cases: 0,  // joint display slice 2 (r3-6)
  other_projects_with_identifier: { projects: [], total: 0 },
  pre_update_copies: { count: 0, folder: '/home/r/backups' },
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

  it('D314: a delete that removes their entries from lists of cases that don’t fit says so — never "only"', () => {
    // Joint display slice 2: the delete endpoint removes each entry naming them (D314), so
    // "removes the participant record only" became false where they are named.
    const named = describeDeleteConsequence(report({ canvas_misfit_cases: 2 }))
    expect(named).toContain('This removes the participant record — ')
    expect(named).not.toMatch(/record only/)
    expect(named).toContain('They are named, with your reason, in 2 lists of cases that don’t fit')
    const bare = describeDeleteConsequence(report({
      conversations: [], datasets: [], speaker_names: [], total_items: 1, canvas_misfit_cases: 1 }))
    expect(bare).toMatch(/removes the record\. They are named, with your reason, in 1 list/)
    // POSITIVE CONTROL: named nowhere, the sentence is as before.
    expect(describeDeleteConsequence(report())).toContain('This removes the participant record only — ')
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

  it('#1320 (D12), #1606 (D233): says what it does not reach — recordings and every earlier copy', () => {
    expect(WITHDRAWAL_SCOPE_NOTE).toContain(
      'It does not edit recordings, and backups, safety copies, database copies taken before '
      + 'an update, projects duplicated from this one and files exported before the withdrawal '
      + 'still hold their data.')
  })
})

describe('#1320 (D12) — the disclosure, as decided', () => {
  it('the confirm names every copy that still holds the data, and recordings', () => {
    // Pinned whole: the developer decided this wording (#1320 D12, and #1606 D233's
    // duplicated projects and update copies); #1190 appends the sentence about the
    // withdrawal's own record, pinned on its own below.
    expect(WITHDRAWAL_RESIDUAL_NOTE).toBe(
      'For honouring a withdrawal request. A full backup is taken first. That backup, your '
      + 'earlier backups, the safety copies kept before a merge or overwrite, any project '
      + 'duplicated from this one before now, and any file already exported or shared still '
      + 'hold everything this removes until they are deleted. So do the copies of the whole '
      + 'database taken before each update; they are in the backup folder, which Settings '
      + 'does not list, and the five most recent are kept. Automatic and On quit backups are '
      + 'replaced over time; the others stay until you delete them in Settings › Backup & '
      + 'Data. A duplicated project is a project of its own: withdraw them there too. '
      + 'Recordings are not edited — their voice stays in the audio or video. There is no '
      + 'per-person undo: restoring a backup also undoes any work done after it. '
      + WITHDRAWAL_RECORD_NOTE)
  })
})

describe('#1190 — what the withdrawal leaves behind on purpose', () => {
  it('says merging, importing and linking do not bring them back, and the hand-add asks', () => {
    expect(WITHDRAWAL_RECORD_NOTE).toBe(
      'Afterwards this project keeps a record of the withdrawal: merging or importing a copy '
      + 'of it, or linking records or speakers to participants, does not bring them back, and '
      + 'adding a participant with their ID asks first. A transcript that names a speaker with '
      + 'their ID, or with a name this project knew them by, does not make them a participant '
      + 'again — even written with different capitals or spacing, or with its accents encoded '
      + 'differently — and its import says so; a name this project never used for them is not '
      + 'recognised. Elsewhere their ID is recognised with its accents encoded either way, but '
      + 'its capitals count (P01 and p01 can be two people). Project files exported afterwards '
      + 'carry that record. It keeps their ID and those names as one-way codes, which is not '
      + 'anonymisation — anyone who can guess one can confirm it from the code, and the audit '
      + 'trail records the withdrawal under their ID. A withdrawal made '
      + 'in an earlier version of Mixed Measures recognises the names it kept only as they were '
      + 'written, and the oldest versions kept their ID only.')
  })

  it('#1606 (D233): says the audit trail keeps their ID — not only as a one-way code', () => {
    // D9 keeps the ID in plain text in the `withdrawn` entry; "one-way codes" alone read
    // as if it were kept plainly nowhere.
    expect(WITHDRAWAL_RECORD_NOTE).toMatch(/the audit trail records the withdrawal under their ID/)
  })

  it('#1472 (D76): says the NAMES are remembered, what is not caught, and what older withdrawals kept', () => {
    expect(WITHDRAWAL_RECORD_NOTE).toMatch(/a name this project knew them by/)
    expect(WITHDRAWAL_RECORD_NOTE).toMatch(/a name this project never used for them is not recognised/)
    expect(WITHDRAWAL_RECORD_NOTE).toMatch(/recognises the names it kept only as they were written/)
    expect(WITHDRAWAL_RECORD_NOTE).toMatch(/oldest versions kept their ID only/)
    // No version is named: the record has outlived two, and the next number is not decided.
    expect(WITHDRAWAL_RECORD_NOTE).not.toMatch(/\d+\.\d+/)
  })

  it('#1605 (D227–D229, D237): capitals, spacing and accent ENCODING — never the accents themselves', () => {
    expect(WITHDRAWAL_RECORD_NOTE).toMatch(/different capitals or spacing/)
    expect(WITHDRAWAL_RECORD_NOTE).toMatch(/accents encoded differently/)
    expect(WITHDRAWAL_RECORD_NOTE).toMatch(/its capitals count \(P01 and p01 can be two people\)/)
    // The fold never makes `Maria` and `María` one name, so nothing may read that way.
    expect(WITHDRAWAL_RECORD_NOTE).not.toMatch(/with or without (its |their )?accents|any accent|ignor\w* accents/i)
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
    // #1606 (D233, the developer's wording) — the update copies and a duplicated project.
    const backups = 'The “Before a withdrawal” backup taken now, every earlier backup and the '
      + 'database copies taken before each update still hold their data until you delete them '
      + '— backups in Settings › Backup & Data, update copies in the backup folder. A project '
      + 'duplicated from this one before now still holds them; withdraw them there too.'
    expect(WITHDRAWAL_BACKUP_RESIDUAL).toBe(backups)
    const elsewhere = {
      other_projects_with_identifier: { projects: [{ project_id: 2, name: 'B', copy_relation: null }], total: 1 },
      pre_update_copies: { count: 3, folder: '/b' },
    }
    for (const docs of [0, 1, 3]) {
      for (const quotes of [0, 2]) {
        expect(withdrawalDoneNote(done(docs, quotes)).endsWith(backups)).toBe(true)
        expect(withdrawalDoneNote(done(docs, quotes, elsewhere)).endsWith(backups)).toBe(true)
      }
    }
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
    expect(withdrawalDoneNote(done(0))).toBe(
      'Now search your transcripts and free-text answers for their name — that part cannot be automated. '
      + WITHDRAWAL_BACKUP_RESIDUAL)
    expect(withdrawalDoneNote(done(1))).toContain(' 1 document no longer says who it is about — read it too. ')
    expect(withdrawalDoneNote(done(3))).toContain(' 3 documents no longer say who they are about — read them too. ')
    expect(withdrawalDoneNote(done(0))).not.toMatch(/document/)
  })
})

describe('#1546 (D158) — canvas quotes the withdrawal cannot place', () => {
  const place = (name: string, quotes = 1, canvas = 'Main', id = 1) => ({
    canvas_id: 1, canvas_name: canvas, id, name, quotes,
  })
  const withCanvas = (
    sections: ReturnType<typeof place>[], snapshots: ReturnType<typeof place>[] = [],
  ) => report({
    canvas_quotes_unplaced: {
      quotes: [...sections, ...snapshots].reduce((t, p) => t + p.quotes, 0), sections, snapshots,
    },
  })

  it('says nothing when there are none', () => {
    expect(unplacedCanvasQuotesNote(report())).toBeNull()
    expect(keptSummary(report()).join(' ')).not.toMatch(/canvas/)
  })

  it('one quote: why it stays, and where to read it', () => {
    expect(unplacedCanvasQuotesNote(withCanvas([place('Findings')]))).toBe(
      '1 quote on a canvas comes from a quote, conversation or dataset deleted or changed since '
      + 'it was put there, so the withdrawal cannot tell whose words it holds. It stays — read it '
      + 'yourself: “Main › Findings”')
  })

  it('names every section with its canvas, and every snapshot, with their counts', () => {
    const note = unplacedCanvasQuotesNote(withCanvas(
      [place('Findings', 2), place('Findings', 1, 'Second', 2)],
      [place('Draft 1', 3, 'Main', 9)],
    ))
    expect(note).toMatch(/^6 quotes on a canvas come from quotes, conversations or datasets deleted/)
    expect(note).toMatch(/They stay — read them yourself: “Main › Findings” \(2\), “Second › Findings” and the snapshot “Draft 1” of “Main” \(3\)$/)
  })

  it('is said where the decision is made: the confirm’s “This will stay” list', () => {
    const r = withCanvas([place('Findings')])
    expect(keptSummary(r)).toContain(unplacedCanvasQuotesNote(r))
    expect(removedSummary(r).join(' ')).not.toMatch(/canvas/)
  })

  it('the note after a withdrawal says how many it left', () => {
    expect(withdrawalDoneNote(done(0, 1))).toContain(
      ' 1 quote on a canvas stays because its source was deleted or changed and nothing says '
      + 'whose words it holds — read it too. ')
    expect(withdrawalDoneNote(done(0, 4))).toContain(
      ' 4 quotes on a canvas stay because their source was deleted or changed and nothing says '
      + 'whose words they hold — read them too. ')
    expect(withdrawalDoneNote(done(0, 0))).not.toMatch(/canvas/)
  })

  it('the scope note says such quotes stay, and never promises it leaves every one', () => {
    expect(WITHDRAWAL_SCOPE_NOTE).toContain(
      'Quotes on a canvas taken from a conversation or dataset deleted before the withdrawal '
      + 'stay when it cannot tell whose words they hold.')
  })
})

describe('#1606 (D234) — other projects here holding someone with this ID', () => {
  type Rel = 'copy' | 'source' | null
  const proj = (name: string, copy_relation: Rel = null, project_id = 2) =>
    ({ project_id, name, copy_relation })
  const holding = (projects: ReturnType<typeof proj>[], total = projects.length) =>
    report({ other_projects_with_identifier: { projects, total } })

  it('says nothing when no other project holds the ID', () => {
    expect(otherProjectsNote(report())).toBeNull()
    expect(keptSummary(report()).join(' ')).not.toMatch(/Other projects|Another project/)
  })

  it('one project: names it, and asks the researcher to check rather than claiming it is them', () => {
    expect(otherProjectsNote(holding([proj('Pilot')]))).toBe(
      'Another project here holds a participant with this ID: “Pilot”. Check whether it is '
      + 'the same person, and withdraw them there too')
  })

  it('names a Duplicate in its direction — the original is never "a copy of this project"', () => {
    expect(otherProjectsNote(holding([
      proj('Wave 2', 'copy'), proj('Baseline', 'source', 3), proj('Pilot', null, 4),
    ]))).toBe(
      'Other projects here hold a participant with this ID: “Wave 2” (a copy of this project), '
      + '“Baseline” (the project this one was copied from) and “Pilot”. Check whether it is '
      + 'the same person, and withdraw them there too')
  })

  it('counts the ones past the cap rather than dropping them', () => {
    const named = Array.from({ length: 20 }, (_, i) => proj(`S${i}`, null, i + 2))
    const note = otherProjectsNote(holding(named, 23))
    expect(note).toMatch(/“S18”, “S19” and 3 more\. Check whether/)
  })

  it('is said where the decision is made, under what STAYS — never what is removed', () => {
    const r = holding([proj('Pilot')])
    expect(keptSummary(r)).toContain(otherProjectsNote(r))
    expect(removedSummary(r).join(' ')).not.toMatch(/Pilot/)
  })

  it('the note after a withdrawal says it, before the backups', () => {
    const note = withdrawalDoneNote(done(0, 0, {
      other_projects_with_identifier: { projects: [proj('Wave 2', 'copy')], total: 1 },
    }))
    expect(note).toContain(' Another project here holds a participant with this ID: “Wave 2” '
      + '(a copy of this project). Check whether it is the same person, and withdraw them there too. ')
    expect(withdrawalDoneNote(done(0)).match(/Another project|Other projects/)).toBeNull()
  })
})

describe('#1606 (D235) — the copies of the whole database taken before updates', () => {
  const copies = (count: number | null) =>
    report({ pre_update_copies: { count, folder: '/home/r/backups' } })

  it('says nothing when there are none — and a real 0 is none', () => {
    expect(preUpdateCopiesNote(copies(0))).toBeNull()
    expect(keptSummary(copies(0)).join(' ')).not.toMatch(/whole database/)
  })

  it('says how many and the folder the server named', () => {
    expect(preUpdateCopiesNote(copies(1))).toBe(
      '1 copy of the whole database taken before an update is in /home/r/backups')
    expect(preUpdateCopiesNote(copies(5))).toBe(
      '5 copies of the whole database taken before updates are in /home/r/backups')
    expect(keptSummary(copies(2))).toContain(preUpdateCopiesNote(copies(2)))
  })

  it('a folder the server could not read is unknown, never "none"', () => {
    expect(preUpdateCopiesNote(copies(null))).toBe(
      'The backup folder, /home/r/backups, could not be read, so whether it holds copies of '
      + 'the whole database taken before updates is not known')
  })

  it('the note after a withdrawal says it, before the backups', () => {
    expect(withdrawalDoneNote(done(0, 0, { pre_update_copies: { count: 2, folder: '/b' } })))
      .toContain(' 2 copies of the whole database taken before updates are in /b. The “Before')
  })
})
