import { describe, it, expect } from 'vitest'
import {
  saturationAxisLabel,
  saturationCaveat,
  SATURATION_ORDERING_IMPORT_DATE,
} from './saturation-ordering'

/**
 * #708(i) — the saturation curve states what its x-axis is ordered by.
 *
 * The curve is entirely order-dependent, sources are ordered by IMPORT date,
 * and the backend docstring said so while the chart said nothing. The chart is
 * what goes in the report.
 */

describe('saturationAxisLabel', () => {
  it('names the ordering the server sent', () => {
    expect(saturationAxisLabel(SATURATION_ORDERING_IMPORT_DATE))
      .toMatch(/order they were added/)
  })

  it('says nothing when the payload names no ordering', () => {
    // An older result carries no `ordering` field. Captioning it with an
    // ordering we were not told is the confident-wrong-statement this module
    // exists to avoid — and the axis simply has no label, as before.
    for (const o of [undefined, null, '']) {
      expect(saturationAxisLabel(o)).toBeNull()
      expect(saturationCaveat(o)).toBeNull()
    }
  })

  it('says nothing for an ordering it does not recognise', () => {
    expect(saturationAxisLabel('fieldwork_date')).toBeNull()
  })
})

describe('saturationCaveat', () => {
  it('says the order is import order and that the curve depends on it', () => {
    const caveat = saturationCaveat(SATURATION_ORDERING_IMPORT_DATE)!
    // Both halves matter. "Ordered by import date" alone is a fact about the
    // axis; the reader needs to know it bears on the SATURATION CLAIM.
    expect(caveat).toMatch(/not necessarily the order fieldwork happened/)
    expect(caveat).toMatch(/plateau/)
  })
})
