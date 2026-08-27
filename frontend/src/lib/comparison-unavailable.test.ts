/**
 * #823(c) · #827 — the client renders the server's reason and never invents one.
 *
 * The assertion that matters is the NEGATIVE one: an unknown reason must render
 * nothing. The whole defect was a confident sentence produced where no
 * information existed, and a fallback that guessed would reintroduce it for
 * every payload from a newer server.
 */
import { describe, it, expect } from 'vitest'
import {
  describeUnavailable,
  isComputableScoreReason,
  type ComparisonUnavailableReason,
} from './comparison-unavailable'

const ALL: ComparisonUnavailableReason[] = [
  'no_variables',
  'domain_scores_missing',
  'domain_scores_not_computed',
  'no_group_values',
  'insufficient_groups',
]

describe('describeUnavailable', () => {
  it('has distinct copy for every reason', () => {
    const titles = ALL.map(r => describeUnavailable(r)?.title)
    expect(titles.every(Boolean)).toBe(true)
    expect(new Set(titles).size).toBe(ALL.length)
  })

  it('says nothing for an unknown reason', () => {
    // A reason a newer server sends. Silence is the honest answer; the caller
    // falls back to a neutral line.
    expect(describeUnavailable('some_future_reason')).toBeNull()
  })

  it('says nothing when no reason was sent', () => {
    // Every response from a server that predates the field.
    expect(describeUnavailable(null)).toBeNull()
    expect(describeUnavailable(undefined)).toBeNull()
  })

  it('never repeats the sentence the round exists to remove', () => {
    // "…may have fewer than 2 groups" was printed for all four causes. Only the
    // group-count reason may speak about group counts now.
    for (const r of ALL) {
      const copy = describeUnavailable(r)!
      const text = `${copy.title} ${copy.detail}`.toLowerCase()
      if (r !== 'insufficient_groups') {
        expect(text, `${r} must not blame the group count`).not.toMatch(/two groups|2 groups/)
      }
    }
    expect(describeUnavailable('insufficient_groups')!.title).toMatch(/two groups/)
  })

  it('names the dataset relationship for the cross-dataset case, not the links', () => {
    // #827's filed cause (participant links) is refuted; copy that named it
    // would send the researcher to link rows, which changes nothing.
    const copy = describeUnavailable('no_group_values')!
    expect(`${copy.title} ${copy.detail}`).toMatch(/dataset/i)
    expect(`${copy.title} ${copy.detail}`).not.toMatch(/participant|link/i)
  })
})

describe('isComputableScoreReason', () => {
  it('is true for exactly the two the button can fix', () => {
    expect(isComputableScoreReason('domain_scores_missing')).toBe(true)
    expect(isComputableScoreReason('domain_scores_not_computed')).toBe(true)
  })

  it('is false for the reasons a button cannot fix', () => {
    // Offering "Compute the scale score" for a cross-dataset grouping problem
    // would be a second confident wrong answer.
    for (const r of ['no_variables', 'no_group_values', 'insufficient_groups'] as const) {
      expect(isComputableScoreReason(r)).toBe(false)
    }
    expect(isComputableScoreReason(null)).toBe(false)
  })
})
