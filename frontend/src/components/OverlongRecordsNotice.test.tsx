/**
 * #985 — the notice for rows with more values than the file has column
 * headings. The words and the links live in this one component, so both
 * wizards and both moments (before the import, after it) say the same thing.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router'
import { OverlongRecordsNotice, overlongPlace } from './OverlongRecordsNotice'
import type { OverlongRecords } from '@/lib/api'

afterEach(cleanup)

const report = (over: Partial<OverlongRecords> = {}): OverlongRecords => ({
  count: 1,
  header_width: 3,
  examples: [{ record: 2, line: 3, cells: 4, row_id: null }],
  ...over,
})

function show(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>)
}

describe('OverlongRecordsNotice', () => {
  it('says nothing when there is nothing to say — or no report at all', () => {
    const { container } = show(
      <>
        <OverlongRecordsNotice report={undefined} stage="before" newDataset />
        <OverlongRecordsNotice report={report({ count: 0, examples: [] })} stage="before" newDataset />
      </>,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('before an import: what is wrong, why, what to do, and where', () => {
    show(<OverlongRecordsNotice report={report()} stage="before" newDataset />)
    const note = screen.getByRole('note')
    expect(note).toHaveTextContent('1 row in this file has more values than there are column headings.')
    expect(note).toHaveTextContent('a comma that was not wrapped in quotes')
    expect(note).toHaveTextContent('import it as it is and fix that record afterwards')
    expect(note).toHaveTextContent('Line 3 (record 2) — 4 values for 3 columns')
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('an append names lines only — its records take the dataset’s next numbers', () => {
    show(<OverlongRecordsNotice report={report()} stage="before" newDataset={false} />)
    const note = screen.getByRole('note')
    expect(note).toHaveTextContent('append it as it is')
    expect(note).toHaveTextContent('Line 3 — 4 values for 3 columns')
    expect(note).not.toHaveTextContent('record 2')
  })

  it('after an import: each record links to its row in the Data view', () => {
    show(
      <OverlongRecordsNotice
        report={report({
          count: 2,
          examples: [
            { record: 2, line: 3, cells: 4, row_id: 77 },
            { record: 9, line: 10, cells: 5, row_id: null },
          ],
        })}
        stage="after"
        newDataset
        datasetPath="/projects/1/datasets/9"
      />,
    )
    expect(screen.getByRole('note')).toHaveTextContent(
      '2 records had more values than there are column headings, so some of their values are in the wrong columns.',
    )
    const link = screen.getByRole('link', { name: 'Line 3 (record 2)' })
    expect(link).toHaveAttribute('href', '/projects/1/datasets/9?row=77')
    // A record that became no row (an append that skipped it as a duplicate)
    // is named, never linked.
    expect(screen.getAllByRole('link')).toHaveLength(1)
    expect(screen.getByRole('note')).toHaveTextContent('Line 10 (record 9) — 5 values for 3 columns')
  })

  it('says how many more there are when the examples stop', () => {
    show(<OverlongRecordsNotice report={report({ count: 1234 })} stage="before" newDataset />)
    expect(screen.getByRole('note')).toHaveTextContent('…and 1,233 more.')
  })

  it('has a one-line form for the multi-file result list', () => {
    show(<OverlongRecordsNotice report={report({ count: 3 })} stage="after" newDataset compact />)
    expect(screen.queryByRole('note')).toBeNull()
    expect(document.body).toHaveTextContent('· 3 rows with extra values')
  })

  it('overlongPlace', () => {
    const e = { record: 2, line: 3, cells: 4, row_id: null }
    expect(overlongPlace(e, true)).toBe('Line 3 (record 2)')
    expect(overlongPlace(e, false)).toBe('Line 3')
  })
})
