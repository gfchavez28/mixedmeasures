/**
 * Shared CSV helpers — the single source of the formula-injection defang
 * (mirrors backend csv_safe). Used by the crosswalk export and the quote-board
 * export, so pin the security-relevant behavior directly.
 */

import { describe, it, expect } from 'vitest'
import { csvSafe, escapeCsvField, toCsv, UTF8_BOM } from './csv'

describe('csvSafe', () => {
  it('defangs the OWASP formula-injection prefixes (=, @, tab, CR)', () => {
    expect(csvSafe('=SUM(A1)')).toBe("'=SUM(A1)")
    expect(csvSafe('@cmd')).toBe("'@cmd")
    expect(csvSafe('\tx')).toBe("'\tx")
    expect(csvSafe('\rx')).toBe("'\rx")
  })

  it('leaves +/- and ordinary values alone (no false-positive on negatives)', () => {
    expect(csvSafe('-3.5')).toBe('-3.5')
    expect(csvSafe('+4')).toBe('+4')
    expect(csvSafe('School')).toBe('School')
    expect(csvSafe('')).toBe('')
  })
})

describe('escapeCsvField', () => {
  it('quotes + doubles quotes when the field has comma/quote/newline/CR', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"')
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""')
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"')
    expect(escapeCsvField('plain')).toBe('plain')
  })

  it('defangs before quoting', () => {
    expect(escapeCsvField('=1+1,2')).toBe('"\'=1+1,2"')
  })
})

describe('toCsv', () => {
  it('joins rows with CRLF and escapes each field', () => {
    expect(toCsv([['a', 'b'], ['c,d', 'e']])).toBe('a,b\r\n"c,d",e')
  })

  it('round-trips a simple matrix', () => {
    expect(toCsv([['h1', 'h2'], ['1', '2']])).toBe('h1,h2\r\n1,2')
  })
})

describe('UTF8_BOM', () => {
  it('is the single zero-width BOM character', () => {
    expect(UTF8_BOM).toBe(String.fromCharCode(0xfeff))
    expect(UTF8_BOM).toHaveLength(1)
  })
})
