import { describe, it, expect } from 'vitest'
import {
  withdrawalLocations, describeDeleteConsequence, withdrawalHeadline,
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
  total_items: 59,
  ...over,
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
    expect(msg).toMatch(/no linked transcript turns or responses/)
  })

  it('has a safe form before the report has loaded', () => {
    // The dialog can open before the fetch resolves; silence there would be the
    // old behaviour by accident.
    const msg = describeDeleteConsequence(null)
    expect(msg).toMatch(/remain in the project/)
  })
})

describe('withdrawalHeadline', () => {
  it('counts items and sources', () => {
    expect(withdrawalHeadline(report()))
      .toBe('59 items across 2 sources would have to be removed by hand to honour a withdrawal.')
  })

  it('says so plainly when there is nothing', () => {
    expect(withdrawalHeadline(report({ conversations: [], datasets: [], total_items: 1 })))
      .toBe('Nothing else in this project is linked to this participant.')
  })
})
