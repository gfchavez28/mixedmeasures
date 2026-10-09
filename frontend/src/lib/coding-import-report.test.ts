import { describe, it, expect } from 'vitest'
import {
  CODING_IMPORT_REASONS, CODING_IMPORT_REASON_LABEL, problemsCsv, problemsFilename,
  reasonLabel, reasonSummary,
} from './coding-import-report'

describe('the reason vocabulary', () => {
  it('has words for every reason and a reason for every word', () => {
    // The Python side (`test_coding_import.py`) holds this list to the server's.
    expect(Object.keys(CODING_IMPORT_REASON_LABEL).sort()).toEqual([...CODING_IMPORT_REASONS].sort())
  })

  it('a reason from a NEWER server reads as its own words, never blank', () => {
    expect(reasonLabel('duplicate_row')).toBe('repeats an earlier row')
    expect(reasonLabel('some_new_reason')).toBe('some new reason')
  })

  it('summarises largest first, in words', () => {
    expect(reasonSummary({ duplicate_row: 1, unit_not_found: 3 }))
      .toBe('no such passage or record (3) · repeats an earlier row (1)')
    expect(reasonSummary({ unit_not_found: 1200 })).toBe('no such passage or record (1,200)')
  })

  it('#1089 — the count follows the label, so a label that is a phrase still reads', () => {
    // The count-first shape printed "2 two different ratings" and "4 coder not
    // imported": the labels are written to stand alone (the CSV's Reason column
    // prints them with no count), so the SHAPE carries the count, not the words.
    expect(reasonSummary({ rating_conflict_in_file: 2 })).toBe('two different ratings (2)')
    expect(reasonSummary({ set_conflict_in_file: 2 })).toBe('two values of one set (2)')
    expect(reasonSummary({ coder_skipped: 4 })).toBe('coder not imported (4)')
    for (const reason of CODING_IMPORT_REASONS) {
      expect(reasonSummary({ [reason]: 2 })).toBe(`${reasonLabel(reason)} (2)`)
    }
  })
})

describe('the downloadable list', () => {
  it('carries EVERY row, defanged — a detail quoting the file can begin with a formula', () => {
    const csv = problemsCsv([
      { line: 2, reason: 'code_not_found', detail: '=HYPERLINK("x")' },
      { line: 3, reason: 'unit_not_found', detail: 'Nothing is identified by “a, b”.' },
    ])
    expect(csv.startsWith('﻿')).toBe(true)
    const lines = csv.slice(1).split('\r\n')
    expect(lines[0]).toBe('Line,Reason,Why')
    expect(lines[1]).toBe('2,no such code,"\'=HYPERLINK(""x"")"')
    expect(lines[2]).toBe('3,no such passage or record,"Nothing is identified by “a, b”."')
  })

  it('is named after the file that was checked', () => {
    expect(problemsFilename('model run 3.csv')).toBe('model run 3 - rows not imported.csv')
    expect(problemsFilename(undefined)).toBe('codings - rows not imported.csv')
  })
})
