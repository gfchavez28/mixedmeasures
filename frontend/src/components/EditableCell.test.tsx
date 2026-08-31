/**
 * computeDisplayValue — the dataset-grid cell display logic.
 *
 * #561: the .sav adapter's dedupe suffix (#541a) bakes the code into the
 * label ("Agree (1)"), and the grid's own `(value)` annotation then rendered
 * "Agree (1) (1)". The annotation is suppressed ONLY when the label's
 * trailing (N) equals the displayed numeric — when they differ (REVERSE, or
 * a label whose parenthetical is unrelated) it carries information and stays.
 */
import { describe, it, expect } from 'vitest'
import { computeDisplayValue } from './EditableCell'
import type { DatasetColumn, DatasetValueCell, RecodeDefinitionSummary } from '@/lib/api'

const column = { id: 1, column_type: 'ordinal' } as unknown as DatasetColumn

const cell = (text: string): DatasetValueCell =>
  ({ id: 1, value_text: text, value_numeric: null }) as unknown as DatasetValueCell

const def = (
  mapping: Record<string, number | string>,
  recodeType: 'scale_map' | 'reverse' | 'category_group' = 'scale_map',
): RecodeDefinitionSummary =>
  ({
    id: 1,
    recode_type: recodeType,
    mapping,
    exclude_values: [],
  }) as unknown as RecodeDefinitionSummary

describe('computeDisplayValue — #561 double-parenthesis suppression', () => {
  it('suppresses the annotation when the label already ends in (mapped value)', () => {
    // The #541a dedupe shape: "Agree (1)" → 1, "Agree (2)" → 2
    const d = def({ 'Agree (1)': 1, 'Agree (2)': 2 })
    expect(computeDisplayValue(cell('Agree (1)'), column, d).display).toBe('Agree (1)')
    expect(computeDisplayValue(cell('Agree (2)'), column, d).display).toBe('Agree (2)')
  })

  it('keeps the annotation when the trailing (N) differs from the displayed value', () => {
    // The differing case (e.g. a reversed display where the label carries the
    // forward code but the cell shows the reflected one): the annotation
    // disambiguates and must stay — per the locked decision, suppress ONLY
    // on exact equality.
    const differing = def({ 'Agree (1)': 5 })
    expect(computeDisplayValue(cell('Agree (1)'), column, differing).display).toBe('Agree (1) (5)')
  })

  it('keeps the annotation for plain labels (no trailing parenthetical)', () => {
    const d = def({ Agree: 2 })
    const out = computeDisplayValue(cell('Agree'), column, d)
    expect(out.display).toBe('Agree (2)')
    expect(out.isNumeric).toBe(true)
    expect(out.numericValue).toBe(2)
  })

  it('does not suppress on a non-numeric parenthetical', () => {
    const d = def({ 'Agree (a)': 1 })
    expect(computeDisplayValue(cell('Agree (a)'), column, d).display).toBe('Agree (a) (1)')
  })

  it('suppresses for decimal-rendered codes too', () => {
    const d = def({ 'Agree (1.5)': 1.5 })
    expect(computeDisplayValue(cell('Agree (1.5)'), column, d).display).toBe('Agree (1.5)')
  })

  it('tooltip still spells out raw → recoded even when suppressed', () => {
    const d = def({ 'Agree (1)': 1 })
    const out = computeDisplayValue(cell('Agree (1)'), column, d)
    expect(out.titleText).toBe('raw Agree (1) → recoded 1')
  })
})

describe('computeDisplayValue — #578 reverse reflects the stored forward code', () => {
  // A REVERSE def stores FORWARD codes; the displayed/scored value is the
  // reflection (min+max − code), matching value_numeric. offset = 1+5 = 6.
  const rev = def({ 'Strongly Disagree': 1, 'Neutral': 3, 'Strongly Agree': 5 }, 'reverse')

  it('reflects the highest response to the lowest score', () => {
    const out = computeDisplayValue(cell('Strongly Agree'), column, rev)
    expect(out.numericValue).toBe(1)   // 6 − 5
    expect(out.display).toBe('Strongly Agree (1)')
  })

  it('reflects the lowest response to the highest score', () => {
    const out = computeDisplayValue(cell('Strongly Disagree'), column, rev)
    expect(out.numericValue).toBe(5)   // 6 − 1
    expect(out.display).toBe('Strongly Disagree (5)')
  })

  it('leaves the midpoint unchanged', () => {
    expect(computeDisplayValue(cell('Neutral'), column, rev).numericValue).toBe(3)
  })

  it('a scale_map with the SAME mapping is NOT reflected (verbatim)', () => {
    const sm = def({ 'Strongly Disagree': 1, 'Strongly Agree': 5 }, 'scale_map')
    expect(computeDisplayValue(cell('Strongly Agree'), column, sm).numericValue).toBe(5)
  })

  it('reflects a bare-numeric reverse cell and keeps the disambiguating annotation', () => {
    // 0-based/gapped codes: offset = 2+10 = 12; "10" scores 2.
    const bare = def({ '2': 2, '6': 6, '10': 10 }, 'reverse')
    const out = computeDisplayValue(cell('10'), column, bare)
    expect(out.numericValue).toBe(2)
    expect(out.display).toBe('10 (2)')
  })
})

