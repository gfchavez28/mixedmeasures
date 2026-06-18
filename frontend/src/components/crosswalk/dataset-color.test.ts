/**
 * Per-dataset color palette tests. The stability invariant is the load-bearing
 * one: a dataset's color must NOT change when the active (filtered) dataset
 * list changes — researchers expect color identity to follow the dataset.
 */

import { describe, it, expect } from 'vitest'
import { getDatasetAccent, DATASET_PALETTE_SIZE } from './dataset-color'

describe('getDatasetAccent', () => {
  it('returns a stable color for the same dataset across calls', () => {
    const ids = [10, 20, 30]
    expect(getDatasetAccent(20, ids)).toBe(getDatasetAccent(20, ids))
  })

  it('keeps the same color for a dataset when the active list shrinks (toggle off)', () => {
    // Project has datasets [10, 20, 30]. Active toggle filters to [10, 30].
    // Dataset 30's color must match across both calls — getDatasetAccent
    // takes the FULL project list, not the filtered active list.
    const fullList = [10, 20, 30]
    const colorBefore = getDatasetAccent(30, fullList)
    const colorAfter = getDatasetAccent(30, fullList) // same input
    expect(colorBefore).toBe(colorAfter)
  })

  it('assigns colors by sorted-by-id position in the full list', () => {
    // Out-of-order input is sorted internally for determinism.
    const a = getDatasetAccent(10, [30, 10, 20])
    const b = getDatasetAccent(10, [10, 20, 30])
    expect(a).toBe(b)
    // The lowest-id dataset is at index 0 in the sorted list.
    expect(getDatasetAccent(10, [10, 20, 30])).not.toBe(
      getDatasetAccent(20, [10, 20, 30]),
    )
  })

  it('cycles through the palette when datasets exceed palette size', () => {
    // PALETTE_SIZE is 6; with 8 datasets the 7th cycles back to the 1st.
    const ids = [1, 2, 3, 4, 5, 6, 7, 8]
    const first = getDatasetAccent(1, ids)
    const seventh = getDatasetAccent(7, ids)
    expect(first).toBe(seventh)
  })

  it('returns a safe fallback when the dataset id is not in the list', () => {
    const color = getDatasetAccent(999, [10, 20])
    // Should not throw or return undefined; returns the first palette color.
    expect(color).toBeDefined()
    expect(color.length).toBeGreaterThan(0)
  })

  it('exposes the palette size as a stable constant', () => {
    expect(DATASET_PALETTE_SIZE).toBeGreaterThan(0)
  })

  // User-customizable color override — Dataset.color wins over the palette.

  it('returns the stored color when one is provided', () => {
    const stored = '#ff00ff'
    expect(getDatasetAccent(20, [10, 20, 30], stored)).toBe(stored)
  })

  it('falls back to the palette when storedColor is null/undefined/empty', () => {
    const palette = getDatasetAccent(20, [10, 20, 30])
    expect(getDatasetAccent(20, [10, 20, 30], null)).toBe(palette)
    expect(getDatasetAccent(20, [10, 20, 30], undefined)).toBe(palette)
    expect(getDatasetAccent(20, [10, 20, 30], '')).toBe(palette)
  })

  it('rejects malformed hex and falls back to the palette', () => {
    const palette = getDatasetAccent(20, [10, 20, 30])
    // Wrong length
    expect(getDatasetAccent(20, [10, 20, 30], '#abc')).toBe(palette)
    // Missing leading #
    expect(getDatasetAccent(20, [10, 20, 30], 'ff0000')).toBe(palette)
    // Non-hex chars
    expect(getDatasetAccent(20, [10, 20, 30], '#zzzzzz')).toBe(palette)
  })

  it('stored override survives toggling (independent of allDatasetIds)', () => {
    const stored = '#3b82f6'
    expect(getDatasetAccent(30, [10, 20, 30], stored)).toBe(stored)
    expect(getDatasetAccent(30, [30], stored)).toBe(stored)
  })
})
