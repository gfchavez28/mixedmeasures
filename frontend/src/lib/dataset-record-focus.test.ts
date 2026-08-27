import { describe, it, expect, vi, beforeEach } from 'vitest'
import { findRecordCell, offsetForRecordNumber, FOUND_FLASH_CLASS, revealRecordCell } from './dataset-record-focus'

/**
 * The DOM contract these tests pin lives in two components: `DataRow` writes
 * `data-row-id` on its `<tr>`, `DatasetView` writes `data-col-id` on each
 * `<col>`. Nothing type-checks that pair, so it is asserted here against a
 * table built the same shape the grid renders — two leading fixed columns
 * (record header + participant) that carry no `data-col-id`, then the data
 * columns in colgroup order.
 */
function buildTable(rowIds: number[], columnIds: number[]): HTMLTableElement {
  const table = document.createElement('table')
  const colgroup = document.createElement('colgroup')
  // The two fixed leading columns, deliberately without a data-col-id — they
  // are what makes the index an OFFSET rather than a plain position.
  colgroup.appendChild(document.createElement('col'))
  colgroup.appendChild(document.createElement('col'))
  for (const id of columnIds) {
    const col = document.createElement('col')
    col.setAttribute('data-col-id', String(id))
    colgroup.appendChild(col)
  }
  table.appendChild(colgroup)

  const tbody = document.createElement('tbody')
  for (const rowId of rowIds) {
    const tr = document.createElement('tr')
    tr.setAttribute('data-row-id', String(rowId))
    tr.appendChild(document.createElement('th'))
    tr.appendChild(document.createElement('td'))
    for (const id of columnIds) {
      const td = document.createElement('td')
      td.setAttribute('data-testid', `cell-${rowId}-${id}`)
      tr.appendChild(td)
    }
    tbody.appendChild(tr)
  }
  table.appendChild(tbody)
  return table
}

describe('findRecordCell', () => {
  it('finds the cell where a row and a column meet', () => {
    const table = buildTable([10, 11, 12], [5, 6, 7])
    const hit = findRecordCell(table, 11, 6)
    expect(hit).not.toBeNull()
    expect(hit!.row.getAttribute('data-row-id')).toBe('11')
    expect(hit!.cell!.getAttribute('data-testid')).toBe('cell-11-6')
  })

  it('offsets past the leading fixed columns rather than using the column position', () => {
    // The regression: `cells[0]` is the record header, not the first variable.
    // An implementation that ignored the two id-less `<col>`s would return the
    // record header for the first data column and be off by two everywhere.
    const table = buildTable([10], [5, 6, 7])
    expect(findRecordCell(table, 10, 5)!.cell!.getAttribute('data-testid')).toBe('cell-10-5')
    expect(findRecordCell(table, 10, 7)!.cell!.getAttribute('data-testid')).toBe('cell-10-7')
  })

  it('returns null when the page does not hold the row', () => {
    const table = buildTable([10, 11], [5])
    expect(findRecordCell(table, 999, 5)).toBeNull()
  })

  it('returns the row with a null cell when the column is gone', () => {
    // A column deleted since the link was made: the record is still the useful
    // answer, so this must not degrade to "not found".
    const table = buildTable([10], [5, 6])
    const hit = findRecordCell(table, 10, 4242)
    expect(hit!.row.getAttribute('data-row-id')).toBe('10')
    expect(hit!.cell).toBeNull()
  })

  it('returns the row with a null cell when no column was requested', () => {
    const table = buildTable([10], [5])
    const hit = findRecordCell(table, 10, null)
    expect(hit!.cell).toBeNull()
  })
})

describe('revealRecordCell', () => {
  beforeEach(() => {
    // jsdom implements no layout and no scrolling.
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('scrolls the CELL, not the row — the grid scrolls in both axes', () => {
    const table = buildTable([10], [5, 6, 7])
    revealRecordCell(table, 10, 7)
    const cell = table.querySelector('[data-testid="cell-10-7"]')!
    expect(cell.scrollIntoView).toHaveBeenCalled()
  })

  it('marks the cell and the cleanup removes the mark', () => {
    vi.useFakeTimers()
    const table = buildTable([10], [5])
    const cleanup = revealRecordCell(table, 10, 5)
    const cell = table.querySelector('[data-testid="cell-10-5"]')!
    expect(cell.classList.contains(FOUND_FLASH_CLASS)).toBe(true)
    cleanup!()
    expect(cell.classList.contains(FOUND_FLASH_CLASS)).toBe(false)
    vi.useRealTimers()
  })

  it('returns null when the row is not on this page, so the caller can tell', () => {
    const table = buildTable([10], [5])
    expect(revealRecordCell(table, 999, 5)).toBeNull()
  })
})

describe('offsetForRecordNumber', () => {
  it('lands record 1 on the first page', () => {
    expect(offsetForRecordNumber(1, 200, 75699)).toBe(0)
  })

  it('puts the last record of a page on that page, not the next', () => {
    // The off-by-one that a naive `Math.floor(n / size) * size` gets wrong.
    expect(offsetForRecordNumber(200, 200, 75699)).toBe(0)
    expect(offsetForRecordNumber(201, 200, 75699)).toBe(200)
  })

  it('agrees with the server for the measured GSS case', () => {
    // Record 10,000 resolved to offset 9,800 against the real dataset.
    expect(offsetForRecordNumber(10000, 200, 75699)).toBe(9800)
  })

  it('clamps past the end rather than refusing — 99999 plainly means "the end"', () => {
    expect(offsetForRecordNumber(99999, 200, 75699)).toBe(75600)
  })

  it('refuses input that is not a record number', () => {
    expect(offsetForRecordNumber(0, 200, 100)).toBeNull()
    expect(offsetForRecordNumber(-5, 200, 100)).toBeNull()
    expect(offsetForRecordNumber(1.5, 200, 100)).toBeNull()
    expect(offsetForRecordNumber(NaN, 200, 100)).toBeNull()
  })

  it('refuses on an empty dataset instead of returning offset 0', () => {
    expect(offsetForRecordNumber(1, 200, 0)).toBeNull()
  })
})
