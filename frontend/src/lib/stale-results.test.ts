import { describe, it, expect } from 'vitest'
import { staleResultsNote } from './stale-results'

/**
 * #958 §6 — what the app says about a result that may not be this build's.
 *
 * ⚠️ **There is ONE sentence here, not two.** The second fed an amber notice on the
 * quantitative chart and was removed 2026-09-21: that surface reads its metrics from the
 * quick-compute response, which recomputes stale metrics before answering, so the notice
 * could never fire. See the module's own header before adding it back.
 */

describe('staleResultsNote (the import / duplicate toast)', () => {
  it('says nothing when nothing was marked', () => {
    // 🔴 The common case by a wide margin: a merge imports no metrics, and most
    // projects save none. A caller gating on the FIELD rather than the VALUE would
    // announce "0 saved results were marked out of date" on nearly every import.
    expect(staleResultsNote(0)).toBeNull()
  })

  it('says nothing for a negative or non-finite count', () => {
    expect(staleResultsNote(-1)).toBeNull()
    expect(staleResultsNote(Number.NaN)).toBeNull()
  })

  it('uses the singular for exactly one', () => {
    expect(staleResultsNote(1)).toContain('1 saved result was')
  })

  it('uses the plural above one', () => {
    expect(staleResultsNote(4)).toContain('4 saved results were')
  })

  it('names the act the researcher has to take', () => {
    expect(staleResultsNote(2)).toContain('Recompute')
  })

  it('keeps the metrics-only sentence word for word when no test was marked', () => {
    expect(staleResultsNote(2, 0)).toBe(staleResultsNote(2))
  })

  it('🔴 counts saved TESTS too, which used to arrive reading as current (#1039 a)', () => {
    expect(staleResultsNote(0, 1)).toMatch(/^1 saved test was marked out of date/)
    expect(staleResultsNote(0, 3)).toMatch(/^3 saved tests were marked out of date/)
    expect(staleResultsNote(2, 1)).toMatch(/^2 saved results and 1 saved test were marked/)
    expect(staleResultsNote(1, 2)).toMatch(/^1 saved result and 2 saved tests were marked/)
    expect(staleResultsNote(0, 2)).toContain('Recompute')
  })

  it('says nothing for a non-finite or negative test count either', () => {
    expect(staleResultsNote(0, -1)).toBeNull()
    expect(staleResultsNote(0, Number.NaN)).toBeNull()
  })
})
