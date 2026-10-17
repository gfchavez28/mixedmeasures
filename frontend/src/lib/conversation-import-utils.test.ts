// #410 regression: the visible conversation-name field wins. syncAutoNames
// runs live on the Speakers step; names the user has edited are never touched,
// so the displayed name always equals the imported name (the bug was a silent
// participant-derived override applied at submit time).
import { describe, expect, it } from 'vitest'

import {
  fileCheckRefusal, generateParticipantName, isBlockingFileWarning, isOrphanedParticipant, namingTheFile,
  syncAutoNames, UNREADABLE_FILE_PREFIX, type SpeakerMapping,
} from './conversation-import-utils'

const speaker = (name: string, isFacilitator = false): SpeakerMapping =>
  ({ original_label: name, normalized_name: name, is_facilitator: isFacilitator }) as SpeakerMapping

describe('syncAutoNames', () => {
  it('fills the participant-derived name into a non-edited field', () => {
    const out = syncAutoNames(
      ['interview_maria'],
      [[speaker('Interviewer', true), speaker('Maria')]],
      [],
      new Set(),
    )
    expect(out).toEqual(['Maria'])
  })

  it('never touches a user-edited name (the field wins)', () => {
    const out = syncAutoNames(
      ['My custom title'],
      [[speaker('Interviewer', true), speaker('Maria')]],
      [],
      new Set([0]),
    )
    expect(out).toEqual(['My custom title'])
    expect(out[0]).toBe('My custom title')
  })

  it('keeps the filename-derived name when no participant name is derivable', () => {
    const out = syncAutoNames(['focus_group_a'], [[speaker('Facilitator', true)]], [], new Set())
    expect(out).toEqual(['focus_group_a'])
  })

  it('dedups across the batch and against existing conversations', () => {
    const out = syncAutoNames(
      ['file1', 'file2'],
      [
        [speaker('Maria')],
        [speaker('Maria')],
      ],
      ['Maria'],
      new Set(),
    )
    expect(out).toEqual(['Maria (1)', 'Maria (2)'])
  })

  it('returns the same array identity when nothing changes', () => {
    const names = ['Maria']
    const out = syncAutoNames(names, [[speaker('Maria')]], [], new Set())
    expect(out).toBe(names)
  })
})

describe('generateParticipantName', () => {
  it('joins two participants and groups three or more', () => {
    expect(generateParticipantName([speaker('A'), speaker('B')], [])).toBe('A & B')
    expect(generateParticipantName([speaker('A'), speaker('B'), speaker('C')], [])).toBe(
      'Group (A, B, & C)',
    )
  })
})

/**
 * #1110 — a document's SUBJECT is not an orphan.
 *
 * The predicate drives the Participants page's "No linked sources" filter — the
 * list a researcher selects from to delete people — and it counted speakers and
 * dataset rows only, so the subject of a workplan was offered for deletion and
 * deleting them silently cleared the document's subject. One case per link, so a
 * clause dropped from the predicate fails by name.
 */
describe('isOrphanedParticipant', () => {
  const none = { linked_speakers: [], dataset_rows: [], linked_documents: [] }
  it('is true only when NO link of the three is present', () => {
    expect(isOrphanedParticipant(none)).toBe(true)
  })
  it.each([
    ['a speaker', { linked_speakers: [{}] }],
    ['a dataset record', { dataset_rows: [{}] }],
    ['a document they are the subject of', { linked_documents: [{}] }],
  ])('%s makes them linked', (_, link) => {
    expect(isOrphanedParticipant({ ...none, ...link })).toBe(false)
  })
})

describe('#1127 — a refused transcript is named, and blocks', () => {
  it('names the file only when several are on the page', () => {
    expect(namingTheFile('b.csv', 'Line 2 …', true)).toBe('“b.csv”: Line 2 …')
    expect(namingTheFile('b.csv', 'Line 2 …', false)).toBe('Line 2 …')
  })

  it('a refused file and a missing column block; an optional column does not', () => {
    expect(isBlockingFileWarning(`${UNREADABLE_FILE_PREFIX} Line 2 …`)).toBe(true)
    expect(isBlockingFileWarning('Missing required columns: Text ("Text")')).toBe(true)
    expect(isBlockingFileWarning('Optional columns missing: End Time (will be skipped)')).toBe(false)
    expect(isBlockingFileWarning(null)).toBe(false)
  })
})

describe('fileCheckRefusal (#1259 — composed from the files still listed)', () => {
  const names = ['a.csv', 'b.csv', 'c.csv']
  const refused = (why: string) => `${UNREADABLE_FILE_PREFIX} ${why}`
  const MISSING = 'Missing required columns: Text ("Text")'

  it('names each refused file with its own sentence, in file order', () => {
    expect(fileCheckRefusal(names, [null, refused('Line 2 …'), null]))
      .toBe('“b.csv”: Line 2 … Remove that file below, or correct it and add it again.')
    expect(fileCheckRefusal(names, [null, refused('Line 2 …'), refused('Line 9 …')]))
      .toBe('“b.csv”: Line 2 … “c.csv”: Line 9 … Remove those files below, or correct them and add them again.')
  })

  it('a missing column says the mapping sentence, and then no "Remove that file" sentence', () => {
    expect(fileCheckRefusal(names, [null, MISSING, null]))
      .toBe('Some files are incompatible with the selected column mapping. Remove them or adjust your mapping.')
    expect(fileCheckRefusal(names, [null, refused('Line 2 …'), MISSING]))
      .toBe('“b.csv”: Line 2 … Some files are incompatible with the selected column mapping. Remove them or adjust your mapping.')
  })

  it('is empty when nothing listed blocks — including after the refused file is gone', () => {
    expect(fileCheckRefusal(['a.csv'], [null])).toBe('')
    expect(fileCheckRefusal(names, [null, 'Optional columns missing: End Time (will be skipped)', null])).toBe('')
  })

  it('never reads the first file, which the mapping came from', () => {
    expect(fileCheckRefusal(names, [refused('Line 2 …'), MISSING, null])).not.toContain('a.csv')
  })
})
