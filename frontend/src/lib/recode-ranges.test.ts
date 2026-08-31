/**
 * Range bands, client side — #823(d).
 *
 * This module is a MIRROR of `services/recode_ranges.py`, so the tests that
 * matter are the ones pinning the properties the two sides must share: the
 * inclusive bounds, the first-match-wins order, and the cell-parsing rule.
 * A drift here is the #578 class — the grid showing a different number from the
 * one `value_numeric` holds — on the surface a researcher checks a recode
 * against.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildRangePayload,
  describeRange,
  describeRow,
  parseCellNumber,
  rangeOverlaps,
  rangesToRows,
  resolveRangeOutput,
  rowOverlaps,
  type RangeRow,
  type RecodeRange,
} from './recode-ranges'

const AGE_BANDS: RecodeRange[] = [
  { lo: 18, hi: 29, output: 'Under 30' },
  { lo: 30, hi: 44, output: '30 to 44' },
  { lo: 45, hi: null, output: '45 and over' },
]

describe('resolveRangeOutput — the mirror of the backend matcher', () => {
  it('is inclusive at both ends', () => {
    expect(resolveRangeOutput('18', AGE_BANDS)).toBe('Under 30')
    expect(resolveRangeOutput('29', AGE_BANDS)).toBe('Under 30')
    expect(resolveRangeOutput('30', AGE_BANDS)).toBe('30 to 44')
  })

  it('treats a null bound as unbounded', () => {
    expect(resolveRangeOutput('120', AGE_BANDS)).toBe('45 and over')
  })

  it('🔴 resolves overlap by ORDER, so a special case can lead', () => {
    // The same rule as the backend's. If the two sides disagreed about which
    // band wins, the grid would show one number and the export another.
    const bands: RecodeRange[] = [
      { lo: 65, hi: 65, output: 'Exactly 65' },
      { lo: 18, hi: null, output: 'Adult' },
    ]
    expect(resolveRangeOutput('65', bands)).toBe('Exactly 65')
    expect(resolveRangeOutput('66', bands)).toBe('Adult')
  })

  it('returns undefined — not null — when nothing matches', () => {
    // `undefined` composes with the mapping lookup, which also misses with
    // `undefined`; `null` would be indistinguishable from a band whose output
    // is null-ish.
    expect(resolveRangeOutput('4', AGE_BANDS)).toBeUndefined()
  })

  it('never matches a non-numeric cell', () => {
    expect(resolveRangeOutput('Very happy', AGE_BANDS)).toBeUndefined()
  })

  it('is inert with no bands', () => {
    expect(resolveRangeOutput('25', [])).toBeUndefined()
    expect(resolveRangeOutput('25', undefined)).toBeUndefined()
  })
})

describe('parseCellNumber — why not a bare Number()', () => {
  it('🔴 does NOT read a blank cell as zero', () => {
    // `Number('')` and `Number(' ')` are both 0, which would band an empty cell
    // as zero — silently, on the one type of cell that means "no answer".
    expect(parseCellNumber('')).toBeNull()
    expect(parseCellNumber('   ')).toBeNull()
    expect(parseCellNumber(null)).toBeNull()
    expect(parseCellNumber(undefined)).toBeNull()
  })

  it('strips thousands separators, matching the backend cell rule', () => {
    expect(parseCellNumber('1,200')).toBe(1200)
  })

  it('rejects part-numeric text', () => {
    expect(parseCellNumber('12abc')).toBeNull()
  })

  it('accepts negatives and decimals', () => {
    expect(parseCellNumber('-99')).toBe(-99)
    expect(parseCellNumber('3.5')).toBe(3.5)
  })

  describe('🔴 #862 — the glyphs the backend strips, and the literals it refuses', () => {
    /**
     * This function's docstring always claimed to parse "the way the backend's
     * `_strip_numeric` does". It stripped commas and nothing else. MEASURED
     * across 39 inputs against the real Python helper: **16 disagreed**, now 3
     * — and the three are the stated Unicode-digit boundary below.
     *
     * The shared fixture carries the cases both languages must agree on; these
     * pin the PARSER directly, including the two rules the fixture cannot show
     * (what a bare glyph does, and the divergence we are keeping).
     */
    it.each([
      ['$50,000', 50000],
      ['45%', 45],
      ['€30', 30],
      ['£30', 30],
      ['¥30', 30],
      ['1$2', 12],
      ['$-3', -3],
      ['1_000', 1000],
      ['+5', 5],
      ['.5', 0.5],
      ['5.', 5],
      ['1e3', 1000],
    ] as [string, number][])('parses %s as %s, like float()', (cell, expected) => {
      expect(parseCellNumber(cell)).toBe(expected)
    })

    it.each([
      ['0x10'], ['0X1F'], ['0b101'], ['0o17'],   // Number() reads these; float() does not
      ['1__0'], ['_10'], ['10_'],                // PEP 515 refuses these too
      ['$'], ['%'], ['1e'], ['--5'], ['0.1.2'],
      ['Infinity'], ['nan'],
    ] as [string][])('refuses %s, like float()', (cell) => {
      expect(parseCellNumber(cell)).toBeNull()
    })

    it('🔴 a percent cell bands by its FACE value — % is stripped, not applied', () => {
      // `_strip_numeric("45%")` is 45, not 0.45, so a 40–50 band claims it.
      // Surprising, and the mirror's job is to agree rather than to improve.
      expect(parseCellNumber('45%')).toBe(45)
    })

    it('⚠️ THE STATED DIVERGENCE: non-ASCII decimal digits are not parsed here', () => {
      // MEASURED: float() accepts all three ("٣٤" -> 34, "１２３" -> 123,
      // "۵" -> 5) via CPython's decimal-to-ASCII transform. This returns null,
      // so such a cell renders as raw text while the server bands it — the SAFE
      // direction (under-claiming, never showing a code the apply will not
      // write). Pinned so the boundary is a decision, not a surprise.
      expect(parseCellNumber('٣٤')).toBeNull()
      expect(parseCellNumber('１２３')).toBeNull()
      expect(parseCellNumber('۵')).toBeNull()
    })

    it('⚠️ and NFKC is not the cheap way to close it', () => {
      // Normalising would newly accept both of these, and float() refuses both
      // — buying one narrow case by opening two in the dangerous direction.
      expect(parseCellNumber('²')).toBeNull()
      expect(parseCellNumber('５％')).toBeNull()
    })
  })
})

