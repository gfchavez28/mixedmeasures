/**
 * #985 — both import wizards SHOW the too-long-rows report the server sends,
 * before the import (where the file can still be corrected) and after it (with
 * a link to each record's row). Rendered, not scanned: the report crosses the
 * wire, the page state and a results screen, and a scan could only see the JSX.
 *
 * Also pinned here: in the multi-file layout a file's status is SAID, as the
 * accordion button's description — it was an icon alone, so a collapsed file's
 * warning was invisible to a screen reader (and, collapsed, to everyone).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import type { OverlongRecords } from '@/lib/api'

const api = vi.hoisted(() => ({
  list: vi.fn(),
  preview: vi.fn(),
  import: vi.fn(),
  describeColumns: vi.fn(),
  get: vi.fn(),
  appendPreview: vi.fn(),
  appendImport: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, datasetsApi: { ...actual.datasetsApi, ...api } }
})
vi.mock('@/lib/participant-snapshot', () => ({
  projectHadParticipants: vi.fn().mockResolvedValue(false),
}))
vi.mock('@/layouts/ProjectLayout', () => ({
  useProjectLayout: () => ({ setBreadcrumbLabel: () => {} }),
}))

import DatasetImport from './DatasetImport'
import AppendImport from './AppendImport'

const overlong = (rowId: number | null): OverlongRecords => ({
  count: 1,
  header_width: 3,
  examples: [{ record: 2, line: 3, cells: 4, row_id: rowId }],
})

const column = (i: number, name: string) => ({
  column_name: name, column_index: i, sample_values: ['x'], unique_count: 1,
  empty_count: 0, empty_percent: 0, na_count: 0, all_numeric: false,
  avg_text_length: 1, suggested_type: 'nominal', suggested_scale_name: null,
  suggested_scale_labels: null, suggested_scale_values: null,
  suggested_scale_unmatched: null, distinct_numeric_values: null,
  suggested_column_code: null, suggested_group_code: null,
  suggested_column_text: name, suggested_column_name: null,
  suggested_demographic_subtype: null, numeric_format: null,
  numeric_min: null, numeric_max: null,
})

const preview = (report: OverlongRecords) => ({
  total_rows: 3,
  columns: [column(0, 'pid'), column(1, 'comment'), column(2, 'score')],
  sheet_names: null,
  overlong_records: report,
})

function renderAt(path: string, pattern: string, element: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes><Route path={pattern} element={element} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const csv = (name: string) => new File(['pid,comment,score\n'], name, { type: 'text/csv' })

beforeEach(() => {
  Object.values(api).forEach(fn => fn.mockReset())
  api.list.mockResolvedValue({ datasets: [], total: 0 })
})
afterEach(cleanup)

describe('the dataset import wizard (#985)', () => {
  it('warns on the configure step and links each record on the result', async () => {
    api.preview.mockResolvedValue(preview(overlong(null)))
    api.import.mockResolvedValue({
      dataset_id: 9, columns_created: 3, rows_created: 3, values_created: 9,
      recognized_missing_count: 0, recognized_missing_labels: [],
      participant_link_report: null, overlong_records: overlong(77),
    })
    const { container } = renderAt('/projects/1/datasets/import', '/projects/:projectId/datasets/import', <DatasetImport />)

    fireEvent.change(container.querySelector('#dataset-file-input')!, { target: { files: [csv('survey.csv')] } })
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }))

    const before = await screen.findByRole('note', { name: '' })
    expect(before).toHaveTextContent('1 row in this file has more values than there are column headings.')
    expect(before).toHaveTextContent('Line 3 (record 2) — 4 values for 3 columns')

    const importButton = screen.getByRole('button', { name: 'Import Dataset' })
    await waitFor(() => expect(importButton).toBeEnabled())
    fireEvent.click(importButton)

    const link = await screen.findByRole('link', { name: 'Line 3 (record 2)' })
    expect(link).toHaveAttribute('href', '/projects/1/datasets/9?row=77')
  })

  it('says nothing when the file is well formed', async () => {
    api.preview.mockResolvedValue(preview({ count: 0, header_width: 3, examples: [] }))
    const { container } = renderAt('/projects/1/datasets/import', '/projects/:projectId/datasets/import', <DatasetImport />)
    fireEvent.change(container.querySelector('#dataset-file-input')!, { target: { files: [csv('survey.csv')] } })
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }))
    await screen.findByRole('button', { name: 'Import Dataset' })
    expect(screen.queryByText(/more values than there are column headings/)).toBeNull()
  })

  it('states each file’s status in words when several are imported', async () => {
    api.preview
      .mockResolvedValueOnce(preview({ count: 0, header_width: 3, examples: [] }))
      .mockResolvedValueOnce(preview(overlong(null)))
    const { container } = renderAt('/projects/1/datasets/import', '/projects/:projectId/datasets/import', <DatasetImport />)
    fireEvent.change(container.querySelector('#dataset-file-input')!, {
      target: { files: [csv('first.csv'), csv('second.csv')] },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }))

    // The configure step first — the upload step's "Remove first.csv" also matches.
    await screen.findByRole('button', { name: 'Import 2 Datasets' })
    const first = screen.getByRole('button', { name: /^first\.csv/ })
    const second = screen.getByRole('button', { name: /^second\.csv/ })
    await waitFor(() => expect(first).toHaveAccessibleDescription('Ready to import.'))
    expect(second).toHaveAccessibleDescription(
      'Some rows have more values than there are column headings.',
    )
    // Status is the DESCRIPTION, never folded into the name (#770).
    expect(second).not.toHaveAccessibleName(/rows|ready/i)
    expect(first).toHaveAttribute('aria-expanded', 'true')
    expect(second).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('the append wizard (#985)', () => {
  it('warns on the review step by line and links each appended row', async () => {
    api.get.mockResolvedValue({ id: 5, name: 'Responses' })
    api.appendPreview.mockResolvedValue({
      matched_columns: [{ csv_column_name: 'pid', csv_column_index: 0, column_id: 51, column_code: null, column_text: 'pid', column_type: 'nominal', match_method: 'text' }],
      unmatched_csv_columns: [], unmatched_columns: [], total_rows: 3,
      duplicate_count: 0, in_file_duplicate_count: 0, preview_rows: [],
      next_row_id: 'R004', row_pad_width: 3, sheet_names: null,
      participant_link_column: null, overlong_records: overlong(null),
    })
    api.appendImport.mockResolvedValue({
      rows_created: 3, values_created: 3, duplicates_skipped: 0,
      batch_id: 'b', next_row_id: 'R007', participant_link_report: null,
      unmapped_values: [], overlong_records: overlong(88),
    })
    const { container } = renderAt('/projects/1/datasets/5/append', '/projects/:projectId/datasets/:datasetId/append', <AppendImport />)

    fireEvent.change(container.querySelector('#append-file-input')!, { target: { files: [csv('more.csv')] } })

    const before = await screen.findByRole('note')
    expect(before).toHaveTextContent('Line 3 — 4 values for 3 columns')
    expect(before).not.toHaveTextContent('record 2')
    expect(screen.getByText('3 records in the file')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Append 3 Responses' }))
    const link = await screen.findByRole('link', { name: 'Line 3' })
    expect(link).toHaveAttribute('href', '/projects/1/datasets/5?row=88')
  })
})
