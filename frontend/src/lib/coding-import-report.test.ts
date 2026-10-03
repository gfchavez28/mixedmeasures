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
      .toBe('3 no such passage or record · 1 repeats an earlier row')
    expect(reasonSummary({ unit_not_found: 1200 })).toBe('1,200 no such passage or record')
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
