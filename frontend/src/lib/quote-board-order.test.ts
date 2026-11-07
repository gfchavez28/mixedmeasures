/**
 * #1531 D99's amendment (1.5.9) — a drag keeps the places of the quotes the dragger cannot see.
 * The decided test: a saved order of five, two hidden, one drag; the two keep their positions.
 */
import { describe, it, expect } from 'vitest'
import { mergeVisibleOrder } from './quote-board-order'

describe('mergeVisibleOrder', () => {
  it('a saved order of five, two hidden, one drag: the hidden two keep their slots', () => {
    // Saved [1,2,3,4,5]; 2 and 4 are hidden, so the board shows [1,3,5]; 5 is dragged to the top.
    expect(mergeVisibleOrder([1, 2, 3, 4, 5], [5, 1, 3])).toEqual([5, 2, 1, 4, 3])
  })

  it('the old save (visible ids only) would have dropped them — the fixture tells the two apart', () => {
    const merged = mergeVisibleOrder([1, 2, 3, 4, 5], [5, 1, 3])
    expect(merged).not.toEqual([5, 1, 3])
    expect(merged.indexOf(2)).toBe(1)
    expect(merged.indexOf(4)).toBe(3)
  })

  it('a quote quoted since the order was saved follows, in the new order', () => {
    // 6 is new: the board appended it; the drag moved it ahead of 3.
    expect(mergeVisibleOrder([1, 2, 3], [1, 6, 3])).toEqual([1, 2, 6, 3])
  })

  it('nothing hidden: the saved order IS the new order', () => {
    expect(mergeVisibleOrder([1, 2, 3], [3, 1, 2])).toEqual([3, 1, 2])
  })

  it('no saved order yet (seeded from source order): the visible order is saved, as before', () => {
    expect(mergeVisibleOrder([], [2, 1])).toEqual([2, 1])
  })

  it('a duplicated saved id fills one slot, never two', () => {
    expect(mergeVisibleOrder([1, 1, 2], [2, 1])).toEqual([2, 1])
  })
})
