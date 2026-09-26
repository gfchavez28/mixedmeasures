import { describe, expect, it } from 'vitest'
import { describeAppendDuplicates } from './append-duplicates'

describe('describeAppendDuplicates (#1014)', () => {
  it('keeps the existing sentence when every duplicate is already in the dataset', () => {
    expect(describeAppendDuplicates({ duplicate_count: 3, in_file_duplicate_count: 0, total_rows: 12 }))
      .toBe('3 of 12 rows match existing responses')
  })

  it('never says a record repeated within the file matches an existing response', () => {
    const text = describeAppendDuplicates({ duplicate_count: 2, in_file_duplicate_count: 2, total_rows: 12 })
    expect(text).toBe('2 of 12 rows repeat an earlier row in this file')
    expect(text).not.toMatch(/existing/)
  })

  it('agrees each verb with its own count (found driving the page, 2026-09-24)', () => {
    expect(describeAppendDuplicates({ duplicate_count: 2, in_file_duplicate_count: 1, total_rows: 4 }))
      .toBe('2 of 4 rows are duplicates: 1 matches an existing response, 1 repeats an earlier row in this file')
    expect(describeAppendDuplicates({ duplicate_count: 4, in_file_duplicate_count: 2, total_rows: 9 }))
      .toBe('4 of 9 rows are duplicates: 2 match existing responses, 2 repeat an earlier row in this file')
  })

  it('names both kinds, and their counts add up to the total skipped', () => {
    expect(describeAppendDuplicates({ duplicate_count: 3, in_file_duplicate_count: 1, total_rows: 5 }))
      .toBe('3 of 5 rows are duplicates: 2 match existing responses, 1 repeats an earlier row in this file')
  })
})