describe('#823(d) — the grid resolves RANGE bands, not just mapping keys', () => {
  /**
   * 🔴 The consumer test, not the predicate test. `lib/recode-ranges.test.ts`
   * proves `resolveRangeOutput` is right (against a fixture the Python suite
   * runs too); this proves the GRID actually calls it.
   *
   * Without it the Data view renders a banded cell as unmapped plain text while
   * `value_numeric` holds the band's code — the #578 display-vs-storage drift,
   * on the one surface a researcher checks a recode against. The project's own
   * rule: a component test proves the COMPONENT, not the MOUNT — here the
   * component IS the consumer, so this is the mount.
   */
  const banded = (
    recodeType: 'scale_map' | 'category_group' | 'reverse' = 'scale_map',
    mapping: Record<string, number | string> = {},
  ): RecodeDefinitionSummary =>
    ({
      id: 1,
      recode_type: recodeType,
      mapping,
      exclude_values: [],
      ranges: [
        { lo: 18, hi: 29, output: 1 },
        { lo: 30, hi: null, output: 2 },
      ],
    }) as unknown as RecodeDefinitionSummary

  it('resolves a cell through a band when no mapping key matches', () => {
    expect(computeDisplayValue(cell('22'), column, banded()).numericValue).toBe(1)
    expect(computeDisplayValue(cell('80'), column, banded()).numericValue).toBe(2)
  })

  it('🔴 lets an explicit mapping key beat a band, as the backend does', () => {
    const d = banded('scale_map', { '22': 9 })
    expect(computeDisplayValue(cell('22'), column, d).numericValue).toBe(9)
  })

  it('leaves a cell outside every band unmapped', () => {
    expect(computeDisplayValue(cell('4'), column, banded()).isNumeric).toBe(false)
  })

  it('🔴 derives the scale top from the BANDS when the mapping is empty', () => {
    // A pure-band rule has no mapping, so `Math.max(...[])` is -Infinity and the
    // intensity tint silently disappears — on exactly the rules that produce a
    // small ordered set of codes, where it reads best.
    expect(computeDisplayValue(cell('80'), column, banded()).maxValue).toBe(2)
  })

  it('never bands a REVERSE, which reflects its source instead', () => {
    expect(computeDisplayValue(cell('22'), column, banded('reverse')).isNumeric).toBe(false)
  })

  it('is unchanged for a definition carrying no bands at all', () => {
    // The old payload shape: `ranges` absent entirely.
    const d = def({ Agree: 1 })
    expect(computeDisplayValue(cell('Agree'), column, d).numericValue).toBe(1)
    expect(computeDisplayValue(cell('22'), column, d).isNumeric).toBe(false)
  })

  it('🔴 #861 — an EXCLUDED response is not banded, on this side either', () => {
    /**
     * This lens already ordered the channels correctly — the exclude check runs
     * before the mapping and the band — and the BACKEND did not, which is how
     * #861 was found: the grid said "excluded" while the server stored the
     * band's code. Both sides agree now, and this pins the client half so a
     * later tidy-up that moves the exclude test below the band cannot re-open it
     * silently.
     *
     * ⚠️ Per VALUE, not per definition — `30` is in the same open-topped band
     * and must still resolve. Without that half, "bands off whenever
     * `exclude_values` is non-empty" passes.
     */
    const d = { ...banded('scale_map'), exclude_values: ['22'] } as RecodeDefinitionSummary

    const excluded = computeDisplayValue(cell('22'), column, d)
    expect(excluded.isExcluded).toBe(true)
    expect(excluded.numericValue).toBeNull()

    expect(computeDisplayValue(cell('30'), column, d).numericValue).toBe(2)
  })
})
