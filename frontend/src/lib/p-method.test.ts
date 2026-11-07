/**
 * #1326 STAT-12 (D58) — the fifteenth stated-basis member's reader.
 * The constants' equality with the server is pinned from the Python side
 * (`backend/tests/test_mann_whitney_p_method.py::TestCrossLanguageContract`).
 */
import { describe, expect, it } from 'vitest'
import {
  P_METHOD_EXACT,
  P_METHOD_NORMAL_APPROXIMATION,
  pMethodFooter,
  pMethodShort,
} from './p-method'

describe('pMethodShort', () => {
  it('names each method', () => {
    expect(pMethodShort(P_METHOD_EXACT)).toBe('exact p')
    expect(pMethodShort(P_METHOD_NORMAL_APPROXIMATION)).toMatch(/normal approximation/)
  })

  it('says nothing for an absent or unknown method — never a guess', () => {
    expect(pMethodShort(null)).toBeNull()
    expect(pMethodShort(undefined)).toBeNull()
    expect(pMethodShort('permutation')).toBeNull()
  })
})

describe('pMethodFooter', () => {
  it('one method across the rows is that method', () => {
    expect(pMethodFooter([P_METHOD_EXACT, P_METHOD_EXACT])).toMatch(/^exact p/)
    expect(pMethodFooter([P_METHOD_NORMAL_APPROXIMATION])).toMatch(/continuity correction/)
  })

  it('rows that differ say both, and that each p says which', () => {
    const s = pMethodFooter([P_METHOD_EXACT, P_METHOD_NORMAL_APPROXIMATION])!
    expect(s).toMatch(/exact p/)
    expect(s).toMatch(/normal approximation/)
    expect(s).toMatch(/each p says which/)
  })

  it('is null when no row states a known method', () => {
    expect(pMethodFooter([])).toBeNull()
    expect(pMethodFooter([null, undefined, 'mystery'])).toBeNull()
  })

  it('an unknown method beside a known one does not count as a second method', () => {
    expect(pMethodFooter([P_METHOD_EXACT, 'mystery'])).toMatch(/^exact p/)
  })
})
