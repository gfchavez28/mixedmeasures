// #410 regression: the visible conversation-name field wins. syncAutoNames
// runs live on the Speakers step; names the user has edited are never touched,
// so the displayed name always equals the imported name (the bug was a silent
// participant-derived override applied at submit time).
import { describe, expect, it } from 'vitest'

import { generateParticipantName, syncAutoNames, type SpeakerMapping } from './conversation-import-utils'

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