describe('buildRangePayload — the mirror of normalize_ranges', () => {
  it('skips blank rows rather than refusing them', () => {
    const res = buildRangePayload(
      [{ lo: '', hi: '', output: '' }, { lo: '18', hi: '29', output: 'Young' }],
      false,
    )
    expect(res.ok).toBe(true)
    expect(res.ranges).toEqual([{ lo: 18, hi: 29, output: 'Young' }])
  })

  it('refuses a row with no bound at all', () => {
    const res = buildRangePayload([{ lo: '', hi: '', output: 'Young' }], false)
    expect(res.ok).toBe(false)
    expect(res.msg).toMatch(/low or a high/)
    expect(res.badRow).toBe(0)
  })

  it('refuses a backwards range and names it', () => {
    const res = buildRangePayload([{ lo: '50', hi: '20', output: 'x' }], false)
    expect(res.ok).toBe(false)
    expect(res.msg).toMatch(/backwards/)
  })

  it('refuses a band with no output', () => {
    const res = buildRangePayload([{ lo: '1', hi: '2', output: '  ' }], false)
    expect(res.ok).toBe(false)
    expect(res.msg).toMatch(/needs a value/)
  })

  it('🔴 refuses TEXT on a scale map, and keeps it on a category group', () => {
    // The one rule that differs by recode type: a scale map writes
    // `value_numeric`, so a named band there would be unmapped at apply time.
    expect(buildRangePayload([{ lo: '1', hi: '2', output: 'Low' }], true).ok).toBe(false)
    expect(buildRangePayload([{ lo: '1', hi: '2', output: 'Low' }], false).ok).toBe(true)
  })

  it('coerces a numeric-string output on a scale map', () => {
    const res = buildRangePayload([{ lo: '1', hi: '2', output: '3' }], true)
    expect(res.ranges).toEqual([{ lo: 1, hi: 2, output: 3 }])
  })

  it('keeps an open end as null rather than dropping the row', () => {
    const res = buildRangePayload([{ lo: '45', hi: '', output: 'Older' }], false)
    expect(res.ranges).toEqual([{ lo: 45, hi: null, output: 'Older' }])
  })
})

describe('rangesToRows round-trips the editor state', () => {
  it('renders an open bound as an empty input, not "null"', () => {
    expect(rangesToRows([{ lo: 45, hi: null, output: 'Older' }])).toEqual([
      { lo: '45', hi: '', output: 'Older' },
    ])
  })

  it('survives a build with no bands', () => {
    expect(rangesToRows(undefined)).toEqual([])
    expect(rangesToRows(null)).toEqual([])
  })
})

describe('overlap is disclosed, not refused', () => {
  it('reports an overlapping pair', () => {
    expect(rangeOverlaps([
      { lo: 0, hi: 10, output: 'a' },
      { lo: 5, hi: 20, output: 'b' },
    ])).toEqual([[0, 1]])
  })

  it('🔴 does NOT flag adjacent bands', () => {
    // 18–29 and 30–44 is what a researcher writes. Flagging it would train them
    // to dismiss the notice on the case that matters.
    expect(rangeOverlaps([
      { lo: 18, hi: 29, output: 'a' },
      { lo: 30, hi: 44, output: 'b' },
    ])).toEqual([])
  })

  it('treats an open end as overlapping everything above it', () => {
    expect(rangeOverlaps([
      { lo: 45, hi: null, output: 'older' },
      { lo: 60, hi: 70, output: 'sixties' },
    ])).toEqual([[0, 1]])
  })
})

