/**
 * #1139 — the confirmations name the person clicked, with the identifier beside a
 * display name (two people can share one), and the identifier alone otherwise.
 */
import { describe, it, expect } from 'vitest'
import {
  deleteConfirmTitle, participantName, participantNameWithId, withdrawConfirmTitle,
} from './participant-naming'

const amara = { identifier: 'E-01', display_name: 'Amara Okafor' }
const bare = { identifier: 'P07', display_name: null }

describe('participant naming (#1139)', () => {
  it('a display name leads and the identifier follows', () => {
    expect(withdrawConfirmTitle(amara)).toBe('Remove Amara Okafor’s data? (E-01)')
    expect(deleteConfirmTitle(amara)).toBe('Delete Amara Okafor’s record? (E-01)')
    expect(participantNameWithId(amara)).toBe('Amara Okafor (E-01)')
  })

  it('no display name: the identifier, once', () => {
    expect(withdrawConfirmTitle(bare)).toBe('Remove P07’s data?')
    expect(deleteConfirmTitle(bare)).toBe('Delete P07’s record?')
    expect(participantNameWithId(bare)).toBe('P07')
  })

  it('a display name that IS the identifier is not said twice (the page’s own create sets both)', () => {
    expect(participantNameWithId({ identifier: 'Jonas Berg', display_name: 'Jonas Berg' })).toBe('Jonas Berg')
  })

  it('an imported "..." placeholder is no name (#396): the identifier stands in', () => {
    expect(participantName({ identifier: 'S3', display_name: '...' })).toBe('S3')
    expect(withdrawConfirmTitle({ identifier: 'S3', display_name: '...' })).toBe('Remove S3’s data?')
  })
})
