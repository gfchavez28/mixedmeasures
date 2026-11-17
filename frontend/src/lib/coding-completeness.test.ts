/**
 * #1626 (D244): the words for participants with no coding in scope. The server's CSV
 * mirrors them (`backend/tests/test_without_coding_1626.py` holds the two equal).
 */
import { describe, it, expect } from 'vitest'
import { NO_CODING_NOTE_TAIL, noCodingNote, noCodingScope, withNoCodingLabel } from './coding-completeness'

describe('noCodingNote', () => {
  it('lists every group, a 0 included, in the order given, with the accepted sentence', () => {
    expect(noCodingNote([['A', 2], ['B', 0]], 'every')).toBe(
      'Some participants have no coding here (A: 2, B: 0). They count as not using any code. '
      + 'If their material has not been coded yet, these shares are too low, and a group coded '
      + 'less far will look as if it uses codes less.',
    )
  })

  it('says nothing when no group has such a participant (absence makes no claim)', () => {
    expect(noCodingNote([['A', 0], ['B', 0]], 'every')).toBeNull()
    expect(noCodingNote([], 'every')).toBeNull()
  })

  it('names whose coding it is about, from the stated scope', () => {
    const one = [['A', 1]] as const
    expect(noCodingNote(one, 'coders')).toContain('have no coding by the coders shown here')
    expect(noCodingNote(one, 'consensus')).toContain('have no consensus coding here')
    expect(noCodingNote(one, 'machine')).toContain('have no coding by the model here')
    expect(noCodingNote(one, 'machine')).toContain(NO_CODING_NOTE_TAIL)
  })

  it('never says "not yet coded" alone — "no coding" can be a true negative', () => {
    const note = noCodingNote([['A', 3]], 'every') ?? ''
    expect(note).not.toMatch(/not yet coded/i)
    expect(note).toContain('If their material has not been coded yet')
  })
})

describe('noCodingScope', () => {
  it('reads a stated scope, and an unknown or absent one as every coder', () => {
    expect(noCodingScope('coders')).toBe('coders')
    expect(noCodingScope('machine')).toBe('machine')
    expect(noCodingScope(undefined)).toBe('every')
    expect(noCodingScope('toString')).toBe('every')   // an inherited name is not a scope
    expect(noCodingScope('bogus')).toBe('every')
  })
})

describe('grouped digits — the scale corpus held 74,611 in one group', () => {
  it('in the note and the header, as the server CSV writes them', () => {
    expect(noCodingNote([['Maybe', 74611], ['No', 0]], 'every'))
      .toMatch(/^Some participants have no coding here \(Maybe: 74,611, No: 0\)\./)
    expect(withNoCodingLabel(74611)).toBe('74,611 with no coding')
  })
})

describe('withNoCodingLabel', () => {
  it('is the header addition above 0, and nothing at 0 or unknown', () => {
    expect(withNoCodingLabel(2)).toBe('2 with no coding')
    expect(withNoCodingLabel(0)).toBeNull()
    expect(withNoCodingLabel(null)).toBeNull()
  })
})