describe('🔴 #863 — rowOverlaps answers in ROW indices', () => {
  /**
   * The editor filtered incomplete rows out and printed `rangeOverlaps`' indices
   * as row numbers. Those index the FILTERED list, so any skipped row above a
   * pair shifted the answer down — reproduced live on GSS `age`: rows
   * `[blank, 18–29, 25–40]` reported *"Range 1 and range 2 overlap"*, naming an
   * empty row and neither of the two that did.
   */
  const r = (lo: string, hi: string, output = 'x'): RangeRow => ({ lo, hi, output })

  it('names the real rows when a BLANK row sits above the pair', () => {
    expect(rowOverlaps([r('', ''), r('18', '29'), r('25', '40')])).toEqual([[1, 2]])
  })

  it('agrees with the un-shifted case, so the fix is not an off-by-one the other way', () => {
    expect(rowOverlaps([r('18', '29'), r('25', '40')])).toEqual([[0, 1]])
  })

  it('skips a row whose bound is not a number, without shifting the rest', () => {
    // `??` does not catch NaN, so this row used to survive the old filter and
    // then compare false against everything — two eligibility rules, disagreeing.
    expect(rowOverlaps([r('abc', '40'), r('18', '29'), r('25', '40')])).toEqual([[1, 2]])
  })

  it('still does NOT flag adjacent bands', () => {
    expect(rowOverlaps([r('', ''), r('18', '29'), r('30', '44')])).toEqual([])
  })

  it('reports several pairs, each in row terms', () => {
    expect(rowOverlaps([r('', ''), r('0', '10'), r('5', '20'), r('15', '30')]))
      .toEqual([[1, 2], [2, 3]])
  })

  it('an all-blank list has nothing to say', () => {
    expect(rowOverlaps([r('', ''), r('', '')])).toEqual([])
  })
})

describe('#863 — describeRow names a row so two rows cannot share a name', () => {
  const r = (lo: string, hi: string, output = 'x'): RangeRow => ({ lo, hi, output })

  it('gives two IDENTICAL bands two different names', () => {
    const rows = [r('18', '29'), r('18', '29')]
    expect(describeRow(rows, 0)).not.toBe(describeRow(rows, 1))
  })

  it('carries the bounds when the row has them', () => {
    expect(describeRow([r('18', '29')], 0)).toBe('range 1 (18 to 29)')
  })

  it('🔴 does not call a BLANK row "any value" — that means unbounded', () => {
    expect(describeRow([r('', '')], 0)).toBe('range 1')
  })

  it('falls back to the ordinal for a half-typed bound too', () => {
    expect(describeRow([r('abc', '40')], 0)).toBe('range 1')
  })
})

describe('describeRange', () => {
  it.each([
    [{ lo: 18, hi: 29, output: 'x' }, '18 to 29'],
    [{ lo: 45, hi: null, output: 'x' }, '45 and above'],
    [{ lo: null, hi: 17, output: 'x' }, '17 and below'],
    [{ lo: 65, hi: 65, output: 'x' }, '65'],
  ] as [RecodeRange, string][])('describes %o as "%s"', (band, expected) => {
    expect(describeRange(band)).toBe(expected)
  })
})

describe('🔴 the CROSS-LANGUAGE contract', () => {
  /**
   * Both matchers execute the SAME table —
   * `backend/tests/fixtures/recode_range_cases.json`, which the Python suite
   * also runs (`test_recode_ranges.py::TestTheCrossLanguageContract`).
   *
   * Two implementations of one rule is the #542b shape, and a case table living
   * separately in each suite would drift the first time somebody fixed one
   * side. Reading one file means a divergence fails in whichever language
   * changed.
   *
   * ⚠️ `expected: null` in the fixture is each language's "no match": `None` in
   * Python, `undefined` here. Each suite asserts its own spelling — mapping
   * null to undefined is the translation, not a fudge.
   */
  const fixture = JSON.parse(
    readFileSync(
      join(__dirname, '../../../backend/tests/fixtures/recode_range_cases.json'),
      'utf8',
    ),
  ) as { cases: { name: string; value: string; ranges: RecodeRange[]; expected: unknown }[] }

  it('read the shared fixture (a scan that resolves to nothing passes by finding nothing)', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(25)
  })

  it('🔴 #862 — the table covers the cell shapes that hid a 16-case divergence', () => {
    // A floor is a weak guard: it notices truncation and nothing else. This
    // names the PROPERTY that was missing — the table had no glyph-bearing and
    // no radix cell, so both suites passed while the two parsers disagreed on
    // every currency and percent value. Keep it in step with the Python twin.
    const values = fixture.cases.map(c => c.value)
    expect(values.some(v => /[$€£¥%]/.test(v))).toBe(true)
    expect(values.some(v => /^0[xbo]/i.test(v))).toBe(true)
  })

  it.each(fixture.cases.map(c => [c.name, c] as const))('%s', (_name, c) => {
    const expected = c.expected === null ? undefined : c.expected
    expect(resolveRangeOutput(c.value, c.ranges)).toBe(expected)
  })

  it('the table could FAIL — it contains both matches and non-matches', () => {
    expect(fixture.cases.some(c => c.expected !== null)).toBe(true)
    expect(fixture.cases.some(c => c.expected === null)).toBe(true)
  })
})
