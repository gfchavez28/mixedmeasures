import { describe, it, expect } from 'vitest'
import { plural, countLabel, formatBytes } from './format'

describe('plural / countLabel (#640)', () => {
  it('uses the singular ONLY at exactly one', () => {
    expect(plural(1, 'row', 'rows')).toBe('row')
    expect(plural(0, 'row', 'rows')).toBe('rows')
    expect(plural(2, 'row', 'rows')).toBe('rows')
  })

  it('renders the whole phrase, which is the form call sites should use', () => {
    expect(countLabel(0, 'observation', 'observations')).toBe('0 observations')
    expect(countLabel(1, 'observation', 'observations')).toBe('1 observation')
    expect(countLabel(12, 'observation', 'observations')).toBe('12 observations')
  })

  it('is the regression pin for "Preview (1 rows)"', () => {
    // A solo-speaker VTT merges to a single turn, so one row is the DEFAULT
    // outcome for a one-person recording — not an edge case.
    expect(countLabel(1, 'row', 'rows')).toBe('1 row')
  })

  it('does not assume English-plural-by-s', () => {
    expect(countLabel(1, 'analysis', 'analyses')).toBe('1 analysis')
    expect(countLabel(3, 'analysis', 'analyses')).toBe('3 analyses')
  })

  it('leaves formatBytes untouched', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
  })
})
