import { describe, it, expect } from 'vitest'
import {
  apaCitation,
  bibtexCitation,
  releaseYear,
  CITATION_REPO_URL,
} from './citation'

describe('releaseYear', () => {
  it('takes the year from an ISO release date', () => {
    expect(releaseYear('2026-07-03')).toBe('2026')
  })

  it('does not drift to the current year', () => {
    // The citation must quote when the version shipped, not when it is read.
    expect(releaseYear('2024-01-31')).toBe('2024')
  })
})

describe('apaCitation', () => {
  it('renders an APA 7 software reference', () => {
    expect(apaCitation('1.1.1', '2026-07-03')).toBe(
      'Chavez, G. (2026). Mixed Measures (Version 1.1.1) [Computer software]. https://github.com/gfchavez28/mixedmeasures',
    )
  })

  it('quotes the running version', () => {
    expect(apaCitation('2.0.0', '2027-03-01')).toContain('(Version 2.0.0)')
    expect(apaCitation('2.0.0', '2027-03-01')).toContain('(2027)')
  })
})

describe('bibtexCitation', () => {
  it('renders a @software entry keyed by release year', () => {
    const bib = bibtexCitation('1.1.1', '2026-07-03')
    expect(bib).toContain('@software{chavez_mixed_measures_2026,')
    expect(bib).toContain('version = {1.1.1}')
    expect(bib).toContain('year    = {2026}')
    expect(bib).toContain('license = {Apache-2.0}')
    expect(bib).toContain(`url     = {${CITATION_REPO_URL}}`)
    expect(bib.trimEnd().endsWith('}')).toBe(true)
  })

  it('balances braces so the entry pastes into a .bib file cleanly', () => {
    const bib = bibtexCitation('1.1.1', '2026-07-03')
    const open = (bib.match(/{/g) ?? []).length
    const close = (bib.match(/}/g) ?? []).length
    expect(open).toBe(close)
  })
})
