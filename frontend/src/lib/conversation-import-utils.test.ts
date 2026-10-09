// #410 regression: the visible conversation-name field wins. syncAutoNames
// runs live on the Speakers step; names the user has edited are never touched,
// so the displayed name always equals the imported name (the bug was a silent
// participant-derived override applied at submit time).
import { describe, expect, it } from 'vitest'

import { generateParticipantName, isOrphanedParticipant, syncAutoNames, type SpeakerMapping } from './conversation-import-utils'

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
