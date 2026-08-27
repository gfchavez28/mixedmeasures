import { describe, it, expect } from 'vitest'
import {
  splitBasisLabel,
  splitBasisDetail,
  describeHalves,
  SPLIT_BASIS_ODD_EVEN_DOMAIN_ORDER,
} from './split-basis'

/**
 * #710 — split-half reliability states which split produced it.
 *
 * The coefficient is split-DEPENDENT by construction, and until now the split
 * was odd/even over `DatasetColumn.id` — an order the researcher sees nowhere.
 */

describe('splitBasisLabel', () => {
  it('names the basis the server sent', () => {
    expect(splitBasisLabel(SPLIT_BASIS_ODD_EVEN_DOMAIN_ORDER)).toBe('odd/even by item order')
  })

  it('says nothing for a result that predates the field', () => {
    // A pre-#710 result was split over an internal column order. Labelling it
    // with the current basis would assert a split that did not happen — about a
    // number still on screen.
    for (const b of [undefined, null, '']) {
      expect(splitBasisLabel(b)).toBeNull()
      expect(splitBasisDetail(b)).toBeNull()
    }
  })

  it('says nothing for a basis it does not recognise', () => {
    // Rather than inventing a description for a newer backend's value — the
    // `describeUndefined` rule. The Python-side contract test is what makes this
    // silence detectable at build time.
    expect(splitBasisLabel('random_splits_averaged')).toBeNull()
  })

  it('explains why the order matters, since the researcher can change it', () => {
    expect(splitBasisDetail(SPLIT_BASIS_ODD_EVEN_DOMAIN_ORDER)).toMatch(/reordering its items/)
    expect(splitBasisDetail(SPLIT_BASIS_ODD_EVEN_DOMAIN_ORDER)).toMatch(/different coefficient/)
  })
})

describe('describeHalves', () => {
  it('names the items in each half', () => {
    // The coefficient cannot be judged without knowing what was split.
    expect(describeHalves(['Q1', 'Q3'], ['Q2', 'Q4'])).toBe('Q1, Q3 vs Q2, Q4')
  })

  it('returns null when either half is missing', () => {
    expect(describeHalves([], ['Q2'])).toBeNull()
    expect(describeHalves(['Q1'], undefined)).toBeNull()
    expect(describeHalves(undefined, undefined)).toBeNull()
  })
})
