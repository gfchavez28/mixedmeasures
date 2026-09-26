import { describe, expect, it } from 'vitest'
import {
  elapsedNote, fillFraction, isOverEstimate, stillWorkingMessage,
} from './elapsed-progress'
import { estimatedMergeSeconds, MIN_MERGE_ESTIMATE_SECONDS } from './merge-estimate'

describe('fillFraction', () => {
  it('never claims to be finished, however long past the estimate', () => {
    expect(fillFraction(0, 20)).toBe(0)
    expect(fillFraction(20, 20)).toBeLessThan(0.92)
    expect(fillFraction(10_000, 20)).toBeLessThanOrEqual(0.92)
  })

  it('keeps moving after the estimate is passed', () => {
    expect(fillFraction(40, 20)).toBeGreaterThan(fillFraction(25, 20))
  })

  it('draws nothing without an estimate', () => {
    expect(fillFraction(10, 0)).toBe(0)
  })
})

describe('the words beside the fill', () => {
  it('say elapsed time and name the estimate as usual, not as a promise', () => {
    expect(elapsedNote(7.4, 16, false)).toBe('7s elapsed — usually about 16s for a file this size.')
  })

  it('admit when the usual time has been passed', () => {
    expect(isOverEstimate(18, 16)).toBe(false)
    expect(isOverEstimate(19, 16)).toBe(true)
    expect(elapsedNote(30, 16, true)).toMatch(/longer than the usual ~16s .* Still working\./)
    expect(stillWorkingMessage(30, true)).toBe(
      'Still working — 30 seconds elapsed. This is taking longer than usual for this file.',
    )
  })
})

describe('estimatedMergeSeconds (#1015)', () => {
  it('is calibrated on the realistic corpus, which is the slower one per MB', () => {
    // pd_audit + a 40,000 × 30 survey: 9.09 MB merged in 27.1 s at the endpoint.
    expect(estimatedMergeSeconds(9_090_000)).toBe(27)
    // A synthetic 25.6 MB archive took 41.6 s; the estimate may run long, never short.
    expect(estimatedMergeSeconds(25_600_000)).toBeGreaterThanOrEqual(42)
  })

  it('never states less than the floor — even a tiny file writes a whole safety copy', () => {
    expect(estimatedMergeSeconds(0)).toBe(MIN_MERGE_ESTIMATE_SECONDS)
    expect(estimatedMergeSeconds(50_000)).toBe(MIN_MERGE_ESTIMATE_SECONDS)
  })
})
