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
})
