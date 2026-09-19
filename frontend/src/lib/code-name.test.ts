/**
 * #963 — the duplicate-code-name comparison, which six surfaces had a copy of and
 * three had none of.
 *
 * The cases here are the ones where the copies could have drifted, and where the
 * client must agree with `routers/codes.py::_refuse_duplicate_code_name` — a
 * client that hints "free" for a name the server refuses is worse than no hint.
 */
import { describe, it, expect } from 'vitest'
import { findCodeByName, normalizeCodeName } from './code-name'

const codes = [
  { id: 1, name: 'Barriers' },
  { id: 2, name: '  Spaced  ' },
  { id: 3, name: 'École' },
  // ⚠️ A whitespace-ONLY name, so the empty-needle guard is falsifiable. Without
  // it the fixture is degenerate on that axis: removing the guard leaves an empty
  // query matching nothing anyway, and the mutant survives (measured).
  // `create_code` requires `min_length=1` but does not trim, so this row is a
  // reachable state, not a synthetic one.
  { id: 4, name: '   ' },
]

describe('normalizeCodeName', () => {
  it('trims and lowercases', () => {
    expect(normalizeCodeName('  Barriers ')).toBe('barriers')
  })

  it('uses toLowerCase, matching the server (which uses .lower(), not .casefold())', () => {
    // casefold would fold this to "strasse"; both sides must agree that it does not.
    expect(normalizeCodeName('Straße')).toBe('straße')
  })
})

describe('findCodeByName', () => {
  it('finds an exact match', () => {
    expect(findCodeByName(codes, 'Barriers')?.id).toBe(1)
  })

  it('is case-insensitive', () => {
    expect(findCodeByName(codes, 'BARRIERS')?.id).toBe(1)
    expect(findCodeByName(codes, 'barriers')?.id).toBe(1)
  })

  it('ignores surrounding whitespace on the TYPED name', () => {
    expect(findCodeByName(codes, '   Barriers   ')?.id).toBe(1)
  })

  it('ignores surrounding whitespace on the STORED name', () => {
    // A stored name can carry whitespace — `create_code` does not trim on write.
    expect(findCodeByName(codes, 'Spaced')?.id).toBe(2)
  })

  it('matches a non-ASCII case variant', () => {
    // SQLite's own lower() is ASCII-only, which is why the server compares in
    // Python; the client must not be looser than that.
    expect(findCodeByName(codes, 'école')?.id).toBe(3)
  })

  it('does not match a PARTIAL name', () => {
    // The search filters elsewhere use `includes`; this one must not.
    expect(findCodeByName(codes, 'Barrier')).toBeUndefined()
    expect(findCodeByName(codes, 'Barriers and more')).toBeUndefined()
  })

  it('returns undefined for an empty or whitespace-only name, even when a code IS named only whitespace', () => {
    // Callers own their own "nothing typed" rule; folding it in here would make
    // one return value mean two things. The fixture holds a whitespace-named code
    // precisely so this assertion can fail: without the guard, an empty box would
    // report that code as a collision and disable Create with a blank name in the
    // message.
    expect(codes.some(c => c.name.trim() === '')).toBe(true)
    expect(findCodeByName(codes, '')).toBeUndefined()
    expect(findCodeByName(codes, '   ')).toBeUndefined()
  })

  it('returns undefined against an empty list', () => {
    expect(findCodeByName([], 'Barriers')).toBeUndefined()
  })

  it('returns the CODE, so a caller can name it on screen', () => {
    // "A code named X already exists" is actionable; a boolean is not.
    expect(findCodeByName(codes, 'barriers')?.name).toBe('Barriers')
  })
})
