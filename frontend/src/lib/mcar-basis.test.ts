/**
 * #707(b) — Little's MCAR test states which estimates produced it.
 */
import { describe, it, expect } from 'vitest'
import { MCAR_ESTIMATOR_AVAILABLE_CASE, describeMcarEstimator } from './mcar-basis'

describe('describeMcarEstimator', () => {
  /**
   * The whole point of the field: Little's test is defined over EM estimates and
   * this one is not, so the sentence has to name BOTH — what was used and what the
   * test is defined over. Naming only the first reads as a detail; naming both is
   * what tells a researcher the p-value is approximate.
   */
  it('names the estimator used AND the one the test is defined over', () => {
    const text = describeMcarEstimator(MCAR_ESTIMATOR_AVAILABLE_CASE)
    expect(text).toMatch(/available cases/i)
    expect(text).toMatch(/EM/)
    expect(text).toMatch(/approximate/i)
  })

  /**
   * An older stored payload predates the field. Inventing a description of a
   * computation we cannot identify is the failure this module exists to prevent,
   * so absence is silence — and the caller renders nothing rather than an empty row.
   */
  it('says nothing when the basis is absent', () => {
    expect(describeMcarEstimator(undefined)).toBeNull()
    expect(describeMcarEstimator(null)).toBeNull()
    expect(describeMcarEstimator('')).toBeNull()
  })

  /**
   * 🔴 The load-bearing case. An EM loop is the deferred half of #707(b); when it
   * lands, a newer server sends a value this build does not know. It must NOT be
   * quietly described as available-case — that would be a false statement about how
   * the number was produced, and worse than saying nothing.
   */
  it('reports an unknown estimator verbatim rather than relabelling it', () => {
    const text = describeMcarEstimator('em')
    expect(text).toContain('em')
    expect(text).not.toMatch(/available cases/i)
  })
})
